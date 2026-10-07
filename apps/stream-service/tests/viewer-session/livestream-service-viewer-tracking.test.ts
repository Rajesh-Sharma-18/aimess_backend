/**
 * Suite: LivestreamService viewer-tracking integration
 *
 * Covers the service-layer wiring added for the "actual viewers" feature:
 *  - recordViewerJoin / recordViewerLeave delegate to the repo and never throw
 *    (fire-and-forget from the gateway).
 *  - every ENDED transition (owner stop, SRS unpublish, admin force-end, the
 *    reconnect-grace sweeper) closes out open viewer sessions.
 *  - adminListStreams / adminGetStream overlay the LIVE Redis viewer count
 *    instead of the stale on_play/on_stop DB counter (the reported bug).
 *  - adminListViewerSessions surfaces the persisted session history.
 *
 * All dependencies are hand-rolled fakes injected via the constructor â€” no
 * jest.mock() module interception needed.
 */
import { LivestreamService } from "../../src/services/livestream.service.js";

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const streamRepo = {
    findById: jest.fn(),
    findBySrsName: jest.fn(),
    // Plural — the reconciler's batch resolve. Missing from this fake before,
    // so every reconcileWithSrs pass threw TypeError into its own catch and
    // returned: the drift-repair leg was silently untested.
    findBySrsNames: jest.fn().mockResolvedValue([]),
    updateById: jest.fn(),
    // The conditional transition behaves like updateById in these single-path tests.
    updateIfStatus: jest.fn(function (this: { updateById: (id: string, d: unknown) => unknown }, id: string, _from: unknown, data: unknown) {
      return this.updateById(id, data);
    }),
    claimEnded: jest.fn().mockResolvedValue(true),
    findStaleReconnectingStreams: jest.fn().mockResolvedValue([]),
    countActiveByCommunityAndCreator: jest.fn().mockResolvedValue(0),
    // The community-wide go-live cap. A repo method absent from this fake
    // throws TypeError into a swallowing catch, so the leg silently no-ops
    // while the suite still passes — which is how `findStalePendingStreams`
    // (added below for the same reason) went unnoticed.
    countActiveByCommunity: jest.fn().mockResolvedValue(0),
    findStalePendingStreams: jest.fn().mockResolvedValue([]),
    countLiveByCommunity: jest.fn().mockResolvedValue(0),
    adminList: jest.fn().mockResolvedValue([]),
    adminCount: jest.fn().mockResolvedValue(0),
    raisePeakViewers: jest.fn().mockResolvedValue(undefined),
    ...(overrides.streamRepo as object),
  };
  const srsService = {
    kickStream: jest.fn().mockResolvedValue(undefined),
    buildPlaybackUrls: jest.fn().mockReturnValue({
      hlsUrl: "",
      flvUrl: "",
      dashUrl: "",
    }),
    // Resolves true on the first poll so notifyWhenPlayable's fire-and-forget
    // loop (triggered by every LIVE transition) exits immediately instead of
    // scheduling real setTimeout retries that would outlive the test.
    hasFrames: jest.fn().mockResolvedValue(true),
    // `null` = "an SRS instance was unreachable, skip this reconcile pass".
    // Inert default so sweepStaleStreams' reconcile leg is a no-op for every
    // test that isn't specifically exercising DBâ†”SRS drift repair.
    listPublishers: jest.fn().mockResolvedValue(null),
    kickClientById: jest.fn().mockResolvedValue(true),
    ...(overrides.srsService as object),
  };
  const communityClient = {
    validateMembership: jest.fn(),
    ...(overrides.communityClient as object),
  };
  // Presence is a HASH of userId -> open-socket refcount (HLEN = unique
  // viewers), not the old SET of userIds â€” see stream.ns.ts's sessionKey.
  const redis = {
    // GET backs the fail-CLOSED system-ban gate on the go-live paths; without
    // it every publish/markLive here would be denied.
    get: jest.fn().mockResolvedValue(null),
    hlen: jest.fn().mockResolvedValue(0),
    hkeys: jest.fn().mockResolvedValue([]),
    hincrby: jest.fn(),
    hdel: jest.fn(),
    hexists: jest.fn().mockResolvedValue(0),
    expire: jest.fn(),
    publish: jest.fn().mockResolvedValue(undefined),
    ...(overrides.redis as object),
  };
  const banRepo = {} as any;
  const viewerSessionRepo = {
    recordJoin: jest.fn().mockResolvedValue("sess-1"),
    recordLeave: jest.fn().mockResolvedValue(true),
    closeAllOpenForStream: jest.fn().mockResolvedValue(0),
    closeAllOpenForUser: jest.fn().mockResolvedValue(0),
    listByStream: jest
      .fn()
      .mockResolvedValue({ rows: [], total: 0 }),
    countDistinctUsers: jest.fn().mockResolvedValue(0),
    countDistinctUsersByStreamIds: jest.fn().mockResolvedValue(new Map()),
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
    // The PUBLIC name SRS knows this stream by, and what `listPublishers()`
    // reports back. Distinct from `streamKey` (the publish secret) since the
    // ingest/playback split — the fixture had none, so every SRS-facing test
    // here was exercising only the pre-split shape where the two were equal.
    playbackId: "public-1",
    status: "LIVE",
    hlsUrl: null,
    flvUrl: null,
    dashUrl: null,
    commentStatus: true,
    viewerCount: 999, // deliberately stale â€” proves the Redis overlay wins
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
  it("records a viewer's join against their device session", async () => {
    const { service, viewerSessionRepo } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(makeStream()) },
    });

    await service.recordViewerJoin("stream-1", "user-1", "auth-1");

    expect(viewerSessionRepo.recordJoin).toHaveBeenCalledWith({
      livestreamId: "stream-1",
      userId: "user-1",
      authSessionId: "auth-1",
      isHost: false,
    });
  });

  it("records the creator's join as the host session", async () => {
    const { service, viewerSessionRepo } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(makeStream()) },
    });

    await service.recordViewerJoin("stream-1", "creator-1", "auth-9");

    expect(viewerSessionRepo.recordJoin).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "creator-1", isHost: true })
    );
  });

  it("opens no session on a stream that has already ended", async () => {
    const { service, viewerSessionRepo } = makeDeps({
      streamRepo: {
        findById: jest
          .fn()
          .mockResolvedValue(makeStream({ status: "ENDED" })),
      },
    });

    await service.recordViewerJoin("stream-1", "user-1", "auth-1");

    expect(viewerSessionRepo.recordJoin).not.toHaveBeenCalled();
  });

  it("closes the device session with the reason the gateway observed", async () => {
    const { service, viewerSessionRepo } = makeDeps();

    await service.recordViewerLeave("stream-1", "user-1", "auth-1", "LEFT");
    await service.recordViewerLeave("stream-1", "user-1", "auth-1", "");

    expect(viewerSessionRepo.recordLeave).toHaveBeenNthCalledWith(1, {
      livestreamId: "stream-1",
      userId: "user-1",
      authSessionId: "auth-1",
      reason: "LEFT",
    });
    expect(viewerSessionRepo.recordLeave).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ reason: "DISCONNECTED" })
    );
  });

  it("a ban-kick (REMOVED) closes every device session of the user", async () => {
    const { service, viewerSessionRepo } = makeDeps();

    await service.recordViewerLeave("stream-1", "user-1", "", "REMOVED");

    expect(viewerSessionRepo.closeAllOpenForUser).toHaveBeenCalledWith(
      "stream-1",
      "user-1",
      expect.any(Date)
    );
    expect(viewerSessionRepo.recordLeave).not.toHaveBeenCalled();
  });

  it("swallows repo failures — never throws into the caller (gateway fire-and-forget)", async () => {
    const { service, viewerSessionRepo } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(makeStream()) },
      viewerSessionRepo: {
        recordJoin: jest.fn().mockRejectedValue(new Error("db down")),
        recordLeave: jest.fn().mockRejectedValue(new Error("db down")),
      },
    });

    await expect(
      service.recordViewerJoin("stream-1", "user-1", "auth-1")
    ).resolves.toBeUndefined();
    await expect(
      service.recordViewerLeave("stream-1", "user-1", "auth-1", "LEFT")
    ).resolves.toBeUndefined();
    expect(viewerSessionRepo.recordJoin).toHaveBeenCalled();
  });
});

