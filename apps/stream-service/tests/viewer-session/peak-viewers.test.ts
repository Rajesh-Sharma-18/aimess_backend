/**
 * Suite: peak concurrent viewers
 *
 * The bug: the "Stream ended" summary always showed `Peak viewers: 0` while
 * duration/totalViews/comments were right. `peakViewers` existed on the row and
 * travelled the whole API/event contract intact — nothing ever WROTE it on the
 * viewer paths actually in use (socket presence, and the CDN's own count). The
 * single writer was `incrementViewer`, fed only by SRS's on_play/on_stop hooks.
 *
 * Covered here:
 *  - every path that learns a concurrent-viewer count raises the peak;
 *  - the raise is monotonic — leaves, and a stream ending at 0 viewers, never
 *    lower it (the QA repro);
 *  - the raise is a conditional UPDATE, so a simultaneous smaller write cannot
 *    clobber a larger one;
 *  - peak stays on the same semantics as the live badge (unique users,
 *    refcounted across tabs) — a rejoin or a second device does not inflate it.
 */
import { LivestreamRepository } from "../../src/repositories/livestream.repository.js";
import { LivestreamService } from "../../src/services/livestream.service.js";

/**
 * Stands in for the `peakViewers` column under `updateMany`'s `lt` guard: the
 * write lands only when it would raise the stored value, which is what makes
 * the sequence tests below meaningful rather than a restatement of the mock.
 */
function makePeakStore(initial = 0) {
  let peak = initial;
  return {
    get: (): number => peak,
    raisePeakViewers: jest.fn(async (_id: string, count: number) => {
      if (count > peak) peak = count;
    }),
  };
}

function makeDeps(hlen: number | (() => number), initialPeak = 0) {
  const peakStore = makePeakStore(initialPeak);
  const streamRepo = {
    findById: jest.fn(),
    findBySrsName: jest.fn(),
    findBySrsNames: jest.fn().mockResolvedValue([]),
    updateById: jest.fn(async (_id: string, data: Record<string, unknown>) => ({
      ...makeStream({ peakViewers: peakStore.get() }),
      ...data,
    })),
    countLiveByCommunity: jest.fn().mockResolvedValue(0),
    countActiveByCommunity: jest.fn().mockResolvedValue(0),
    countActiveByCommunityAndCreator: jest.fn().mockResolvedValue(0),
    findStaleReconnectingStreams: jest.fn().mockResolvedValue([]),
    findStalePendingStreams: jest.fn().mockResolvedValue([]),
    raisePeakViewers: peakStore.raisePeakViewers,
  };
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    hlen: jest.fn(async () => (typeof hlen === "number" ? hlen : hlen())),
    hkeys: jest.fn().mockResolvedValue([]),
    hexists: jest.fn().mockResolvedValue(0),
    publish: jest.fn().mockResolvedValue(undefined),
  };
  const viewerSessionRepo = {
    recordJoin: jest.fn().mockResolvedValue(undefined),
    recordLeave: jest.fn().mockResolvedValue(undefined),
    closeAllOpenForStream: jest.fn().mockResolvedValue(0),
  };
  const eventPublisher = jest.fn();
  const service = new LivestreamService(
    streamRepo as any,
    {
      kickStream: jest.fn().mockResolvedValue(undefined),
      buildPlaybackUrls: jest
        .fn()
        .mockReturnValue({ hlsUrl: "", flvUrl: "", dashUrl: "" }),
      hasFrames: jest.fn().mockResolvedValue(true),
      listPublishers: jest.fn().mockResolvedValue(null),
    } as any,
    { validateMembership: jest.fn() } as any,
    redis as any,
    { findActive: jest.fn().mockResolvedValue(null) } as any,
    viewerSessionRepo as any,
    eventPublisher,
    { bulkGetUserSnapshots: jest.fn().mockResolvedValue([]) } as any
  );
  return { service, streamRepo, redis, peakStore, eventPublisher };
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
    playbackId: "public-1",
    provider: "SRS",
    status: "LIVE",
    hlsUrl: null,
    flvUrl: null,
    dashUrl: null,
    commentStatus: true,
    viewerCount: 0,
    peakViewers: 0,
    totalViews: 0,
    totalComments: 0,
    livedAt: new Date(Date.now() - 60_000),
    endedAt: null,
    disconnectedAt: null,
    publisherClientId: null,
    lastHeartbeatAt: new Date(),
    videoLostAt: null,
    createdAt: new Date(Date.now() - 120_000),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("peakViewers — raised from socket presence on join", () => {
  it("Scenario A: nobody ever joins — peak stays 0", async () => {
    const { peakStore, streamRepo } = makeDeps(0);
    // No join at all: nothing calls the raise, and even if it did, a count of
    // 0 is refused at the repo (see the conditional-UPDATE suite below).
    expect(peakStore.get()).toBe(0);
    expect(streamRepo.raisePeakViewers).not.toHaveBeenCalled();
  });

  it("Scenario B: one viewer joins — peak 1", async () => {
    const { service, peakStore } = makeDeps(1);

    await service.recordViewerJoin("stream-1", "user-1");

    expect(peakStore.get()).toBe(1);
  });

  it("Scenario C: five simultaneous viewers — peak 5", async () => {
    let live = 0;
    const { service, peakStore } = makeDeps(() => live);

    // Five joins racing: each one's HLEN read already includes itself, because
    // the gateway bumps the presence hash before it calls us.
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => {
        live = n;
        return service.recordViewerJoin("stream-1", `user-${String(n)}`);
      })
    );

    expect(peakStore.get()).toBe(5);
  });

  it("Scenario E/F: peak tracks the maximum, not the latest or the join count", async () => {
    let live = 0;
    const { service, peakStore } = makeDeps(() => live);

    // 3 → 8 → 4 → 6 concurrent. Only the joins call in (a leave never raises),
    // so the sequence the service sees is 3, 8, 6.
    for (const n of [3, 8, 4, 6]) {
      live = n;
      await service.recordViewerJoin("stream-1", "user-x");
    }

    expect(peakStore.get()).toBe(8);
  });

  it("Scenario I: a second device / tab does not inflate the peak", async () => {
    // HLEN is a count of unique users, refcounted per socket — the same user on
    // two devices leaves it at 1, so the peak must not move to 2.
    const { service, peakStore, redis } = makeDeps(1);

    await service.recordViewerJoin("stream-1", "user-1");
    await service.recordViewerJoin("stream-1", "user-1");

    expect(redis.hlen).toHaveBeenCalledWith("stream:session:users:stream-1");
    expect(peakStore.get()).toBe(1);
  });

  it("never throws into the gateway's fire-and-forget call when Redis is down", async () => {
    const { service, peakStore } = makeDeps(0);
    (service as any).redis.hlen = jest
      .fn()
      .mockRejectedValue(new Error("redis down"));

    await expect(
      service.recordViewerJoin("stream-1", "user-1")
    ).resolves.toBeUndefined();
    expect(peakStore.get()).toBe(0);
  });
});

