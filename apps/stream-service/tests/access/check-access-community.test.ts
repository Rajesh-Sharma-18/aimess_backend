/**
 * Suite: community membership + visibility on the single-stream read paths.
 *
 * `listStreams` has always gated a PRIVATE community's rows behind membership —
 * every row it returns carries a directly-playable hlsUrl/flvUrl, so the listing
 * hands out media access rather than metadata. The two paths that read ONE
 * stream did not: `checkAccess` (the `stream:join` gate) treated viewing as
 * always-allowed and used membership only to decide `canComment`, and
 * `getStream` (`GET /streams/:id`) checked the per-stream ban and nothing else.
 * Either one handed a private community's playback URLs to any authenticated
 * caller who had the streamId.
 *
 * Both now run the same `checkCommunityAccess` gate the listing uses. It is the
 * SAME underlying RPC (`checkCommunityMembership`) that the community-ban check
 * already called, so `checkAccess` pays nothing extra for it.
 *
 * The fail-open cases are pinned deliberately: unlike `listStreams`, which fails
 * closed, these gate one stream the caller already names, and a community-service
 * blip must not black out live viewing. A later refactor that flips this should
 * have to delete a test that says so.
 *
 * Hand-rolled fakes injected via the constructor, matching the sibling suites.
 */
import { LivestreamService } from "../../src/services/livestream.service.js";

const STREAM_ID = "a".repeat(24);

