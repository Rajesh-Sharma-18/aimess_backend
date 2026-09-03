/**
 * AIM-33 — `GET /api/v1/streams` must be scoped to the caller.
 *
 * The controller passed only the parsed query and never `req.auth`, and
 * `communityId` was optional — so one call with no filter enumerated every
 * community's livestreams, and each row is mapped through `toView`, which
 * carries directly playable `hlsUrl` / `flvUrl` / `sourceUrl`. Neither the
 * per-stream ban check that `getStream` performs nor the community ban check
 * that `checkAccess` performs ran on this path, so a banned user still received
 * the playback URLs and a private community's streams were listable by anyone
 * with an account.
 *
 * The trusted internal gRPC caller keeps its unfiltered view, but through a
 * SEPARATE method (`listStreamsInternal`) rather than by omitting `requesterId`
 * on the gated one — so a controller that forgets to pass the caller's identity
 * is a type error, not a silently reopened hole.
 *
 * The community lookup is fail-CLOSED here, unlike `checkAccess`: every row
 * carries a playable hlsUrl, so on a community-service outage the right answer
 * is "no list", not "everyone's list".
 */
import { LivestreamService } from "../../src/services/livestream.service.js";

const COMMUNITY = "c".repeat(24);
const VIEWER = "11111111-1111-4111-8111-111111111111";

function makeStream(id: string) {
  return {
    id,
    communityId: COMMUNITY,
    creatorId: "host-1",
    title: "Stream",
    description: null,
    status: "LIVE",
    streamKey: `key-${id}`,
    sourceType: "PHONE_CAMERA",
    sourceUrl: null,
    thumbnail: null,
    hlsUrl: `https://media.example/live/key-${id}.m3u8`,
    flvUrl: null,
    dashUrl: null,
    viewerCount: 0,
    startedAt: new Date("2026-09-02T00:00:00.000Z"),
    endedAt: null,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
  };
}

function makeService(
  overrides: {
    rows?: ReturnType<typeof makeStream>[];
    membership?: Record<string, unknown>;
    membershipError?: Error;
    bannedIds?: Set<string>;
  } = {}
) {
  const streamRepo = {
    listByCommunity: jest.fn().mockResolvedValue(overrides.rows ?? []),
  };
  const checkCommunityAccess = overrides.membershipError
    ? jest.fn().mockRejectedValue(overrides.membershipError)
    : jest.fn().mockResolvedValue(
        overrides.membership ?? {
          isBanned: false,
          isMember: true,
          isPublicCommunity: false,
        }
      );
  const communityClient = {
    checkCommunityAccess,
    validateMembership: jest.fn(),
  };
  const banRepo = {
    bannedStreamIds: jest
      .fn()
      .mockResolvedValue(overrides.bannedIds ?? new Set<string>()),
  };

  const service = new LivestreamService(
    streamRepo as never,
    { buildPlaybackUrls: jest.fn().mockReturnValue({}) } as never,
    communityClient as never,
    { get: jest.fn().mockResolvedValue(null) } as never,
    banRepo as never,
    {} as never,
    jest.fn(),
    { bulkGetUserSnapshots: jest.fn().mockResolvedValue([]) } as never
  );

  return { service, streamRepo, checkCommunityAccess, banRepo };
}

describe("listStreams — user-facing access control", () => {
  it("refuses a cross-community listing, which was the enumeration oracle", async () => {
    const { service, streamRepo } = makeService();

    await expect(
      service.listStreams({ limit: 20, requesterId: VIEWER })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(streamRepo.listByCommunity).not.toHaveBeenCalled();
  });

  it("refuses a caller banned from the community", async () => {
    const { service, streamRepo } = makeService({
      membership: { isBanned: true, isMember: false, isPublicCommunity: true },
    });

    await expect(
      service.listStreams({
        communityId: COMMUNITY,
        limit: 20,
        requesterId: VIEWER,
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(streamRepo.listByCommunity).not.toHaveBeenCalled();
  });

  it("refuses a non-member of a PRIVATE community", async () => {
    const { service } = makeService({
      membership: {
        isBanned: false,
        isMember: false,
        isPublicCommunity: false,
      },
    });

    await expect(
      service.listStreams({
        communityId: COMMUNITY,
        limit: 20,
        requesterId: VIEWER,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("allows a non-member of a PUBLIC community (viewing is open by design)", async () => {
    const { service } = makeService({
      rows: [makeStream("s1")],
      membership: { isBanned: false, isMember: false, isPublicCommunity: true },
    });

    const result = await service.listStreams({
      communityId: COMMUNITY,
      limit: 20,
      requesterId: VIEWER,
    });

    expect(result.items.map((i) => i.id)).toEqual(["s1"]);
  });

  it("drops streams the caller is individually banned from", async () => {
    const { service } = makeService({
      rows: [makeStream("s1"), makeStream("s2")],
      bannedIds: new Set(["s1"]),
    });

    const result = await service.listStreams({
      communityId: COMMUNITY,
      limit: 20,
      requesterId: VIEWER,
    });

    expect(result.items.map((i) => i.id)).toEqual(["s2"]);
  });

  it("refuses the listing when the membership RPC fails (fail-closed)", async () => {
    // Unlike `checkAccess`, which stays fail-open so an outage cannot black out
    // a stream someone is already WATCHING, this path hands out playback URLs
    // for streams the caller has not been cleared for yet. Fail-open here
    // publishes private communities' hlsUrls during any community-service blip.
    const { service, streamRepo } = makeService({
      rows: [makeStream("s1")],
      membershipError: new Error("community-service unavailable"),
    });

    await expect(
      service.listStreams({
        communityId: COMMUNITY,
        limit: 20,
        requesterId: VIEWER,
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(streamRepo.listByCommunity).not.toHaveBeenCalled();
  });

  it("leaves the internal gRPC caller unfiltered", async () => {
    // The trusted caller needs the whole view, including cross-community, and
    // must not pay for a membership lookup. It reaches it through the separate
    // ungated method, never by omitting an argument on the gated one.
    const { service, checkCommunityAccess, banRepo } = makeService({
      rows: [makeStream("s1")],
    });

    const result = await service.listStreamsInternal({ limit: 20 });

    expect(result.items.map((i) => i.id)).toEqual(["s1"]);
    expect(checkCommunityAccess).not.toHaveBeenCalled();
    expect(banRepo.bannedStreamIds).not.toHaveBeenCalled();
  });
});
