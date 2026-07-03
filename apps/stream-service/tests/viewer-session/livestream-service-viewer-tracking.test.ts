/**
 * Suite: LivestreamService viewer-tracking integration
 *
 * Covers the service-layer wiring added for the "actual viewers" feature:
 *  - recordViewerJoin / recordViewerLeave delegate to the repo and never throw
 *    (fire-and-forget from the gateway).
 *  - every ENDED transition (owner stop, SRS unpublish, admin force-end, the
 *    stale-stream sweeper) closes out open viewer sessions.
 *  - adminListStreams / adminGetStream overlay the LIVE Redis viewer count
 *    instead of the stale on_play/on_stop DB counter (the reported bug).
 *  - adminListViewerSessions surfaces the persisted session history.
 *
 * All dependencies are hand-rolled fakes injected via the constructor — no
 * jest.mock() module interception needed.
 */
import { LivestreamService } from "../../src/services/livestream.service.js";

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const streamRepo = {
    findById: jest.fn(),
    findByStreamKey: jest.fn(),
    updateById: jest.fn(),
    findStaleLiveStreams: jest.fn().mockResolvedValue([]),
    countLiveByCommunity: jest.fn().mockResolvedValue(0),
    adminList: jest.fn().mockResolvedValue([]),
    adminCount: jest.fn().mockResolvedValue(0),
    ...(overrides.streamRepo as object),
  };
  const srsService = {
    kickStream: jest.fn().mockResolvedValue(undefined),
    buildPlaybackUrls: jest.fn().mockReturnValue({
      hlsUrl: "",
      flvUrl: "",
      dashUrl: "",
    }),
    ...(overrides.srsService as object),
  };
  const communityClient = {
    validateMembership: jest.fn(),
    ...(overrides.communityClient as object),
  };
  const redis = {
    scard: jest.fn().mockResolvedValue(0),
    smembers: jest.fn().mockResolvedValue([]),
    sadd: jest.fn(),
    expire: jest.fn(),
    publish: jest.fn().mockResolvedValue(undefined),
    ...(overrides.redis as object),
  };
  const banRepo = {} as any;
  const viewerSessionRepo = {
    recordJoin: jest.fn().mockResolvedValue("sess-1"),
    recordLeave: jest.fn().mockResolvedValue(true),
    closeAllOpenForStream: jest.fn().mockResolvedValue(0),
    listByStream: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
    ...(overrides.viewerSessionRepo as object),
  };
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

  return {
    service,
    streamRepo,
    srsService,
    redis,
    viewerSessionRepo,
    eventPublisher,
  };
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
    viewerCount: 999, // deliberately stale — proves the Redis overlay wins
    peakViewers: 0,
    totalViews: 0,
    totalComments: 0,
    livedAt: new Date(Date.now() - 60_000),
    endedAt: null,
    lastHeartbeatAt: new Date(),
    createdAt: new Date(Date.now() - 120_000),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("LivestreamService.recordViewerJoin / recordViewerLeave", () => {
  it("delegates join to the viewer-session repo", async () => {
    const { service, viewerSessionRepo } = makeDeps();

    await service.recordViewerJoin("stream-1", "user-1");

    expect(viewerSessionRepo.recordJoin).toHaveBeenCalledWith(
      "stream-1",
      "user-1"
    );
  });

  it("delegates leave to the viewer-session repo", async () => {
    const { service, viewerSessionRepo } = makeDeps();

    await service.recordViewerLeave("stream-1", "user-1");

    expect(viewerSessionRepo.recordLeave).toHaveBeenCalledWith(
      "stream-1",
      "user-1"
    );
  });

  it("swallows repo failures — never throws into the caller (gateway fire-and-forget)", async () => {
    const { service, viewerSessionRepo } = makeDeps({
      viewerSessionRepo: {
        recordJoin: jest.fn().mockRejectedValue(new Error("db down")),
        recordLeave: jest.fn().mockRejectedValue(new Error("db down")),
      },
    });

    await expect(
      service.recordViewerJoin("stream-1", "user-1")
    ).resolves.toBeUndefined();
    await expect(
      service.recordViewerLeave("stream-1", "user-1")
    ).resolves.toBeUndefined();
    expect(viewerSessionRepo.recordJoin).toHaveBeenCalled();
  });
});

