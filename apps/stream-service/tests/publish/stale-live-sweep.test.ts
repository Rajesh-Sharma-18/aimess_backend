/**
 * A livestream must not outlive its host's session.
 *
 * A URL/YOUTUBE broadcast is a remote embed: SRS never ingests it, so there is
 * no publisher to drop and no on_unpublish to fire. Its only liveness signal is
 * the owner's authenticated `POST /streams/:id/heartbeat`, which stops the
 * moment they log out or their session expires. `sweepStaleLiveStreams` is
 * therefore the ONLY thing that can end such a stream — and it was blanket-
 * skipping every sweep whenever the SRS publisher scan was stale, so one flaky
 * SRS instance meant an embed stayed LIVE forever with viewers still watching
 * it, hosted by an account that had been signed out and could no longer stop
 * it.
 *
 * The skip is SRS-shaped and now only covers SRS-ingested sources.
 */
import { LivestreamService } from "../../src/services/livestream.service.js";

function makeService(stale: Record<string, unknown>[]) {
  const streamRepo = {
    findStaleLiveStreams: jest.fn().mockResolvedValue(stale),
    findStaleReconnectingStreams: jest.fn().mockResolvedValue([]),
    findStalePendingStreams: jest.fn().mockResolvedValue([]),
    findBySrsNames: jest.fn().mockResolvedValue([]),
    findLiveBySourceType: jest.fn().mockResolvedValue([]),
    updateById: jest.fn(async (id: string, data: Record<string, unknown>) => ({
      ...stale.find((s) => s.id === id),
      ...data,
    })),
    countLiveByCommunity: jest.fn().mockResolvedValue(0),
  };
  const srsService = {
    // null = at least one instance was unreachable, which is what makes the
    // publisher scan stale.
    listPublishers: jest.fn().mockResolvedValue(null),
    kickStream: jest.fn().mockResolvedValue(undefined),
    kickClientById: jest.fn().mockResolvedValue(true),
    buildPlaybackUrls: jest
      .fn()
      .mockReturnValue({ hlsUrl: "h", flvUrl: "f", dashUrl: "d" }),
  };
  const service = new LivestreamService(
    streamRepo as never,
    srsService as never,
    { checkBan: jest.fn(), validateMembership: jest.fn() } as never,
    {
      get: jest.fn().mockResolvedValue(null),
      publish: jest.fn().mockResolvedValue(0),
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
      keys: jest.fn().mockResolvedValue([]),
    } as never,
    {} as never,
    {
      openSession: jest.fn(),
      findOpenSession: jest.fn().mockResolvedValue(null),
      closeOpenSessions: jest.fn().mockResolvedValue(0),
    } as never,
    jest.fn(),
    { bulkGetUserSnapshots: jest.fn().mockResolvedValue([]) } as never
  );
  return { service, streamRepo };
}

function embedStream() {
  return {
    id: "a".repeat(24),
    communityId: "c".repeat(24),
    creatorId: "creator-1",
    title: "t",
    description: "",
    streamKey: "secret",
    playbackId: "public",
    sourceType: "URL",
    sourceUrl: "https://example.com/live",
    status: "LIVE",
    livedAt: new Date(Date.now() - 3_600_000),
    lastHeartbeatAt: new Date(Date.now() - 3_600_000),
  };
}

describe("sweepStaleLiveStreams with an unreachable SRS", () => {
  it("still sweeps embed streams, narrowed to the sources SRS never ingests", async () => {
    const { service, streamRepo } = makeService([embedStream()]);

    await service.sweepStaleStreams();

    expect(streamRepo.findStaleLiveStreams).toHaveBeenCalledTimes(1);
    // The narrowing IS the guard: without a source filter this call would be
    // ending camera/OBS streams on evidence we do not have.
    const [, sourceTypes] = streamRepo.findStaleLiveStreams.mock.calls[0];
    expect(sourceTypes).toEqual(["URL", "YOUTUBE"]);

    // And it actually ends the stale one, rather than logging and returning.
    expect(streamRepo.updateById).toHaveBeenCalledWith(
      "a".repeat(24),
      expect.objectContaining({ status: "ENDED" })
    );
  });

  it("sweeps every source once SRS has answered", async () => {
    const { service, streamRepo } = makeService([]);
    // A complete answer, even an empty one, means SRS is reachable.
    (
      service as unknown as { srsService: { listPublishers: jest.Mock } }
    ).srsService.listPublishers.mockResolvedValue([]);

    await service.sweepStaleStreams();

    const [, sourceTypes] = streamRepo.findStaleLiveStreams.mock.calls[0];
    expect(sourceTypes).toBeUndefined();
  });
});
