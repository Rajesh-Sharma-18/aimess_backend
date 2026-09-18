/**
 * CDNetworks provider — URL minting and the callback → state-machine mapping.
 *
 * The CDN differs from SRS in the two places this suite guards:
 *
 * 1. Its callbacks carry `milltime`, an EVENT TIMESTAMP, where SRS carries
 *    `client_id`, a CONNECTION id. Feeding a timestamp into `handleUnpublish`'s
 *    client-id equality check would mismatch on every end callback, so nothing
 *    would ever leave LIVE. `handleCdnEnd` therefore compares the event against
 *    the marker the start stored and then calls `handleUnpublish` with no
 *    client id at all.
 * 2. Its polling API needs credentials we do not have yet, so
 *    `listPublishing()` must return null — never an empty map — or the
 *    reconciler would read "API unavailable" as "nothing is publishing" and end
 *    every live stream.
 */
import { createHash } from "node:crypto";

import { LivestreamService } from "../../src/services/livestream.service.js";

const CDN_ENV = {
  CDN_PUSH_DOMAIN: "push.example.com",
  CDN_PLAYBACK_BASE: "https://playback.example.com",
  CDN_APP: "live",
};

/**
 * Re-imports cdn.service with a given env, because `config/env.ts` parses
 * process.env once at import time.
 */
function loadCdnService(overrides: Record<string, string>) {
  const saved = { ...process.env };
  let mod!: typeof import("../../src/services/cdn.service.js");
  jest.isolateModules(() => {
    Object.assign(process.env, CDN_ENV, overrides);
    // require, not import: the point is to re-evaluate the module (and the env
    // it read at import time) inside this isolated registry, which a hoisted
    // static import cannot do.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../../src/services/cdn.service.js");
  });
  process.env = saved;
  return mod;
}

describe("CdnService — URL minting", () => {
  it("mints an RTMP ingest URL and no WHIP URL", () => {
    const { CdnService } = loadCdnService({ CDN_TOKEN_KEY: "" });
    const ingest = new CdnService().buildIngestEndpoints("public-name", "sekret");

    expect(ingest.rtmpUrl).toBe(
      "rtmp://push.example.com/live/public-name?secret=sekret"
    );
    // WebRTC is a different CDNetworks product; offering a WHIP URL here would
    // hand the website an endpoint that does not exist.
    expect(ingest.whipUrl).toBeUndefined();
  });

  it("mints HLS and FLV playback URLs, and no DASH", () => {
    const { CdnService } = loadCdnService({ CDN_TOKEN_KEY: "" });
    const playback = new CdnService().buildPlaybackUrls("public-name");

    expect(playback.hlsUrl).toBe(
      "https://playback.example.com/live/public-name.m3u8"
    );
    expect(playback.flvUrl).toBe(
      "https://playback.example.com/live/public-name.flv"
    );
    expect(playback.dashUrl).toBeNull();
  });

  it("signs URLs only when a token key is configured", () => {
    const { CdnService } = loadCdnService({
      CDN_TOKEN_KEY: "topsecret",
      CDN_TOKEN_TTL_SEC: "0",
      CDN_TOKEN_TIME_HEX: "true",
    });
    const url = new CdnService().buildPlaybackUrls("public-name").hlsUrl;

    const params = new URL(url).searchParams;
    const wsTime = params.get("wsTime") ?? "";
    // The console is configured to KEY+PATH+TIME; if these two ever disagree
    // every publish and playback 403s, which is the failure this pins down.
    const expected = createHash("md5")
      .update(`topsecret/live/public-name${wsTime}`)
      .digest("hex");

    expect(params.get("wsSecret")).toBe(expected);
    expect(parseInt(wsTime, 16)).toBeGreaterThan(0);
  });

  it("is unconfigured, and its API is a no-op, when the env is blank", async () => {
    const { CdnService } = loadCdnService({
      CDN_PUSH_DOMAIN: "",
      CDN_PLAYBACK_BASE: "",
    });
    const cdn = new CdnService();

    expect(cdn.isConfigured()).toBe(false);
    // null, NOT an empty map — the reconciler treats an empty map as "these
    // streams are gone".
    await expect(cdn.listPublishing()).resolves.toBeNull();
    // The disconnect API is a no-op without credentials — never a spurious
    // "kicked" that the end path might act on.
    await expect(cdn.stopPublishing("anything")).resolves.toBe(false);
  });

  it("posts the bare push URL (no secret) to the StopLivestreaming API", async () => {
    const { CdnService } = loadCdnService({
      CDN_API_USERNAME: "u",
      CDN_API_KEY: "k",
    });
    const calls: { url: string; body: unknown }[] = [];
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body });
      return {
        ok: true,
        status: 200,
        text: async () => '{"code":"0","message":"Success"}',
      } as never;
    }) as never;
    try {
      const ok = await new CdnService().stopPublishing("public-name");
      expect(ok).toBe(true);
      expect(calls[0].url).toBe("https://api.cdnetworks.com/api/live/stop");
      // liveUrl is the bare push URL — no ?secret= — and type=publish kicks
      // the encoder, not a viewer.
      expect(JSON.parse(calls[0].body as string)).toEqual({
        liveUrl: "rtmp://push.example.com/live/public-name",
        type: "publish",
      });
    } finally {
      global.fetch = realFetch;
    }
  });

  it("reports failure when the API answers a non-zero code", async () => {
    // The vendor returns HTTP 200 with a failure body (rate-limited, bad URL),
    // so success must be read from the body, not the status line.
    const { CdnService } = loadCdnService({
      CDN_API_USERNAME: "u",
      CDN_API_KEY: "k",
    });
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '{"code":"1","message":"too many urls today"}',
    })) as never;
    try {
      await expect(new CdnService().stopPublishing("x")).resolves.toBe(false);
    } finally {
      global.fetch = realFetch;
    }
  });

  it("round-trips the publisher marker and ignores SRS client ids", () => {
    const { cdnPublisherId, cdnPublisherMs } = loadCdnService({});

    expect(cdnPublisherMs(cdnPublisherId(1_700_000_000_000))).toBe(
      1_700_000_000_000
    );
    // An SRS connection id must never be read as a CDN timestamp.
    expect(cdnPublisherMs("482")).toBeNull();
    expect(cdnPublisherMs(null)).toBeNull();
  });
});

