/**
 * Suite: LivestreamCommentService access-gate regressions
 *
 * Covers two write/read-path holes closed alongside the reconnect-grace work:
 *  - addComment() now re-checks community membership (STREAM_REQUIRE_MEMBERSHIP)
 *    at the write path, not just at the stream:join gate — mirrors
 *    LivestreamService.checkAccess's exact fail-open/owner-bypass semantics.
 *  - getComments() now re-checks local + community-wide bans when a userId is
 *    given (the REST route always passes one) — closing the gap where a banned
 *    viewer could read chat history via `GET /streams/:id/comments` directly.
 *    The gRPC path (api-gateway's stream:join/stream:load_more) omits userId
 *    and is unaffected — a banned user is already rejected earlier at
 *    stream:join's CheckStreamAccess.
 *
 * All dependencies are hand-rolled fakes injected via the constructor — no
 * jest.mock() module interception needed (matches the viewer-session suite).
 */
import { LivestreamCommentService } from "../../src/services/livestream-comment.service.js";

function makeStream(overrides: Record<string, unknown> = {}) {
  return {
    id: "stream-1",
    communityId: "comm-1",
    creatorId: "creator-1",
    title: "t",
    description: "",
    thumbnail: null,
    sourceType: "PHONE_CAMERA",
    sourceUrl: null,
    streamKey: "key-1",
    status: "LIVE",
    hlsUrl: null,
    flvUrl: null,
    dashUrl: null,
    commentStatus: true,
    viewerCount: 0,
    peakViewers: 0,
    totalViews: 0,
    totalComments: 0,
    livedAt: new Date(),
    endedAt: null,
    lastHeartbeatAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const commentRepo = {
    findByClientCommentId: jest.fn().mockResolvedValue(null),
    createComment: jest
      .fn()
      .mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve({
          id: "comment-1",
          livestreamId: data.livestreamId,
          sentBy: data.sentBy,
          senderName: data.senderName ?? "",
          senderAvatar: data.senderAvatar ?? "",
          message: data.message,
          clientCommentId: data.clientCommentId ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
      ),
    findByLivestreamId: jest.fn().mockResolvedValue([]),
    ...(overrides.commentRepo as object),
  };
  const streamRepo = {
    findById: jest.fn().mockResolvedValue(makeStream()),
    incrementTotalComments: jest.fn().mockResolvedValue(undefined),
    ...(overrides.streamRepo as object),
  };
  const userClient = {
    bulkGetUserSnapshots: jest.fn().mockResolvedValue([]),
    ...(overrides.userClient as object),
  };
  const redis = {
    publish: jest.fn().mockResolvedValue(undefined),
    ...(overrides.redis as object),
  };
  const banRepo = {
    isBanned: jest.fn().mockResolvedValue(false),
    ...(overrides.banRepo as object),
  };
  const communityClient = {
    checkMute: jest.fn().mockResolvedValue({ isMuted: false }),
    checkBan: jest.fn().mockResolvedValue({ isBanned: false }),
    // Read by getComments — same underlying RPC as checkBan, with membership
    // and community visibility read off the reply too.
    checkCommunityAccess: jest.fn().mockResolvedValue({
      isMember: true,
      isBanned: false,
      isPublicCommunity: true,
    }),
    validateMembership: jest.fn().mockResolvedValue({
      isMember: true,
      isCommunityClosed: false,
    }),
    ...(overrides.communityClient as object),
  };
  const reportRepo = {} as any;

  const service = new LivestreamCommentService(
    commentRepo as any,
    streamRepo as any,
    userClient as any,
    redis as any,
    banRepo as any,
    communityClient as any,
    reportRepo
  );

  return { service, commentRepo, streamRepo, banRepo, communityClient };
}

describe("LivestreamCommentService.addComment — membership re-check", () => {
  it("rejects a non-member's comment when STREAM_REQUIRE_MEMBERSHIP is on (env default)", async () => {
    const { service, communityClient } = makeDeps({
      communityClient: {
        validateMembership: jest
          .fn()
          .mockResolvedValue({ isMember: false, isCommunityClosed: false }),
      },
    });

    await expect(
      service.addComment({
        livestreamId: "stream-1",
        userId: "not-a-member",
        message: "hi",
      })
    ).rejects.toThrow();
    expect(communityClient.validateMembership).toHaveBeenCalledWith(
      "comm-1",
      "not-a-member"
    );
  });

  it("allows an active member's comment", async () => {
    const { service } = makeDeps({
      communityClient: {
        validateMembership: jest
          .fn()
          .mockResolvedValue({ isMember: true, isCommunityClosed: false }),
      },
    });

    await expect(
      service.addComment({
        livestreamId: "stream-1",
        userId: "member-1",
        message: "hi",
      })
    ).resolves.toMatchObject({ sentBy: "member-1" });
  });

  it("never runs the membership check for the stream owner (bypasses even a false isMember)", async () => {
    const { service, communityClient } = makeDeps({
      communityClient: {
        validateMembership: jest
          .fn()
          .mockResolvedValue({ isMember: false, isCommunityClosed: false }),
      },
    });

    await expect(
      service.addComment({
        livestreamId: "stream-1",
        userId: "creator-1", // matches makeStream()'s creatorId
        message: "hi",
      })
    ).resolves.toMatchObject({ sentBy: "creator-1" });
    expect(communityClient.validateMembership).not.toHaveBeenCalled();
  });

  it("rejects when the community is closed, even for an otherwise-active member", async () => {
    const { service } = makeDeps({
      communityClient: {
        validateMembership: jest
          .fn()
          .mockResolvedValue({ isMember: true, isCommunityClosed: true }),
      },
    });

    await expect(
      service.addComment({
        livestreamId: "stream-1",
        userId: "member-1",
        message: "hi",
      })
    ).rejects.toThrow();
  });

  it("fails open on a community-service outage — comment still succeeds", async () => {
    const { service } = makeDeps({
      communityClient: {
        validateMembership: jest.fn().mockRejectedValue(new Error("down")),
      },
    });

    await expect(
      service.addComment({
        livestreamId: "stream-1",
        userId: "member-1",
        message: "hi",
      })
    ).resolves.toMatchObject({ sentBy: "member-1" });
  });
});

describe("LivestreamCommentService.addComment — the stream must exist", () => {
  it("rejects a comment for a livestreamId with no row, and writes nothing", async () => {
    // Every gate used to read `if (stream && …)`, so a missing stream skipped
    // the ban, community-ban, commentStatus, mute AND membership checks — and
    // the row was still inserted, under an id nothing will ever read back.
    const { service, commentRepo } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(null) },
    });

    await expect(
      service.addComment({
        livestreamId: "does-not-exist",
        userId: "user-1",
        message: "hi",
      })
    ).rejects.toThrow();
    expect(commentRepo.createComment).not.toHaveBeenCalled();
  });

  it("does not consult any gate once the stream is missing", async () => {
    // The point is that it stops, not that it happens to deny.
    const { service, banRepo, communityClient } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(null) },
    });

    await expect(
      service.addComment({
        livestreamId: "does-not-exist",
        userId: "user-1",
        message: "hi",
      })
    ).rejects.toThrow();
    expect(banRepo.isBanned).not.toHaveBeenCalled();
    expect(communityClient.checkMute).not.toHaveBeenCalled();
  });

  it("still writes normally when the stream exists", async () => {
    const { service, commentRepo } = makeDeps();

    await service.addComment({
      livestreamId: "stream-1",
      userId: "user-1",
      message: "hi",
    });

    expect(commentRepo.createComment).toHaveBeenCalled();
  });
});