describe("peakViewers — raised from the SRS on_play hook", () => {
  it("raises to the new concurrent count without a read-then-write", async () => {
    const { service, streamRepo, peakStore } = makeDeps(0);
    streamRepo.findBySrsName.mockResolvedValue(
      makeStream({ viewerCount: 6, peakViewers: 6 })
    );

    await service.incrementViewer("key-1", 1);

    expect(streamRepo.updateById).toHaveBeenCalledWith("stream-1", {
      viewerCount: 7,
    });
    expect(streamRepo.raisePeakViewers).toHaveBeenCalledWith("stream-1", 7);
    expect(peakStore.get()).toBe(7);
  });

  it("on_stop lowers the live count but not the peak", async () => {
    const { service, streamRepo, peakStore } = makeDeps(0, 7);
    streamRepo.findBySrsName.mockResolvedValue(
      makeStream({ viewerCount: 7, peakViewers: 7 })
    );

    await service.incrementViewer("key-1", -1);

    expect(streamRepo.updateById).toHaveBeenCalledWith("stream-1", {
      viewerCount: 6,
    });
    expect(peakStore.get()).toBe(7);
  });
});

describe("peakViewers — survives the end of the stream", () => {
  it("Scenario G: every viewer leaves before End Live — the summary keeps the peak", async () => {
    // The reported bug, end to end: peak reached 7, current viewers fell to 0,
    // host pressed End Live. The ENDED view and the stream.ended event must
    // both still carry 7.
    const { service, streamRepo, eventPublisher } = makeDeps(0, 7);
    streamRepo.findById.mockResolvedValue(
      makeStream({ viewerCount: 0, peakViewers: 7 })
    );

    const view = await service.stopStream("stream-1", "creator-1");

    expect(view.peakViewers).toBe(7);
    expect(view.status).toBe("ENDED");
    // finalizeAsEnded must not blank the column on its way out.
    for (const [, data] of streamRepo.updateById.mock.calls) {
      expect(data).not.toHaveProperty("peakViewers");
    }
    const ended = eventPublisher.mock.calls.find(
      ([name]) => name === "stream.ended"
    );
    expect(ended?.[1]).toMatchObject({ peakViewers: 7 });
  });

  it("Scenario H: host ends while viewers are still connected — peak unchanged", async () => {
    const { service, streamRepo } = makeDeps(4, 9);
    streamRepo.findById.mockResolvedValue(
      makeStream({ viewerCount: 4, peakViewers: 9 })
    );

    const view = await service.stopStream("stream-1", "creator-1");

    expect(view.peakViewers).toBe(9);
  });
});

describe("LivestreamRepository.raisePeakViewers", () => {
  function makeRepo() {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const repo = new LivestreamRepository({
      livestream: { updateMany },
    } as any);
    return { repo, updateMany };
  }

  it("writes under an `lt` guard so a smaller concurrent write cannot clobber a larger one", async () => {
    const { repo, updateMany } = makeRepo();

    await repo.raisePeakViewers("stream-1", 7);

    // One conditional statement — no SELECT, so there is no window between the
    // read and the write for a racing join to slip through.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "stream-1", peakViewers: { lt: 7 } },
      data: { peakViewers: 7 },
    });
  });

  it("does not touch the row for a count of 0 (Scenario A / stream end at 0 viewers)", async () => {
    const { repo, updateMany } = makeRepo();

    await repo.raisePeakViewers("stream-1", 0);

    expect(updateMany).not.toHaveBeenCalled();
  });
});