function makeStream(overrides: Record<string, unknown> = {}) {
  return {
    id: STREAM_ID,
    communityId: "comm-1",
    creatorId: "creator-1",
    title: "t",
    description: "",
    thumbnail: null,
    sourceType: "PHONE_CAMERA",
    sourceUrl: null,
    streamKey: "key-1",
    playbackId: "public-1",
    status: "LIVE",
    commentStatus: true,
    hlsUrl: "http://srs/live/public-1.m3u8",
    flvUrl: "http://srs/live/public-1.flv",
    dashUrl: null,
    viewerCount: 0,
    peakViewers: 0,
    totalViews: 0,
    totalComments: 0,
    videoLostAt: null,
    livedAt: new Date(),
    endedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** `checkCommunityAccess`'s reply shape — member of a public community by default. */
const access = (over: Record<string, unknown> = {}) => ({
  isMember: true,
  isBanned: false,
  isPublicCommunity: true,
  ...over,
});

function makeService(overrides: Record<string, unknown> = {}) {
  const streamRepo = {
    findById: jest.fn().mockResolvedValue(makeStream()),
    incrementTotalViews: jest.fn().mockResolvedValue(undefined),
    ...(overrides.streamRepo as object),
  };
  const banRepo = {
    isBanned: jest.fn().mockResolvedValue(false),
    ...(overrides.banRepo as object),
  };
  const communityClient = {
    checkCommunityAccess: jest.fn().mockResolvedValue(access()),
    checkMute: jest.fn().mockResolvedValue({ isMuted: false }),
    validateMembership: jest
      .fn()
      .mockResolvedValue({ isMember: true, isCommunityClosed: false }),
    ...(overrides.communityClient as object),
  };
  const redis = {
    // isSystemBanned reads through this; `null` = not banned.
    get: jest.fn().mockResolvedValue(null),
    hlen: jest.fn().mockResolvedValue(0),
    publish: jest.fn().mockResolvedValue(0),
    ...(overrides.redis as object),
  };

  const service = new LivestreamService(
    streamRepo as never,
    {} as never,
    communityClient as never,
    redis as never,
    banRepo as never,
    {} as never,
    jest.fn(),
    { bulkGetUserSnapshots: jest.fn().mockResolvedValue([]) } as never
  );

  return { service, streamRepo, banRepo, communityClient };
}

describe("checkAccess — community visibility gate", () => {
  it("allows a non-member into a PUBLIC community's stream", async () => {
    const { service } = makeService({
      communityClient: {
        checkCommunityAccess: jest
          .fn()
          .mockResolvedValue(access({ isMember: false })),
      },
    });

    const result = await service.checkAccess(STREAM_ID, "lurker");

    expect(result.allowed).toBe(true);
    expect(result.hlsUrl).toBe("http://srs/live/public-1.m3u8");
  });

  it("DENIES a non-member of a PRIVATE community", async () => {
    // The finding: `allowed` was unconditionally true for a non-banned caller,
    // and the reply carries the playback URLs, so a streamId was enough to
    // watch a private community's broadcast.
    const { service } = makeService({
      communityClient: {
        checkCommunityAccess: jest
          .fn()
          .mockResolvedValue(access({ isMember: false, isPublicCommunity: false })),
      },
    });

    const result = await service.checkAccess(STREAM_ID, "outsider");

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("NOT_MEMBER");
    // Nothing playable leaks on the deny path.
    expect(result.hlsUrl).toBeNull();
    expect(result.flvUrl).toBeNull();
    expect(result.title).toBe("");
  });

  it("allows a member of a PRIVATE community", async () => {
    const { service } = makeService({
      communityClient: {
        checkCommunityAccess: jest
          .fn()
          .mockResolvedValue(access({ isPublicCommunity: false })),
      },
    });

    await expect(
      service.checkAccess(STREAM_ID, "member-1")
    ).resolves.toMatchObject({ allowed: true });
  });

  it("lets the owner into their own PRIVATE community stream", async () => {
    // A creator whose membership lapsed keeps their own broadcast, matching the
    // owner short-circuit further down checkAccess.
    const { service } = makeService({
      communityClient: {
        checkCommunityAccess: jest
          .fn()
          .mockResolvedValue(access({ isMember: false, isPublicCommunity: false })),
      },
    });

    await expect(
      service.checkAccess(STREAM_ID, "creator-1")
    ).resolves.toMatchObject({ allowed: true, status: "OWNER" });
  });

  it("still denies a community-banned user", async () => {
    const { service } = makeService({
      communityClient: {
        checkCommunityAccess: jest
          .fn()
          .mockResolvedValue(access({ isBanned: true })),
      },
    });

    const result = await service.checkAccess(STREAM_ID, "banned-user");

    expect(result.allowed).toBe(false);
    expect(result.isBanned).toBe(true);
    expect(result.reason).toBe("BANNED");
  });

  it("fails OPEN when community-service is unreachable", async () => {
    const { service } = makeService({
      communityClient: {
        checkCommunityAccess: jest
          .fn()
          .mockRejectedValue(new Error("circuit open")),
      },
    });

    await expect(
      service.checkAccess(STREAM_ID, "viewer-1")
    ).resolves.toMatchObject({ allowed: true });
  });

  it("reads membership and the ban in ONE community round trip", async () => {
    // checkCommunityAccess replaced a checkBan call over the same RPC; if a
    // future edit reintroduces a second call the join gate silently doubles in
    // latency for every viewer.
    const { service, communityClient } = makeService();

    await service.checkAccess(STREAM_ID, "viewer-1");

    expect(communityClient.checkCommunityAccess).toHaveBeenCalledTimes(1);
  });
});

describe("getStream — community visibility gate", () => {
  it("DENIES a non-member of a PRIVATE community", async () => {
    const { service } = makeService({
      communityClient: {
        checkCommunityAccess: jest
          .fn()
          .mockResolvedValue(access({ isMember: false, isPublicCommunity: false })),
      },
    });

    await expect(service.getStream(STREAM_ID, "outsider")).rejects.toThrow();
  });

  it("allows a non-member of a PUBLIC community", async () => {
    const { service } = makeService({
      communityClient: {
        checkCommunityAccess: jest
          .fn()
          .mockResolvedValue(access({ isMember: false })),
      },
    });

    await expect(service.getStream(STREAM_ID, "lurker")).resolves.toMatchObject(
      { id: STREAM_ID }
    );
  });

  it("DENIES a community-banned user", async () => {
    const { service } = makeService({
      communityClient: {
        checkCommunityAccess: jest
          .fn()
          .mockResolvedValue(access({ isBanned: true })),
      },
    });

    await expect(service.getStream(STREAM_ID, "banned-user")).rejects.toThrow();
  });

  it("skips the community check for the owner", async () => {
    const { service, communityClient } = makeService();

    await expect(
      service.getStream(STREAM_ID, "creator-1")
    ).resolves.toMatchObject({ id: STREAM_ID });
    expect(communityClient.checkCommunityAccess).not.toHaveBeenCalled();
  });

  it("skips the community check when no userId is given (internal callers)", async () => {
    const { service, communityClient } = makeService();

    await expect(service.getStream(STREAM_ID)).resolves.toMatchObject({
      id: STREAM_ID,
    });
    expect(communityClient.checkCommunityAccess).not.toHaveBeenCalled();
  });

  it("fails OPEN when community-service is unreachable", async () => {
    const { service } = makeService({
      communityClient: {
        checkCommunityAccess: jest
          .fn()
          .mockRejectedValue(new Error("circuit open")),
      },
    });

    await expect(service.getStream(STREAM_ID, "viewer-1")).resolves.toMatchObject(
      { id: STREAM_ID }
    );
  });
});