describe("LivestreamCommentService.deleteComment — stream scoping", () => {
  const comment = {
    id: "comment-1",
    livestreamId: "stream-1",
    sentBy: "author-1",
    senderName: "a",
    senderAvatar: "",
    message: "m",
    clientCommentId: null,
    createdAt: new Date(),
  };

  function deleteDeps(over: Record<string, unknown> = {}) {
    return makeDeps({
      commentRepo: {
        // Id-aware, so an unknown id genuinely misses. A blanket
        // `mockResolvedValue(comment)` would make the "leaks nothing" case
        // below compare two identical hits and pass for the wrong reason.
        findById: jest.fn((id: string) =>
          Promise.resolve(id === comment.id ? comment : null)
        ),
        deleteById: jest.fn().mockResolvedValue(undefined),
        ...(over.commentRepo as object),
      },
      ...over,
    });
  }

  it("refuses a commentId that belongs to a different stream", async () => {
    // The oracle this closes: the gateway checked room membership and then
    // dropped the streamId, so probing arbitrary comment ids from inside a
    // stream you CAN see revealed whether a comment existed and — via the
    // success ack — which stream it lived in, across communities you cannot.
    const { service, commentRepo } = deleteDeps();

    await expect(
      service.deleteComment("comment-1", "author-1", "some-other-stream")
    ).rejects.toThrow();
    expect(commentRepo.deleteById).not.toHaveBeenCalled();
  });

  it("deletes when the stream matches", async () => {
    const { service, commentRepo } = deleteDeps();

    await expect(
      service.deleteComment("comment-1", "author-1", "stream-1")
    ).resolves.toEqual({ commentId: "comment-1", livestreamId: "stream-1" });
    expect(commentRepo.deleteById).toHaveBeenCalledWith("comment-1");
  });

  it("skips the check when no livestreamId is supplied (wire compatibility)", async () => {
    // Optional on the wire so a gateway and a stream-service at different
    // versions do not break each other mid-rollout.
    const { service, commentRepo } = deleteDeps();

    await expect(
      service.deleteComment("comment-1", "author-1")
    ).resolves.toMatchObject({ commentId: "comment-1" });
    expect(commentRepo.deleteById).toHaveBeenCalled();
  });

  it("reports a mismatch as COMMENT_NOT_FOUND, leaking nothing", async () => {
    // Same key an genuinely-absent comment returns, so the reply cannot be used
    // to distinguish "wrong stream" from "no such comment".
    const { service } = deleteDeps();

    const missing = await service
      .deleteComment("nope", "author-1", "stream-1")
      .catch((e: Error) => String(e));
    const mismatch = await service
      .deleteComment("comment-1", "author-1", "other")
      .catch((e: Error) => String(e));

    expect(mismatch).toBe(missing);
  });
});