/** LivestreamService with every I/O boundary faked; CDN paths only. */
function makeService(stream: Record<string, unknown> | null) {
  const streamRepo = {
    findBySrsName: jest.fn().mockResolvedValue(stream),
    findById: jest.fn().mockResolvedValue(stream),
    findActiveByProvider: jest.fn().mockResolvedValue(stream ? [stream] : []),
    updateById: jest.fn(async (_id: string, data: Record<string, unknown>) => ({
      ...stream,
      ...data,
    })),
    countActiveByCommunityAndCreator: jest.fn().mockResolvedValue(0),
    countLiveByCommunity: jest.fn().mockResolvedValue(0),
    countLiveByCreator: jest.fn().mockResolvedValue(0),
    countActiveByCommunity: jest.fn().mockResolvedValue(0),
  };
  const srsService = {
    buildPlaybackUrls: jest.fn().mockReturnValue({
      hlsUrl: "srs-h",
      flvUrl: "srs-f",
      dashUrl: "srs-d",
    }),
    buildIngestEndpoints: jest.fn().mockReturnValue({}),
    hasFrames: jest.fn().mockResolvedValue(true),
    kickStream: jest.fn().mockResolvedValue(undefined),
  };
  const cdnService = {
    isConfigured: jest.fn().mockReturnValue(true),
    buildPlaybackUrls: jest.fn().mockReturnValue({
      hlsUrl: "cdn-h",
      flvUrl: "cdn-f",
      dashUrl: null,
    }),
    buildIngestEndpoints: jest.fn().mockReturnValue({ rtmpUrl: "rtmp://x" }),
    listPublishing: jest.fn().mockResolvedValue(null),
    isProbeEnabled: jest.fn().mockReturnValue(false),
    probeLive: jest.fn().mockResolvedValue(false),
    stopPublishing: jest.fn().mockResolvedValue(true),
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
    } as never,
    {} as never,
    {
      openSession: jest.fn(),
      findOpenSession: jest.fn().mockResolvedValue(null),
    } as never,
    jest.fn(),
    { bulkGetUserSnapshots: jest.fn().mockResolvedValue([]) } as never,
    cdnService as never
  );
  return { service, streamRepo, srsService, cdnService };
}

function cdnStream(overrides: Record<string, unknown> = {}) {
  return {
    id: "a".repeat(24),
    communityId: "c".repeat(24),
    creatorId: "creator-1",
    streamKey: "the-real-secret",
    playbackId: "public-name",
    provider: "CDN",
    status: "PENDING",
    sourceType: "OBS_RTMP",
    title: "t",
    ...overrides,
  };
}

