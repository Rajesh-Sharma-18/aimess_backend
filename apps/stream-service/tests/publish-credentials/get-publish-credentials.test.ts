/**
 * LivestreamService.getPublishCredentials — owner-only re-fetch of the
 * streamKey/WHIP credentials minted at creation, so a PHONE_CAMERA
 * broadcaster can resume publishing after a page reload without creating a
 * new stream. Previously the frontend called this endpoint and got a 404 —
 * no route/service/controller existed for it at all.
 */
import { LivestreamService } from "../../src/services/livestream.service.js";

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const streamRepo = {
    findById: jest.fn(),
    ...(overrides.streamRepo as object),
  };
  const srsService = {
    buildIngestEndpoints: jest.fn().mockReturnValue({
      whipUrl: "http://srs.example.com/rtc/v1/whip/?app=live&stream=key-1",
      rtmpUrl: null,
    }),
    ...(overrides.srsService as object),
  };
  const communityClient = { validateMembership: jest.fn() };
  // `get` backs the system-ban gate, which is fail-CLOSED — a redis stub
  // without it would deny every call here.
  const redis = { get: jest.fn().mockResolvedValue(null) };
  const banRepo = {} as any;
  const viewerSessionRepo = {};
  const eventPublisher = jest.fn();

  const service = new LivestreamService(
    streamRepo as any,
    srsService as any,
    communityClient as any,
    redis as any,
    banRepo,
    viewerSessionRepo as any,
    eventPublisher,
    { bulkGetUserSnapshots: jest.fn().mockResolvedValue([]) } as any
  );

  return { service, streamRepo, srsService };
}

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

describe("LivestreamService.getPublishCredentials", () => {
  it("returns the stored streamKey + re-derived ingest endpoints for the owner", async () => {
    const stream = makeStream();
    const { service, srsService } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(stream) },
    });

    const result = await service.getPublishCredentials("stream-1", "creator-1");

    expect(result.streamKey).toBe("key-1");
    // Two arguments now: the PUBLIC name the stream is published under, and
    // the secret that authorises publishing it. This fixture predates the
    // split (no playbackId), so it is still published under its own key — the
    // legacy shape that must keep working.
    expect(srsService.buildIngestEndpoints).toHaveBeenCalledWith(
      "key-1",
      "key-1"
    );
    expect(result.ingest.whipUrl).toContain("key-1");
  });

  it("404s when the stream does not exist", async () => {
    const { service } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(null) },
    });

    await expect(
      service.getPublishCredentials("missing", "creator-1")
    ).rejects.toMatchObject({ message: "STREAM_NOT_FOUND" });
  });

  it("403s for a non-owner (IDOR-safe)", async () => {
    const stream = makeStream();
    const { service } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(stream) },
    });

    await expect(
      service.getPublishCredentials("stream-1", "someone-else")
    ).rejects.toMatchObject({ message: "STREAM_NOT_OWNER" });
  });

  it("400s for a non-PHONE_CAMERA source (no publish credentials to re-fetch)", async () => {
    const stream = makeStream({ sourceType: "OBS_RTMP" });
    const { service } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(stream) },
    });

    await expect(
      service.getPublishCredentials("stream-1", "creator-1")
    ).rejects.toMatchObject({ message: "STREAM_NOT_PHONE_CAMERA_SOURCE" });
  });

  it("400s once the stream has ENDED", async () => {
    const stream = makeStream({ status: "ENDED" });
    const { service } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(stream) },
    });

    await expect(
      service.getPublishCredentials("stream-1", "creator-1")
    ).rejects.toMatchObject({ message: "STREAM_ALREADY_ENDED" });
  });
});