describe("LivestreamCommentService.getComments — ban + membership re-check", () => {
  const ok = (over: Record<string, unknown> = {}) => ({
    isMember: true,
    isBanned: false,
    isPublicCommunity: true,
    ...over,
  });

  it("rejects a locally-banned viewer", async () => {
    const { service } = makeDeps({
      banRepo: { isBanned: jest.fn().mockResolvedValue(true) },
    });

    await expect(
      service.getComments("stream-1", { limit: 30 }, "banned-user")
    ).rejects.toThrow();
  });

  it("rejects a community-banned viewer (local ban absent)", async () => {
    const { service } = makeDeps({
      communityClient: {
        checkCommunityAccess: jest.fn().mockResolvedValue(ok({ isBanned: true })),
      },
    });

    await expect(
      service.getComments("stream-1", { limit: 30 }, "community-banned-user")
    ).rejects.toThrow();
  });

  it("rejects a non-member of a PRIVATE community", async () => {
    // The hole this closes: chat history was gated on bans alone, so anyone
    // holding a streamId could page out a private community's whole
    // conversation — author usernames and avatars included — without joining
    // the stream or being a member of the community.
    const { service } = makeDeps({
      communityClient: {
        checkCommunityAccess: jest
          .fn()
          .mockResolvedValue(ok({ isMember: false, isPublicCommunity: false })),
      },
    });

    await expect(
      service.getComments("stream-1", { limit: 30 }, "outsider")
    ).rejects.toThrow();
  });

  it("still allows a non-member of a PUBLIC community", async () => {
    // Non-members watching and reading a public community's stream is the
    // deliberate product behaviour; the gate above must not have broken it.
    const { service } = makeDeps({
      communityClient: {
        checkCommunityAccess: jest
          .fn()
          .mockResolvedValue(ok({ isMember: false, isPublicCommunity: true })),
      },
    });

    await expect(
      service.getComments("stream-1", { limit: 30 }, "lurker")
    ).resolves.toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it("allows the stream owner without a community round trip", async () => {
    const { service, communityClient } = makeDeps();

    await expect(
      service.getComments("stream-1", { limit: 30 }, "creator-1")
    ).resolves.toEqual({ items: [], nextCursor: null, hasMore: false });
    expect(communityClient.checkCommunityAccess).not.toHaveBeenCalled();
  });

  it("allows a non-banned member", async () => {
    const { service } = makeDeps();

    await expect(
      service.getComments("stream-1", { limit: 30 }, "viewer-1")
    ).resolves.toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it("fails OPEN when community-service is unreachable", async () => {
    // Deliberate, and pinned here so a later refactor cannot quietly flip it:
    // a community-service outage must not black out chat history for everyone.
    // The local per-stream ban above stays the always-available hard gate.
    const { service } = makeDeps({
      communityClient: {
        checkCommunityAccess: jest
          .fn()
          .mockRejectedValue(new Error("circuit open")),
      },
    });

    await expect(
      service.getComments("stream-1", { limit: 30 }, "viewer-1")
    ).resolves.toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it("skips every check when no userId is given (gRPC path parity)", async () => {
    const { service, banRepo, communityClient } = makeDeps({
      banRepo: { isBanned: jest.fn().mockResolvedValue(true) },
      communityClient: {
        checkCommunityAccess: jest.fn().mockResolvedValue(ok({ isBanned: true })),
      },
    });

    await expect(
      service.getComments("stream-1", { limit: 30 })
    ).resolves.toEqual({ items: [], nextCursor: null, hasMore: false });
    expect(banRepo.isBanned).not.toHaveBeenCalled();
    expect(communityClient.checkCommunityAccess).not.toHaveBeenCalled();
  });
});
