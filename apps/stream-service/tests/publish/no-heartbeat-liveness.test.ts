/**
 * The sweeper never ends a LIVE stream. YOUTUBE/URL embeds end only on an
 * explicit stop or force-end; SRS-ingested streams leave LIVE only through
 * on_unpublish, and are ended once their reconnect grace runs out.
 */
import { LivestreamService } from "../../src/services/livestream.service.js";

type Row = Record<string, unknown>;

function makeService(rows: Row[], publishers: unknown[]) {
  // Queries honour status + cutoff like the real ones, so a LIVE row can only
  // be ended if the service itself goes looking for it.
  const streamRepo = {
    findStaleReconnectingStreams: jest.fn(async (cutoff: Date) =>
      rows.filter(
        (r) =>
          r.status === "RECONNECTING" && (r.disconnectedAt as Date) < cutoff
      )
    ),
    findStalePendingStreams: jest.fn(async () =>
      rows.filter((r) => r.status === "PENDING")
    ),
    findBySrsNames: jest.fn(async (names: string[]) =>
      rows.filter((r) => names.includes(r.playbackId as string))
    ),
    findLiveBySourceType: jest.fn().mockResolvedValue([]),
    countLiveByCommunity: jest.fn().mockResolvedValue(0),
    claimEnded: jest.fn().mockResolvedValue(true),
    updateById: jest.fn(async (id: string, data: Row) => ({
      ...rows.find((r) => r.id === id),
      ...data,
    })),
  };
  const srsService = {
    listPublishers: jest.fn().mockResolvedValue(publishers),
    kickStream: jest.fn().mockResolvedValue(undefined),
    kickClientById: jest.fn().mockResolvedValue(true),
    buildPlaybackUrls: jest
      .fn()
      .mockReturnValue({ hlsUrl: "", flvUrl: "", dashUrl: "" }),
    hasFrames: jest.fn().mockResolvedValue(true),
  };
  const service = new LivestreamService(
    streamRepo as never,
    srsService as never,
    { validateMembership: jest.fn() } as never,
    {
      get: jest.fn().mockResolvedValue(null),
      hlen: jest.fn().mockResolvedValue(0),
      publish: jest.fn().mockResolvedValue(0),
    } as never,
    {} as never,
    { closeAllOpenForStream: jest.fn().mockResolvedValue(0) } as never,
    jest.fn(),
    { bulkGetUserSnapshots: jest.fn().mockResolvedValue([]) } as never
  );
  return { service, streamRepo, srsService };
}

const hoursAgo = new Date(Date.now() - 3 * 3_600_000);

function stream(overrides: Row): Row {
  return {
    communityId: "comm-1",
    creatorId: "creator-1",
    title: "t",
    streamKey: "secret",
    status: "LIVE",
    livedAt: hoursAgo,
    lastHeartbeatAt: hoursAgo,
    ...overrides,
  };
}

describe("sweepStaleStreams without heartbeat liveness", () => {
  it("never ends a LIVE stream, embed or SRS-ingested", async () => {
    const youtube = stream({
      id: "yt",
      playbackId: "yt-public",
      sourceType: "YOUTUBE",
      sourceUrl: "https://youtube.com/watch?v=x",
    });
    const camera = stream({
      id: "cam",
      playbackId: "cam-public",
      sourceType: "PHONE_CAMERA",
    });
    const { service, streamRepo, srsService } = makeService(
      [youtube, camera],
      [{ apiBase: "http://srs", streamKey: "cam-public", clientId: "c1" }]
    );

    await service.sweepStaleStreams();

    expect(streamRepo.updateById).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "ENDED" })
    );
    expect(srsService.kickStream).not.toHaveBeenCalled();
    expect(srsService.kickClientById).not.toHaveBeenCalled();
  });

  it("ends a RECONNECTING camera stream once its grace window has passed", async () => {
    const camera = stream({
      id: "cam",
      playbackId: "cam-public",
      sourceType: "PHONE_CAMERA",
      status: "RECONNECTING",
      disconnectedAt: hoursAgo,
    });
    const { service, streamRepo } = makeService([camera], []);

    await service.sweepStaleStreams();

    expect(streamRepo.updateById).toHaveBeenCalledWith(
      "cam",
      expect.objectContaining({ status: "ENDED" })
    );
  });
});