describe("LivestreamService — viewer sessions close out on every ENDED transition", () => {
  it("stopStream (owner) closes open viewer sessions", async () => {
    const stream = makeStream();
    const { service, viewerSessionRepo } = makeDeps({
      streamRepo: {
        findById: jest.fn().mockResolvedValue(stream),
        updateById: jest.fn().mockResolvedValue({
          ...stream,
          status: "ENDED",
          endedAt: new Date(),
        }),
      },
    });

    await service.stopStream("stream-1", "creator-1");
    await flushMicrotasks();

    expect(viewerSessionRepo.closeAllOpenForStream).toHaveBeenCalledWith(
      "stream-1",
      expect.any(Date)
    );
  });

  it("handleUnpublish (SRS webhook) closes open viewer sessions", async () => {
    const stream = makeStream();
    const { service, viewerSessionRepo } = makeDeps({
      streamRepo: {
        findByStreamKey: jest.fn().mockResolvedValue(stream),
        updateById: jest.fn().mockResolvedValue({
          ...stream,
          status: "ENDED",
          endedAt: new Date(),
        }),
      },
    });

    await service.handleUnpublish("key-1");
    await flushMicrotasks();

    expect(viewerSessionRepo.closeAllOpenForStream).toHaveBeenCalledWith(
      "stream-1",
      expect.any(Date)
    );
  });

  it("adminForceEnd closes open viewer sessions", async () => {
    const stream = makeStream();
    const { service, viewerSessionRepo } = makeDeps({
      streamRepo: {
        findById: jest.fn().mockResolvedValue(stream),
        updateById: jest.fn().mockResolvedValue({
          ...stream,
          status: "ENDED",
          endedAt: new Date(),
        }),
      },
    });

    const result = await service.adminForceEnd("stream-1", "policy violation");
    await flushMicrotasks();

    expect(result).toEqual({ success: true, status: "ENDED" });
    expect(viewerSessionRepo.closeAllOpenForStream).toHaveBeenCalledWith(
      "stream-1",
      expect.any(Date)
    );
  });

  it("adminForceEnd on an already-ENDED stream is idempotent and does NOT re-close sessions", async () => {
    const stream = makeStream({ status: "ENDED" });
    const { service, viewerSessionRepo } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(stream) },
    });

    const result = await service.adminForceEnd("stream-1", "policy violation");
    await flushMicrotasks();

    expect(result).toEqual({ success: false, status: "ENDED" });
    expect(viewerSessionRepo.closeAllOpenForStream).not.toHaveBeenCalled();
  });

  it("sweepStaleStreams (heartbeat timeout) closes open viewer sessions for each swept stream", async () => {
    const stream = makeStream();
    const { service, viewerSessionRepo } = makeDeps({
      streamRepo: {
        findStaleLiveStreams: jest.fn().mockResolvedValue([stream]),
        updateById: jest.fn().mockResolvedValue({
          ...stream,
          status: "ENDED",
          endedAt: new Date(),
        }),
      },
    });

    await service.sweepStaleStreams();
    await flushMicrotasks();

    expect(viewerSessionRepo.closeAllOpenForStream).toHaveBeenCalledWith(
      "stream-1",
      expect.any(Date)
    );
  });
});

