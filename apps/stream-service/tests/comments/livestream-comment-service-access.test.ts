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

describe("LivestreamCommentService.getComments — ban re-check", () => {
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
        checkBan: jest.fn().mockResolvedValue({ isBanned: true }),
      },
    });

    await expect(
      service.getComments("stream-1", { limit: 30 }, "community-banned-user")
    ).rejects.toThrow();
  });

  it("allows a non-banned viewer", async () => {
    const { service } = makeDeps();

    await expect(
      service.getComments("stream-1", { limit: 30 }, "viewer-1")
    ).resolves.toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it("skips the ban check entirely when no userId is given (gRPC path parity)", async () => {
    const { service, banRepo, communityClient } = makeDeps({
      banRepo: { isBanned: jest.fn().mockResolvedValue(true) },
      communityClient: {
        checkBan: jest.fn().mockResolvedValue({ isBanned: true }),
      },
    });

    await expect(
      service.getComments("stream-1", { limit: 30 })
    ).resolves.toEqual({ items: [], nextCursor: null, hasMore: false });
    expect(banRepo.isBanned).not.toHaveBeenCalled();
    expect(communityClient.checkBan).not.toHaveBeenCalled();
  });
});