describe("LivestreamService â€” viewer sessions close out on every ENDED transition", () => {
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

  it("handleUnpublish (SRS webhook) on a PENDING stream (no live session to preserve) ends outright and closes viewer sessions", async () => {
    const stream = makeStream({ status: "PENDING", livedAt: null });
    const { service, viewerSessionRepo } = makeDeps({
      streamRepo: {
        findBySrsName: jest.fn().mockResolvedValue(stream),
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

  it("adminForceEnd that loses the end race to another admin does not finalize twice", async () => {
    const stream = makeStream();
    const { service, srsService, viewerSessionRepo, streamRepo } = makeDeps({
      streamRepo: {
        findById: jest.fn().mockResolvedValue(stream),
        claimEnded: jest.fn().mockResolvedValue(false),
      },
    });

    const result = await service.adminForceEnd("stream-1", "policy violation");
    await flushMicrotasks();

    expect(result).toEqual({ success: false, status: "ENDED" });
    expect(streamRepo.claimEnded).toHaveBeenCalledWith("stream-1", expect.any(Object));
    expect(streamRepo.updateById).not.toHaveBeenCalled();
    expect(srsService.kickStream).not.toHaveBeenCalled();
    expect(viewerSessionRepo.closeAllOpenForStream).not.toHaveBeenCalled();
  });
});

describe("LivestreamService â€” community go-live cap", () => {
  // env default cap is 5 (STREAM_MAX_CONCURRENT_PER_COMMUNITY). The cap was
  // only ever checked in createStream, where the new row is PENDING — and
  // PENDING never occupies a slot by design. So N different creators could each
  // hold a PENDING row and all publish, putting the community over its cap,
  // while publishCommunityStreamStarted capped the *reported* count and hid it.
  // PENDING → LIVE is the transition that actually takes the slot.
  it("DENIES handlePublish when the community is already at cap", async () => {
    const stream = makeStream({ status: "PENDING", livedAt: null });
    const { service, streamRepo } = makeDeps({
      streamRepo: {
        findBySrsName: jest.fn().mockResolvedValue(stream),
        countActiveByCommunity: jest.fn().mockResolvedValue(5),
      },
    });

    await expect(
      service.handlePublish("key-1", undefined, { secret: "key-1" })
    ).resolves.toBe(false);
    expect(streamRepo.updateById).not.toHaveBeenCalled();
  });

  it("markLive throws STREAM_COMMUNITY_CONCURRENCY_LIMIT at cap", async () => {
    const stream = makeStream({ status: "PENDING", livedAt: null });
    const { service } = makeDeps({
      streamRepo: {
        findById: jest.fn().mockResolvedValue(stream),
        countActiveByCommunity: jest.fn().mockResolvedValue(5),
      },
    });

    await expect(service.markLive("stream-1", "creator-1")).rejects.toThrow(
      /STREAM_COMMUNITY_CONCURRENCY_LIMIT/
    );
  });

  it("allows the transition below cap", async () => {
    const stream = makeStream({ status: "PENDING", livedAt: null });
    const { service, streamRepo } = makeDeps({
      streamRepo: {
        findBySrsName: jest.fn().mockResolvedValue(stream),
        countActiveByCommunity: jest.fn().mockResolvedValue(4),
        updateById: jest
          .fn()
          .mockResolvedValue({ ...stream, status: "LIVE", livedAt: new Date() }),
      },
    });

    await expect(
      service.handlePublish("key-1", undefined, { secret: "key-1" })
    ).resolves.toBe(true);
    expect(streamRepo.updateById).toHaveBeenCalled();
  });

  it("excludes the transitioning stream from its own count", async () => {
    // The trap: countActiveByCommunity counts LIVE *and* RECONNECTING, so a
    // stream resuming from a blip is already counted by its own row. Without
    // the exclusion, a community at cap would deny every reconnect — killing
    // healthy broadcasts, which is worse than the bug being fixed.
    const stream = makeStream({ status: "PENDING", livedAt: null });
    const { service, streamRepo } = makeDeps({
      streamRepo: {
        findBySrsName: jest.fn().mockResolvedValue(stream),
        countActiveByCommunity: jest.fn().mockResolvedValue(0),
        updateById: jest
          .fn()
          .mockResolvedValue({ ...stream, status: "LIVE", livedAt: new Date() }),
      },
    });

    await service.handlePublish("key-1", undefined, { secret: "key-1" });

    expect(streamRepo.countActiveByCommunity).toHaveBeenCalledWith(
      "comm-1",
      "stream-1"
    );
  });

  it("lets a RECONNECTING stream resume in a community at cap", async () => {
    // Same trap end to end: the resuming row is one of the five, so excluding
    // it leaves four — under the cap.
    const stream = makeStream({
      status: "RECONNECTING",
      disconnectedAt: new Date(),
    });
    const { service, streamRepo } = makeDeps({
      streamRepo: {
        findBySrsName: jest.fn().mockResolvedValue(stream),
        countActiveByCommunity: jest.fn().mockResolvedValue(4),
        updateById: jest.fn().mockResolvedValue({ ...stream, status: "LIVE" }),
      },
    });

    await expect(
      service.handlePublish("key-1", "client-a", { secret: "key-1" })
    ).resolves.toBe(true);
    expect(streamRepo.updateById).toHaveBeenCalledWith(
      "stream-1",
      expect.objectContaining({ status: "LIVE" })
    );
  });

  it("never re-checks the cap for an already-LIVE stream", async () => {
    // A duplicate on_publish short-circuits before either guard, so a stream
    // already on air can never be denied by the cap.
    const stream = makeStream({ status: "LIVE" });
    const { service, streamRepo } = makeDeps({
      streamRepo: {
        findBySrsName: jest.fn().mockResolvedValue(stream),
        countActiveByCommunity: jest.fn().mockResolvedValue(99),
      },
    });

    await expect(
      service.handlePublish("key-1", undefined, { secret: "key-1" })
    ).resolves.toBe(true);
    expect(streamRepo.countActiveByCommunity).not.toHaveBeenCalled();
  });
});

describe("LivestreamService â€” host viewer session on go-live", () => {
  it("handlePublish opens a viewer session for the host on a fresh PENDINGâ†’LIVE transition", async () => {
    const stream = makeStream({ status: "PENDING", livedAt: null });
    const { service, viewerSessionRepo } = makeDeps({
      streamRepo: {
        findBySrsName: jest.fn().mockResolvedValue(stream),
        updateById: jest.fn().mockResolvedValue({
          ...stream,
          status: "LIVE",
          livedAt: new Date(),
        }),
      },
    });

    const allowed = await service.handlePublish("key-1", undefined, { secret: "key-1" });
    await flushMicrotasks();

    expect(allowed).toBe(true);
    expect(viewerSessionRepo.recordJoin).toHaveBeenCalledWith({
      livestreamId: "stream-1",
      userId: "creator-1",
      authSessionId: "",
      isHost: true,
    });
  });

  it("markLive opens a viewer session for the host on a fresh PENDINGâ†’LIVE transition", async () => {
    const stream = makeStream({ status: "PENDING", livedAt: null });
    const { service, viewerSessionRepo } = makeDeps({
      streamRepo: {
        findById: jest.fn().mockResolvedValue(stream),
        updateById: jest.fn().mockResolvedValue({
          ...stream,
          status: "LIVE",
          livedAt: new Date(),
        }),
      },
    });

    await service.markLive("stream-1", "creator-1", "auth-host");
    await flushMicrotasks();

    // The go-live request's login is the device the host broadcasts from.
    expect(viewerSessionRepo.recordJoin).toHaveBeenCalledWith({
      livestreamId: "stream-1",
      userId: "creator-1",
      authSessionId: "auth-host",
      isHost: true,
    });
  });

  it("handlePublish on RESUME (RECONNECTINGâ†’LIVE) does NOT re-record the host â€” the original open session is preserved", async () => {
    const originalLivedAt = new Date(Date.now() - 120_000);
    const stream = makeStream({
      status: "RECONNECTING",
      livedAt: originalLivedAt,
      disconnectedAt: new Date(Date.now() - 5_000),
    });
    const { service, viewerSessionRepo } = makeDeps({
      streamRepo: {
        findBySrsName: jest.fn().mockResolvedValue(stream),
        updateById: jest.fn().mockResolvedValue({
          ...stream,
          status: "LIVE",
          disconnectedAt: null,
        }),
      },
    });

    await service.handlePublish("key-1", undefined, { secret: "key-1" });
    await flushMicrotasks();

    expect(viewerSessionRepo.recordJoin).not.toHaveBeenCalled();
  });

  it("host viewer session is closed alongside every viewer when the stream ENDS", async () => {
    // The stream ends via any ENDED path â€” closeAllOpenForStream sweeps every
    // open row, including the host row opened at go-live.
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

  it("a repo failure recording the host session does NOT block go-live (fire-and-forget)", async () => {
    const stream = makeStream({ status: "PENDING", livedAt: null });
    const { service } = makeDeps({
      streamRepo: {
        findBySrsName: jest.fn().mockResolvedValue(stream),
        updateById: jest.fn().mockResolvedValue({
          ...stream,
          status: "LIVE",
          livedAt: new Date(),
        }),
      },
      viewerSessionRepo: {
        recordJoin: jest.fn().mockRejectedValue(new Error("db down")),
      },
    });

    await expect(service.handlePublish("key-1", undefined, { secret: "key-1" })).resolves.toBe(true);
  });
});

describe("LivestreamService â€” publisher reconnect-grace (RECONNECTING)", () => {
  it("handleUnpublish on a LIVE stream enters RECONNECTING instead of ending it â€” no viewer sessions closed, no stream.ended emitted", async () => {
    const stream = makeStream({ status: "LIVE" });
    const { service, streamRepo, viewerSessionRepo, eventPublisher } = makeDeps(
      {
        streamRepo: {
          findBySrsName: jest.fn().mockResolvedValue(stream),
          updateById: jest.fn().mockResolvedValue({
            ...stream,
            status: "RECONNECTING",
            disconnectedAt: new Date(),
          }),
        },
      }
    );

    await service.handleUnpublish("key-1");
    await flushMicrotasks();

    expect(streamRepo.updateById).toHaveBeenCalledWith(
      "stream-1",
      expect.objectContaining({ status: "RECONNECTING" })
    );
    expect(viewerSessionRepo.closeAllOpenForStream).not.toHaveBeenCalled();
    expect(eventPublisher).not.toHaveBeenCalledWith(
      "stream.ended",
      expect.anything()
    );
  });

  it("handleUnpublish IGNORES a stale hook from a superseded publisher â€” the stream stays LIVE", async () => {
    // WHIP reconnect = DELETE(old client-a) + POST(new client-b). SRS fires both
    // hooks async, so client-a's on_unpublish can land after client-b's
    // on_publish already put the stream back on air. Acting on it would pin a
    // healthily-publishing stream to RECONNECTING until the sweeper ends it.
    const stream = makeStream({
      status: "LIVE",
      publisherClientId: "client-b",
    });
    const { service, streamRepo, eventPublisher } = makeDeps({
      streamRepo: { findBySrsName: jest.fn().mockResolvedValue(stream) },
    });

    await service.handleUnpublish("key-1", "client-a");
    await flushMicrotasks();

    expect(streamRepo.updateById).not.toHaveBeenCalled();
    expect(eventPublisher).not.toHaveBeenCalled();
  });

  it("handleUnpublish HONOURS a hook from the publisher currently on air", async () => {
    const stream = makeStream({
      status: "LIVE",
      publisherClientId: "client-b",
    });
    const { service, streamRepo } = makeDeps({
      streamRepo: {
        findBySrsName: jest.fn().mockResolvedValue(stream),
        updateById: jest.fn().mockResolvedValue({
          ...stream,
          status: "RECONNECTING",
          disconnectedAt: new Date(),
        }),
      },
    });

    await service.handleUnpublish("key-1", "client-b");
    await flushMicrotasks();

    expect(streamRepo.updateById).toHaveBeenCalledWith(
      "stream-1",
      expect.objectContaining({ status: "RECONNECTING" })
    );
  });

  it("handlePublish on an already-LIVE stream records the new client id so the previous session's on_unpublish is recognised as stale", async () => {
    const stream = makeStream({
      status: "LIVE",
      publisherClientId: "client-a",
    });
    const { service, streamRepo } = makeDeps({
      streamRepo: {
        findBySrsName: jest.fn().mockResolvedValue(stream),
        updateById: jest.fn().mockResolvedValue(stream),
      },
    });

    await expect(service.handlePublish("key-1", "client-b", { secret: "key-1" })).resolves.toBe(
      true
    );

    expect(streamRepo.updateById).toHaveBeenCalledWith("stream-1", {
      publisherClientId: "client-b",
    });
  });

  it("the grace sweeper RESUMES a past-grace stream that SRS still has a publisher for, instead of ending a live broadcast", async () => {
    const stream = makeStream({
      status: "RECONNECTING",
      disconnectedAt: new Date(Date.now() - 120_000),
    });
    const { service, streamRepo, eventPublisher } = makeDeps({
      streamRepo: {
        findStaleReconnectingStreams: jest.fn().mockResolvedValue([stream]),
        findBySrsName: jest.fn().mockResolvedValue(stream),
        updateById: jest.fn().mockResolvedValue({
          ...stream,
          status: "LIVE",
          disconnectedAt: null,
        }),
      },
      srsService: {
        // SRS reports the PUBLISHED name (playbackId), not the streamKey —
        // this is what a real listPublishers() reply looks like post-split.
        listPublishers: jest
          .fn()
          .mockResolvedValue([
            {
              apiBase: "http://srs",
              streamKey: "public-1",
              clientId: "client-b",
            },
          ]),
      },
    });

    await service.sweepStaleStreams();
    await flushMicrotasks();

    expect(streamRepo.updateById).toHaveBeenCalledWith(
      "stream-1",
      expect.objectContaining({ status: "LIVE", publisherClientId: "client-b" })
    );
    expect(eventPublisher).not.toHaveBeenCalledWith(
      "stream.ended",
      expect.anything()
    );
  });

  it("the grace sweeper does NOT resume when SRS reports a different stream's name", async () => {
    // Guards the fix from over-reaching: matching must be on the published
    // name, not "SRS has some publisher". A publisher for another stream must
    // not keep this one alive.
    const stream = makeStream({
      status: "RECONNECTING",
      disconnectedAt: new Date(Date.now() - 120_000),
    });
    const { service, streamRepo } = makeDeps({
      streamRepo: {
        findStaleReconnectingStreams: jest.fn().mockResolvedValue([stream]),
        updateById: jest
          .fn()
          .mockResolvedValue({ ...stream, status: "ENDED", endedAt: new Date() }),
      },
      srsService: {
        listPublishers: jest.fn().mockResolvedValue([
          {
            apiBase: "http://srs",
            streamKey: "someone-elses-name",
            clientId: "client-z",
          },
        ]),
      },
    });

    await service.sweepStaleStreams();
    await flushMicrotasks();

    expect(streamRepo.updateById).toHaveBeenCalledWith(
      "stream-1",
      expect.objectContaining({ status: "ENDED" })
    );
  });

  it("the grace sweeper still ENDS a past-grace stream SRS has no publisher for", async () => {
    const stream = makeStream({
      status: "RECONNECTING",
      disconnectedAt: new Date(Date.now() - 120_000),
    });
    const { service, streamRepo, eventPublisher } = makeDeps({
      streamRepo: {
        findStaleReconnectingStreams: jest.fn().mockResolvedValue([stream]),
        updateById: jest.fn().mockResolvedValue({
          ...stream,
          status: "ENDED",
          endedAt: new Date(),
        }),
      },
      srsService: { listPublishers: jest.fn().mockResolvedValue([]) },
    });

    await service.sweepStaleStreams();
    await flushMicrotasks();

    expect(streamRepo.updateById).toHaveBeenCalledWith(
      "stream-1",
      expect.objectContaining({ status: "ENDED" })
    );
    expect(eventPublisher).toHaveBeenCalledWith(
      "stream.ended",
      expect.anything()
    );
  });

  it("reconcileWithSrs resolves a publisher by the PUBLISHED name, not the streamKey", async () => {
    // The bug this pins: `listPublishers()` reports SRS's `client.name`, which
    // since the ingest/playback split is the playbackId. The reconciler keyed
    // its lookup map by `streamKey`, so every post-split publisher fell through
    // to the "unknown name" branch and NOTHING SRS-driven worked for new
    // streams — dropped-webhook recovery, orphan re-kick, reconnect resume.
    //
    // A PENDING stream that SRS is already carrying must be recovered to LIVE.
    const stream = makeStream({ status: "PENDING", livedAt: null });
    const { service, streamRepo } = makeDeps({
      streamRepo: {
        findBySrsNames: jest.fn().mockResolvedValue([stream]),
        findBySrsName: jest.fn().mockResolvedValue(stream),
        updateById: jest
          .fn()
          .mockResolvedValue({ ...stream, status: "LIVE", livedAt: new Date() }),
      },
      srsService: {
        listPublishers: jest.fn().mockResolvedValue([
          {
            apiBase: "http://srs",
            streamKey: "public-1", // the playbackId, as SRS reports it
            clientId: "client-a",
          },
        ]),
      },
    });

    await service.sweepStaleStreams();
    await flushMicrotasks();

    expect(streamRepo.findBySrsNames).toHaveBeenCalledWith(["public-1"]);
    expect(streamRepo.updateById).toHaveBeenCalledWith(
      "stream-1",
      expect.objectContaining({ status: "LIVE" })
    );
  });

  it("reconcileWithSrs leaves a LIVE stream SRS is carrying untouched", async () => {
    const stream = makeStream({ status: "LIVE" });
    const { service, streamRepo, srsService } = makeDeps({
      streamRepo: {
        findBySrsNames: jest.fn().mockResolvedValue([stream]),
      },
      srsService: {
        listPublishers: jest.fn().mockResolvedValue([
          {
            apiBase: "http://srs",
            streamKey: "public-1",
            clientId: "client-a",
          },
        ]),
      },
    });

    await service.sweepStaleStreams();
    await flushMicrotasks();

    expect(streamRepo.updateById).not.toHaveBeenCalled();
    // A LIVE stream SRS is carrying must never be kicked.
    expect(srsService.kickClientById).not.toHaveBeenCalled();
  });

  it("reconcileWithSrs re-kicks a publisher whose stream is already ENDED", async () => {
    // The other direction of drift: a kick that silently failed leaves SRS
    // carrying a publisher for a terminal row. Also resolved by published name.
    const stream = makeStream({ status: "ENDED", endedAt: new Date() });
    const { service, srsService } = makeDeps({
      streamRepo: {
        findBySrsNames: jest.fn().mockResolvedValue([stream]),
      },
      srsService: {
        listPublishers: jest.fn().mockResolvedValue([
          {
            apiBase: "http://srs",
            streamKey: "public-1",
            clientId: "client-a",
          },
        ]),
      },
    });

    await service.sweepStaleStreams();
    await flushMicrotasks();

    expect(srsService.kickClientById).toHaveBeenCalledWith(
      "http://srs",
      "client-a"
    );
  });

  it("reconcileWithSrs leaves a genuinely unknown publisher alone", async () => {
    // No DB row for that name: log and move on, never kick — a create/publish
    // race must not have its publisher killed mid-handshake.
    const { service, srsService, streamRepo } = makeDeps({
      streamRepo: { findBySrsNames: jest.fn().mockResolvedValue([]) },
      srsService: {
        listPublishers: jest.fn().mockResolvedValue([
          {
            apiBase: "http://srs",
            streamKey: "not-in-the-db",
            clientId: "client-x",
          },
        ]),
      },
    });

    await service.sweepStaleStreams();
    await flushMicrotasks();

    expect(srsService.kickClientById).not.toHaveBeenCalled();
    expect(streamRepo.updateById).not.toHaveBeenCalled();
  });

  it("handleUnpublish is idempotent while already RECONNECTING â€” does not reset disconnectedAt or re-run any side effects", async () => {
    const stream = makeStream({
      status: "RECONNECTING",
      disconnectedAt: new Date(Date.now() - 5_000),
    });
    const { service, streamRepo } = makeDeps({
      streamRepo: { findBySrsName: jest.fn().mockResolvedValue(stream) },
    });

    await service.handleUnpublish("key-1");
    await flushMicrotasks();

    expect(streamRepo.updateById).not.toHaveBeenCalled();
  });

  it("handlePublish resumes a RECONNECTING stream to LIVE, preserving the original livedAt and NOT re-emitting stream.started", async () => {
    const originalLivedAt = new Date(Date.now() - 120_000);
    const stream = makeStream({
      status: "RECONNECTING",
      livedAt: originalLivedAt,
      disconnectedAt: new Date(Date.now() - 5_000),
    });
    const { service, streamRepo, eventPublisher } = makeDeps({
      streamRepo: {
        findBySrsName: jest.fn().mockResolvedValue(stream),
        countActiveByCommunityAndCreator: jest.fn().mockResolvedValue(0),
        updateById: jest.fn().mockResolvedValue({
          ...stream,
          status: "LIVE",
          disconnectedAt: null,
        }),
      },
    });

    const allowed = await service.handlePublish("key-1", undefined, { secret: "key-1" });
    await flushMicrotasks();

    expect(allowed).toBe(true);
    expect(streamRepo.updateById).toHaveBeenCalledWith(
      "stream-1",
      expect.objectContaining({ status: "LIVE", disconnectedAt: null })
    );
    // Resume must not stamp a new livedAt â€” the update payload should omit it.
    expect(streamRepo.updateById).not.toHaveBeenCalledWith(
      "stream-1",
      expect.objectContaining({ livedAt: expect.anything() })
    );
    expect(eventPublisher).not.toHaveBeenCalledWith(
      "stream.started",
      expect.anything()
    );
  });

  it("sweepStaleReconnectingStreams finalizes a stream whose grace window expired â€” ends it and closes viewer sessions", async () => {
    const stream = makeStream({
      status: "RECONNECTING",
      disconnectedAt: new Date(Date.now() - 120_000),
    });
    const { service, viewerSessionRepo, eventPublisher } = makeDeps({
      streamRepo: {
        findStaleReconnectingStreams: jest.fn().mockResolvedValue([stream]),
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
    expect(eventPublisher).toHaveBeenCalledWith(
      "stream.ended",
      expect.objectContaining({ streamId: "stream-1" })
    );
  });
});

describe("LivestreamService.forceEndStreamsByCreator â€” account/membership-loss bulk force-end", () => {
  it("ends every active stream returned for the creator and closes their viewer sessions", async () => {
    const streamA = makeStream({ id: "stream-a", status: "LIVE" });
    const streamB = makeStream({ id: "stream-b", status: "RECONNECTING" });
    const { service, streamRepo, viewerSessionRepo, eventPublisher } = makeDeps(
      {
        streamRepo: {
          findActiveByCreator: jest.fn().mockResolvedValue([streamA, streamB]),
          updateById: jest
            .fn()
            .mockImplementation((id: string, data: Record<string, unknown>) =>
              Promise.resolve({
                ...(id === "stream-a" ? streamA : streamB),
                ...data,
              })
            ),
        },
      }
    );

    const result = await service.forceEndStreamsByCreator(
      "creator-1",
      undefined,
      "ACCOUNT_BANNED"
    );

    expect(result).toEqual({ endedCount: 2 });
    expect(streamRepo.findActiveByCreator).toHaveBeenCalledWith(
      "creator-1",
      undefined
    );
    expect(viewerSessionRepo.closeAllOpenForStream).toHaveBeenCalledWith(
      "stream-a",
      expect.any(Date)
    );
    expect(viewerSessionRepo.closeAllOpenForStream).toHaveBeenCalledWith(
      "stream-b",
      expect.any(Date)
    );
    expect(eventPublisher).toHaveBeenCalledWith(
      "stream.ended",
      expect.objectContaining({ streamId: "stream-a" })
    );
    expect(eventPublisher).toHaveBeenCalledWith(
      "stream.ended",
      expect.objectContaining({ streamId: "stream-b" })
    );
  });

  it("passes the communityId through unchanged when scoping to one community", async () => {
    const { service, streamRepo } = makeDeps({
      streamRepo: { findActiveByCreator: jest.fn().mockResolvedValue([]) },
    });

    const result = await service.forceEndStreamsByCreator(
      "creator-1",
      "comm-1",
      "COMMUNITY_BANNED"
    );

    expect(result).toEqual({ endedCount: 0 });
    expect(streamRepo.findActiveByCreator).toHaveBeenCalledWith(
      "creator-1",
      "comm-1"
    );
  });

  it("one stream failing to end does not stop the rest from being ended", async () => {
    const streamA = makeStream({ id: "stream-a", status: "LIVE" });
    const streamB = makeStream({ id: "stream-b", status: "LIVE" });
    const { service } = makeDeps({
      streamRepo: {
        findActiveByCreator: jest.fn().mockResolvedValue([streamA, streamB]),
        updateById: jest
          .fn()
          .mockImplementationOnce(() => Promise.reject(new Error("db down")))
          .mockImplementationOnce((id: string, data: Record<string, unknown>) =>
            Promise.resolve({ ...streamB, ...data })
          ),
      },
    });

    const result = await service.forceEndStreamsByCreator(
      "creator-1",
      undefined,
      "ACCOUNT_DELETED"
    );

    expect(result).toEqual({ endedCount: 1 });
  });

  it("never throws â€” swallows a repo query failure and returns endedCount: 0", async () => {
    const { service } = makeDeps({
      streamRepo: {
        findActiveByCreator: jest.fn().mockRejectedValue(new Error("db down")),
      },
    });

    await expect(
      service.forceEndStreamsByCreator("creator-1", undefined, "ACCOUNT_BANNED")
    ).resolves.toEqual({ endedCount: 0 });
  });
});

describe("LivestreamService.endStreamsOfRevokedSession", () => {
  function redisWithHostSession(streamIds: string[]) {
    const chain = {
      smembers: jest.fn().mockReturnThis(),
      del: jest.fn().mockReturnThis(),
      sadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([
        [null, streamIds],
        [null, 1],
      ]),
    };
    return { chain, redis: { multi: jest.fn(() => chain) } };
  }

  it("ends only the streams the revoked session started, leaving another device's broadcast live", async () => {
    const fromWeb = makeStream({ id: "stream-web", status: "LIVE" });
    const fromPhone = makeStream({ id: "stream-phone", status: "LIVE" });
    const { chain, redis } = redisWithHostSession(["stream-web"]);
    const { service, streamRepo } = makeDeps({
      redis,
      streamRepo: {
        findActiveByCreator: jest.fn().mockResolvedValue([fromWeb, fromPhone]),
        updateById: jest
          .fn()
          .mockImplementation((id: string, data: Record<string, unknown>) =>
            Promise.resolve({
              ...(id === "stream-web" ? fromWeb : fromPhone),
              ...data,
            })
          ),
      },
    });

    const result = await service.endStreamsOfRevokedSession(
      "creator-1",
      "sid-web"
    );

    expect(result).toEqual({ endedCount: 1 });
    expect(chain.smembers).toHaveBeenCalledWith("stream:host-session:sid-web");
    expect(chain.del).toHaveBeenCalledWith("stream:host-session:sid-web");
    expect(streamRepo.updateById).toHaveBeenCalledTimes(1);
    expect(streamRepo.updateById).toHaveBeenCalledWith(
      "stream-web",
      expect.objectContaining({ status: "ENDED" })
    );
  });

  it("does nothing when the session started no stream", async () => {
    const { redis } = redisWithHostSession([]);
    const findActiveByCreator = jest.fn();
    const { service } = makeDeps({ redis, streamRepo: { findActiveByCreator } });

    await expect(
      service.endStreamsOfRevokedSession("creator-1", "sid-x")
    ).resolves.toEqual({ endedCount: 0 });
    expect(findActiveByCreator).not.toHaveBeenCalled();
  });

  it("never throws when Redis is unavailable", async () => {
    const { service } = makeDeps({
      redis: {
        multi: jest.fn(() => {
          throw new Error("redis down");
        }),
      },
    });

    await expect(
      service.endStreamsOfRevokedSession("creator-1", "sid-web")
    ).resolves.toEqual({ endedCount: 0 });
    await expect(
      service.rememberHostSession("stream-1", "sid-web")
    ).resolves.toBeUndefined();
  });
});

describe("LivestreamService â€” admin viewerCount overlay (fixes the stale-count bug)", () => {
  it("adminGetStream overlays the LIVE Redis count over the stale stored column", async () => {
    const stream = makeStream({ status: "LIVE", viewerCount: 999 });
    const { service, redis } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(stream) },
      redis: { hlen: jest.fn().mockResolvedValue(3) },
    });

    const row = await service.adminGetStream("stream-1");

    expect(row?.viewerCount).toBe(3);
    expect(redis.hlen).toHaveBeenCalled();
  });

  it("adminListStreams ALSO overlays the LIVE Redis count (previously missing â€” the reported bug)", async () => {
    const stream = makeStream({ status: "LIVE", viewerCount: 999 });
    const { service } = makeDeps({
      streamRepo: {
        adminList: jest.fn().mockResolvedValue([stream]),
        adminCount: jest.fn().mockResolvedValue(1),
      },
      redis: { hlen: jest.fn().mockResolvedValue(3) },
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
    expect(redis.hlen).not.toHaveBeenCalled();
  });

  it("adminGetStream.uniqueViewerCount is the distinct-viewer count, NOT the raw totalViews join-attempt counter (the reported mismatch)", async () => {
    // totalViews=5 (checkAccess ran 5 times â€” reconnects/retries), but only 2
    // distinct users ever actually joined per LivestreamViewerSession.
    const stream = makeStream({ status: "ENDED", totalViews: 5 });
    const { service } = makeDeps({
      streamRepo: { findById: jest.fn().mockResolvedValue(stream) },
      viewerSessionRepo: {
        countDistinctUsers: jest.fn().mockResolvedValue(2),
      },
    });

    const row = await service.adminGetStream("stream-1");

    expect(row?.totalViews).toBe(5);
    expect(row?.uniqueViewerCount).toBe(2);
  });

  it("adminListStreams.uniqueViewerCount is batched per stream id (no N+1)", async () => {
    const s1 = makeStream({ id: "stream-1", status: "ENDED" });
    const s2 = makeStream({ id: "stream-2", status: "ENDED" });
    const countDistinctUsersByStreamIds = jest.fn().mockResolvedValue(
      new Map([
        ["stream-1", 2],
        ["stream-2", 5],
      ])
    );
    const { service } = makeDeps({
      streamRepo: {
        adminList: jest.fn().mockResolvedValue([s1, s2]),
        adminCount: jest.fn().mockResolvedValue(2),
      },
      viewerSessionRepo: { countDistinctUsersByStreamIds },
    });

    const { items } = await service.adminListStreams({
      sortField: "createdAt",
      sortDir: "desc",
      page: 1,
      limit: 20,
    });

    expect(countDistinctUsersByStreamIds).toHaveBeenCalledTimes(1);
    expect(countDistinctUsersByStreamIds).toHaveBeenCalledWith([
      "stream-1",
      "stream-2",
    ]);
    expect(items.find((i) => i.id === "stream-1")?.uniqueViewerCount).toBe(2);
    expect(items.find((i) => i.id === "stream-2")?.uniqueViewerCount).toBe(5);
  });
});

describe("LivestreamService.adminListViewerSessions", () => {
  it("returns one row per user; an active user's duration includes the running stretch", async () => {
    const { service, viewerSessionRepo } = makeDeps({
      viewerSessionRepo: {
        listByStream: jest.fn().mockResolvedValue({
          rows: [
            {
              id: "v-1",
              userId: "user-1",
              joinedAt: new Date(Date.now() - 120_000),
              leftAt: null,
              endReason: null,
              watchDurationSeconds: 50, // earlier stretches
              lastJoinedAt: new Date(Date.now() - 10_000),
            },
            {
              id: "v-2",
              userId: "user-2",
              joinedAt: new Date(Date.now() - 60_000),
              leftAt: new Date(Date.now() - 30_000),
              endReason: "ENDED",
              watchDurationSeconds: 30,
              lastJoinedAt: null,
            },
          ],
          total: 2,
        }),
      },
    });

    const result = await service.adminListViewerSessions("stream-1", {
      page: 2,
      limit: 20,
      sortField: "joinedAt",
      sortDir: "desc",
      status: "ALL",
    });

    expect(result.total).toBe(2);
    expect(result.sessions[0].watchDurationSeconds).toBeGreaterThanOrEqual(60);
    expect(result.sessions[0].watchDurationSeconds).toBeLessThanOrEqual(61);
    expect(result.sessions[1]).toMatchObject({ watchDurationSeconds: 30, endReason: "ENDED" });
    expect(result.sessions[0]).not.toHaveProperty("lastJoinedAt");
    expect(viewerSessionRepo.listByStream).toHaveBeenCalledWith("stream-1", {
      skip: 20,
      take: 20,
      sortField: "joinedAt",
      sortDir: "desc",
      status: "ALL",
    });
  });
});