describe("LivestreamService — admin viewerCount overlay (fixes the stale-count bug)", () => {
  it("adminGetStream overlays the LIVE Redis count over the stale stored column", async () => {
    const stream = makeStream({ status: "LIVE", viewerCount: 999 });
    const { service, redis } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(stream) },
      redis: { scard: jest.fn().mockResolvedValue(3) },
    });

    const row = await service.adminGetStream("stream-1");

    expect(row?.viewerCount).toBe(3);
    expect(redis.scard).toHaveBeenCalled();
  });

  it("adminListStreams ALSO overlays the LIVE Redis count (previously missing — the reported bug)", async () => {
    const stream = makeStream({ status: "LIVE", viewerCount: 999 });
    const { service } = makeDeps({
      streamRepo: {
        adminList: jest.fn().mockResolvedValue([stream]),
        adminCount: jest.fn().mockResolvedValue(1),
      },
      redis: { scard: jest.fn().mockResolvedValue(3) },
    });

    const { items } = await service.adminListStreams({
      sortField: "createdAt",
      sortDir: "desc",
      page: 1,
      limit: 20,
    });

    expect(items[0].viewerCount).toBe(3); // NOT the stale 999
  });

  it("adminListStreams does NOT overlay Redis for non-LIVE rows (keeps the frozen stored count)", async () => {
    const stream = makeStream({ status: "ENDED", viewerCount: 42 });
    const { service, redis } = makeDeps({
      streamRepo: {
        adminList: jest.fn().mockResolvedValue([stream]),
        adminCount: jest.fn().mockResolvedValue(1),
      },
    });

    const { items } = await service.adminListStreams({
      sortField: "createdAt",
      sortDir: "desc",
      page: 1,
      limit: 20,
    });

    expect(items[0].viewerCount).toBe(42);
    expect(redis.scard).not.toHaveBeenCalled();
  });
});

describe("LivestreamService.adminListViewerSessions", () => {
  it("returns per-user aggregated sessions with live-computed duration top-up for still-watching viewers", async () => {
    const openJoinedAt = new Date(Date.now() - 10_000);
    const { service, viewerSessionRepo } = makeDeps({
      viewerSessionRepo: {
        listByStream: jest.fn().mockResolvedValue({
          rows: [
            {
              userId: "user-1",
              joinedAt: openJoinedAt,
              leftAt: null,
              watchDurationSeconds: 0, // no prior CLOSED sessions to sum
              openSessionJoinedAt: openJoinedAt,
            },
            {
              userId: "user-2",
              joinedAt: new Date(Date.now() - 60_000),
              leftAt: new Date(Date.now() - 30_000),
              watchDurationSeconds: 30, // aggregated total across all closed sessions
              openSessionJoinedAt: null,
            },
          ],
          total: 2,
        }),
      },
    });

    const { sessions, total } = await service.adminListViewerSessions(
      "stream-1",
      { page: 1, limit: 20, sortField: "joinedAt", sortDir: "desc" }
    );

    expect(total).toBe(2);
    expect(sessions[0].leftAt).toBeNull();
    expect(sessions[0].watchDurationSeconds).toBeGreaterThanOrEqual(10);
    expect(sessions[1].leftAt).not.toBeNull();
    expect(sessions[1].watchDurationSeconds).toBe(30); // stored aggregate, no open session to top up
    expect(viewerSessionRepo.listByStream).toHaveBeenCalledWith("stream-1", {
      skip: 0,
      take: 20,
      sortField: "joinedAt",
      sortDir: "desc",
    });
  });

  it("REGRESSION: tops up ONLY the open session's live elapsed time, on top of the already-aggregated total from closed sessions", async () => {
    const openJoinedAt = new Date(Date.now() - 20_000); // open 20s ago
    const { service } = makeDeps({
      viewerSessionRepo: {
        listByStream: jest.fn().mockResolvedValue({
          rows: [
            {
              userId: "user-1",
              joinedAt: new Date(Date.now() - 100_000),
              leftAt: null,
              watchDurationSeconds: 50, // sum of prior CLOSED sessions
              openSessionJoinedAt: openJoinedAt,
            },
          ],
          total: 1,
        }),
      },
    });

    const { sessions } = await service.adminListViewerSessions("stream-1", {
      page: 1,
      limit: 20,
      sortField: "joinedAt",
      sortDir: "desc",
    });

    // 50s from closed sessions + ~20s live elapsed on the open one.
    expect(sessions[0].watchDurationSeconds).toBeGreaterThanOrEqual(69);
    expect(sessions[0].watchDurationSeconds).toBeLessThanOrEqual(71);
  });
});
