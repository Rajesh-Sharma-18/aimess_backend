/**
 * Suite: community-triggered mute/ban relays reach a stream in reconnect grace.
 *
 * `broadcastMuteStatusForCommunity` and `broadcastBanStatusForCommunity` are how
 * a moderation action taken on the COMMUNITY screen reaches someone who is
 * currently inside a livestream. Both asked `listStreamsInternal` for
 * `status: "LIVE"`, and `listByCommunity` treats an explicit status as an exact
 * match — so a stream whose publisher was mid-blip (RECONNECTING) was excluded.
 *
 * The result: ban a disruptive viewer while the broadcaster's connection is
 * reconnecting and nothing happens. They are never kicked, never told they are
 * muted, and because the gateway's `canComment` cache is only updated by that
 * same event, they keep reacting. Every other consumer in the service counts
 * RECONNECTING as still-going; these two were the outlier.
 *
 * Both now ask for the LIVE_STATUSES set. PENDING must still be excluded — it
 * has never broadcast, so there is nothing to kick anyone out of.
 */
import { LivestreamService } from "../../src/services/livestream.service.js";

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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const ACTIVE_STATUSES = ["PENDING", "LIVE", "RECONNECTING"];

function makeDeps(rows: Record<string, unknown>[]) {
  const streamRepo = {
    // Honours the `status` argument the way the real `listByCommunity` does:
    // a string is an exact match, an array is an `IN`, and omitting it returns
    // the ACTIVE set. Without modelling that, a fake returning `rows`
    // unconditionally would let every behavioural assertion below pass against
    // the very bug they exist to catch.
    listByCommunity: jest.fn(
      ({ status }: { status?: string | readonly string[] }) => {
        const wanted = status
          ? Array.isArray(status)
            ? [...status]
            : [status as string]
          : ACTIVE_STATUSES;
        return Promise.resolve(
          rows.filter((r) => wanted.includes(r.status as string))
        );
      }
    ),
  };
  const redis = {
    // The target is present in every stream returned, so presence never gates
    // these tests — the status filter is the only thing under test.
    hexists: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
  };

  const service = new LivestreamService(
    streamRepo as never,
    {} as never,
    {} as never,
    redis as never,
    {} as never,
    {} as never,
    jest.fn(),
    {} as never
  );

  return { service, streamRepo, redis };
}

/** Events published, as `[channel, parsedPayload]` pairs. */
function published(redis: { publish: jest.Mock }) {
  return redis.publish.mock.calls.map(([channel, body]) => [
    channel,
    JSON.parse(body as string) as { event: string; data: Record<string, unknown> },
  ]) as [string, { event: string; data: Record<string, unknown> }][];
}