describe("CDN callbacks → stream state", () => {
  it("start takes a PENDING stream LIVE with the CDN's playback URLs", async () => {
    const { service, streamRepo, srsService, cdnService } = makeService(
      cdnStream()
    );

    await expect(
      service.handleCdnStart("public-name", 1_700_000_000_000)
    ).resolves.toBe(true);

    const update = streamRepo.updateById.mock.calls[0][1];
    expect(update.status).toBe("LIVE");
    expect(update.hlsUrl).toBe("cdn-h");
    expect(update.publisherClientId).toBe("cdn:1700000000000");
    expect(cdnService.buildPlaybackUrls).toHaveBeenCalled();
    // A CDN row must never be stamped with SRS URLs.
    expect(srsService.buildPlaybackUrls).not.toHaveBeenCalled();
  });

  it("ignores a start callback for a stream that is not on the CDN", async () => {
    const { service, streamRepo } = makeService(
      cdnStream({ provider: "SRS" })
    );

    await expect(service.handleCdnStart("public-name", 1)).resolves.toBe(false);
    expect(streamRepo.updateById).not.toHaveBeenCalled();
  });

  it("end moves a LIVE stream into the reconnect grace window", async () => {
    const { service, streamRepo } = makeService(
      cdnStream({ status: "LIVE", publisherClientId: "cdn:1000" })
    );

    await service.handleCdnEnd("public-name", 2000);

    const update = streamRepo.updateById.mock.calls[0][1];
    expect(update.status).toBe("RECONNECTING");
    expect(update.disconnectedAt).toBeInstanceOf(Date);
  });

  it("DROPS an end callback older than the publisher currently on air", async () => {
    // The superseded-session case: the previous publisher's end arrives after
    // the new one's start. Acting on it would demote a stream whose media is
    // flowing, and one grace window later the sweeper would end it.
    const { service, streamRepo } = makeService(
      cdnStream({ status: "LIVE", publisherClientId: "cdn:5000" })
    );

    await service.handleCdnEnd("public-name", 4000);

    expect(streamRepo.updateById).not.toHaveBeenCalled();
  });

  it("reconciles nothing while the CDN API is unavailable", async () => {
    const { service, streamRepo, cdnService } = makeService(
      cdnStream({ status: "LIVE" })
    );

    // `listPublishing` already resolves null in the fake — the unconfigured
    // state this ships in.
    await (
      service as unknown as { reconcileCdn(): Promise<void> }
    ).reconcileCdn();

    expect(cdnService.listPublishing).toHaveBeenCalled();
    expect(streamRepo.findActiveByProvider).not.toHaveBeenCalled();
    expect(streamRepo.updateById).not.toHaveBeenCalled();
  });

  it("takes a PENDING stream LIVE from the playback probe when that is enabled", async () => {
    // The fallback for an account with no status API and callbacks that never
    // fire: a 200 on the stream's own playlist is proof it is publishing.
    const { service, streamRepo, cdnService } = makeService(cdnStream());
    cdnService.isProbeEnabled.mockReturnValue(true);
    cdnService.probeLive.mockResolvedValue(true);

    await (
      service as unknown as { reconcileCdn(): Promise<void> }
    ).reconcileCdn();

    expect(cdnService.probeLive).toHaveBeenCalled();
    expect(streamRepo.updateById.mock.calls[0][1].status).toBe("LIVE");
  });

  it("does not probe at all while the fallback is switched off", async () => {
    const { service, cdnService } = makeService(cdnStream());

    await (
      service as unknown as { reconcileCdn(): Promise<void> }
    ).reconcileCdn();

    expect(cdnService.probeLive).not.toHaveBeenCalled();
  });
});

describe("CDN publish authorization", () => {
  it("allows a publish for a PENDING CDN stream", async () => {
    const { service } = makeService(cdnStream());

    await expect(
      service.authorizeCdnPublish({ streamName: "public-name" })
    ).resolves.toBe(true);
  });

  it("denies an ENDED stream, which is how the encoder is evicted", async () => {
    // There is no kick API: refusing the reconnect is the only lever.
    const { service } = makeService(cdnStream({ status: "ENDED" }));

    await expect(
      service.authorizeCdnPublish({ streamName: "public-name" })
    ).resolves.toBe(false);
  });

  it("denies an unknown stream name", async () => {
    const { service } = makeService(null);

    await expect(
      service.authorizeCdnPublish({ streamName: "nope" })
    ).resolves.toBe(false);
  });
});