describe("community ban relay", () => {
  it("kicks a viewer out of a RECONNECTING stream", async () => {
    // The regression. Before the fix this published nothing.
    const { service, redis } = makeDeps([makeStream({ status: "RECONNECTING" })]);

    await service.broadcastBanStatusForCommunity("comm-1", "viewer-1", true);

    const events = published(redis);
    expect(events).toHaveLength(1);
    expect(events[0]![0]).toBe("stream:stream-1");
    expect(events[0]![1].event).toBe("stream:banned");
    expect(events[0]![1].data).toEqual({
      streamId: "stream-1",
      userId: "viewer-1",
    });
  });

  it("asks the repository for the LIVE+RECONNECTING set, not one status", async () => {
    // Pins the mechanism. Asking for a set rather than omitting `status` and
    // filtering the page matters: omitting it also returns PENDING and orders
    // `id asc`, so a community holding enough PENDING rows would push the real
    // live streams off the end of the page and the relay would skip them.
    const { service, streamRepo } = makeDeps([makeStream()]);

    await service.broadcastBanStatusForCommunity("comm-1", "viewer-1", true);

    expect(streamRepo.listByCommunity).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: "comm-1",
        status: expect.arrayContaining(["LIVE", "RECONNECTING"]),
      })
    );
  });

  it("still kicks from a LIVE stream", async () => {
    const { service, redis } = makeDeps([makeStream()]);

    await service.broadcastBanStatusForCommunity("comm-1", "viewer-1", true);

    expect(published(redis)).toHaveLength(1);
  });

  it("does NOT relay to a PENDING stream", async () => {
    // Widening the filter must not widen it too far: a PENDING stream has
    // never broadcast, so there is nothing to kick anyone out of.
    const { service, redis } = makeDeps([makeStream({ status: "PENDING" })]);

    await service.broadcastBanStatusForCommunity("comm-1", "viewer-1", true);

    expect(redis.publish).not.toHaveBeenCalled();
  });

  it("relays to LIVE and RECONNECTING together, skipping PENDING", async () => {
    const { service, redis } = makeDeps([
      makeStream({ id: "s-live", status: "LIVE" }),
      makeStream({ id: "s-recon", status: "RECONNECTING" }),
      makeStream({ id: "s-pending", status: "PENDING" }),
    ]);

    await service.broadcastBanStatusForCommunity("comm-1", "viewer-1", true);

    expect(published(redis).map(([channel]) => channel).sort()).toEqual([
      "stream:s-live",
      "stream:s-recon",
    ]);
  });

  it("does nothing for an unban", async () => {
    // Mirrors the local per-stream unban: no auto-rejoin push.
    const { service, redis } = makeDeps([makeStream()]);

    await service.broadcastBanStatusForCommunity("comm-1", "viewer-1", false);

    expect(redis.publish).not.toHaveBeenCalled();
  });

  it("skips a stream the target is not present in", async () => {
    const { service, redis } = makeDeps([makeStream()]);
    redis.hexists.mockResolvedValue(0);

    await service.broadcastBanStatusForCommunity("comm-1", "viewer-1", true);

    expect(redis.publish).not.toHaveBeenCalled();
  });

  it("always relays to the stream's own creator without a presence lookup", async () => {
    const { service, redis } = makeDeps([makeStream()]);

    await service.broadcastBanStatusForCommunity("comm-1", "creator-1", true);

    expect(redis.hexists).not.toHaveBeenCalled();
    expect(published(redis)).toHaveLength(1);
  });

  it("survives a listing failure without throwing at the caller", async () => {
    // community-service fires this best-effort after it has already persisted
    // the ban; a relay failure must never fail that call.
    const { service } = makeDeps([]);
    const svc = service as unknown as {
      listStreamsInternal: () => Promise<never>;
    };
    svc.listStreamsInternal = jest.fn().mockRejectedValue(new Error("db down"));

    await expect(
      service.broadcastBanStatusForCommunity("comm-1", "viewer-1", true)
    ).resolves.toBeUndefined();
  });
});

describe("community mute relay", () => {
  it("notifies a viewer in a RECONNECTING stream", async () => {
    const { service, redis } = makeDeps([makeStream({ status: "RECONNECTING" })]);

    await service.broadcastMuteStatusForCommunity("comm-1", "viewer-1", true, 0);

    const events = published(redis);
    expect(events).toHaveLength(1);
    expect(events[0]![1].event).toBe("stream:member_muted");
  });

  it("sends the unmute event when unmuting", async () => {
    // Unlike ban, mute relays in both directions — the composer has to come
    // back without a rejoin.
    const { service, redis } = makeDeps([makeStream()]);

    await service.broadcastMuteStatusForCommunity(
      "comm-1",
      "viewer-1",
      false,
      0
    );

    expect(published(redis)[0]![1].event).toBe("stream:member_unmuted");
  });

  it("carries mutedUntil through to the client", async () => {
    const { service, redis } = makeDeps([makeStream()]);

    await service.broadcastMuteStatusForCommunity(
      "comm-1",
      "viewer-1",
      true,
      1234
    );

    expect(published(redis)[0]![1].data).toEqual({
      streamId: "stream-1",
      userId: "viewer-1",
      mutedUntil: 1234,
    });
  });

  it("ignores an empty communityId or userId", async () => {
    const { service, redis } = makeDeps([makeStream()]);

    await service.broadcastMuteStatusForCommunity("", "viewer-1", true, 0);
    await service.broadcastMuteStatusForCommunity("comm-1", "", true, 0);

    expect(redis.publish).not.toHaveBeenCalled();
  });
});
