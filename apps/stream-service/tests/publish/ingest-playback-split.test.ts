/**
 * AIM-16 — the publish credential must not be the playback URL.
 *
 * `streamKey` was simultaneously three things: the SRS published stream name,
 * the sole credential `on_publish` authenticates on, and the path segment of
 * the HLS/FLV/DASH URLs handed to every viewer. So the takeover was: open a
 * stream, read the name out of `…/live/<name>.m3u8` in the network tab, point
 * OBS at `rtmp://host/live/<name>`, and publish over the broadcast. Any viewer
 * could do it — including one banned from the community, since the hook has no
 * JWT and checked nothing but the name.
 *
 * SRS serves media strictly under the PUBLISHED name and its hooks cannot
 * rename, so the split runs the other way: publish under a public `playbackId`
 * and prove the right to publish with `?secret=<streamKey>`, which SRS forwards
 * to the hook as `param`.
 *
 * Streams that were live across the deploy have no `playbackId` and are
 * published under their own key; they are grandfathered until they end, and
 * that is asserted here too — without it the fix would kill every broadcast on
 * air at deploy time.
 */
import {
  extractPublishSecret,
  generatePlaybackId,
  generateStreamKey,
  isLegacyStream,
  publishSecretMatches,
  resolveSrsName,
} from "../../src/lib/stream-identity.js";
import { LivestreamService } from "../../src/services/livestream.service.js";

describe("stream identity", () => {
  it("mints two different values", () => {
    const key = generateStreamKey();
    const playbackId = generatePlaybackId();

    expect(key).not.toBe(playbackId);
    expect(key.length).toBeGreaterThanOrEqual(32);
    expect(playbackId.length).toBeGreaterThanOrEqual(16);
  });

  it("publishes a new stream under the PUBLIC id, not the secret", () => {
    const stream = { streamKey: "secret-key", playbackId: "public-id" };

    expect(resolveSrsName(stream)).toBe("public-id");
    expect(isLegacyStream(stream)).toBe(false);
  });

  it("treats a row with no playbackId as legacy, named by its key", () => {
    // A stream that was live across the deploy. SRS knows it by its key, so
    // that is what must resolve — otherwise its hooks stop matching and the
    // broadcast breaks mid-air.
    const legacy = { streamKey: "old-key", playbackId: null };

    expect(resolveSrsName(legacy)).toBe("old-key");
    expect(isLegacyStream(legacy)).toBe(true);
  });

  it.each([
    ["?secret=abc123", "abc123"],
    ["secret=abc123", "abc123"],
    ["?app=live&stream=pub&secret=abc123", "abc123"],
    ["?app=live&stream=pub", ""],
    ["", ""],
    [undefined, ""],
  ])("extracts the publish secret from param %s", (param, expected) => {
    expect(extractPublishSecret(param as string | undefined)).toBe(expected);
  });

  it("compares secrets without leaking length or content by timing", () => {
    expect(publishSecretMatches("abc123", "abc123")).toBe(true);
    expect(publishSecretMatches("abc124", "abc123")).toBe(false);
    expect(publishSecretMatches("", "abc123")).toBe(false);
    expect(publishSecretMatches("abc", "abc123")).toBe(false);
  });
});

/** Deps for a LivestreamService whose only exercised path is handlePublish. */
function makeService(stream: Record<string, unknown> | null) {
  const streamRepo = {
    findBySrsName: jest.fn().mockResolvedValue(stream),
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
      hlsUrl: "h",
      flvUrl: "f",
      dashUrl: "d",
    }),
    buildIngestEndpoints: jest.fn().mockReturnValue({}),
    // Going live kicks off a bounded poll that waits for SRS to report frames
    // before broadcasting `stream:playable`. Answering "ready" immediately ends
    // it on the first attempt; leaving it unstubbed makes the poll retry on a
    // 500 ms timer and hold the test process open.
    hasFrames: jest.fn().mockResolvedValue(true),
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
    { bulkGetUserSnapshots: jest.fn().mockResolvedValue([]) } as never
  );
  return { service, streamRepo, srsService };
}

function liveReadyStream(overrides: Record<string, unknown> = {}) {
  return {
    id: "a".repeat(24),
    communityId: "c".repeat(24),
    creatorId: "creator-1",
    streamKey: "the-real-secret",
    playbackId: "public-name",
    status: "PENDING",
    sourceType: "PHONE_CAMERA",
    title: "t",
    ...overrides,
  };
}

describe("handlePublish — the publish credential", () => {
  it("allows a publish that presents the correct secret", async () => {
    const { service } = makeService(liveReadyStream());

    await expect(
      service.handlePublish("public-name", "client-1", {
        secret: "the-real-secret",
      })
    ).resolves.toBe(true);
  });

  it("DENIES a publish that presents only the public name", async () => {
    // The whole finding: a viewer reads the name out of their playback URL and
    // points an encoder at it. Without the secret that must now fail.
    const { service, streamRepo } = makeService(liveReadyStream());

    await expect(
      service.handlePublish("public-name", "client-1", { secret: "" })
    ).resolves.toBe(false);
    expect(streamRepo.updateById).not.toHaveBeenCalled();
  });

  it("DENIES a publish presenting the wrong secret", async () => {
    const { service } = makeService(liveReadyStream());

    await expect(
      service.handlePublish("public-name", "client-1", {
        secret: "guessed-wrong",
      })
    ).resolves.toBe(false);
  });

  it("still allows a legacy stream that has no separate public name", async () => {
    // Published under its own key, so demanding a secret would kill a
    // broadcast that is on air right now — and the key is already public for
    // it regardless. Grandfathered until it ends.
    const { service } = makeService(
      liveReadyStream({ streamKey: "old-key", playbackId: null })
    );

    await expect(
      service.handlePublish("old-key", "client-1", { secret: "" })
    ).resolves.toBe(true);
  });

  it("allows the internal reconciler, which is reporting an accepted publish", async () => {
    // SRS has already accepted this publisher; there is no publish URL to read
    // a secret from, and authorisation happened at the hook.
    const { service } = makeService(liveReadyStream());

    await expect(
      service.handlePublish("public-name", undefined, "trusted")
    ).resolves.toBe(true);
  });

  it("denies an unknown stream name", async () => {
    const { service } = makeService(null);

    await expect(
      service.handlePublish("does-not-exist", "client-1", { secret: "x" })
    ).resolves.toBe(false);
  });

  it("builds playback URLs from the PUBLIC name, never the secret", async () => {
    const { service, srsService } = makeService(liveReadyStream());

    await service.handlePublish("public-name", "client-1", {
      secret: "the-real-secret",
    });

    expect(srsService.buildPlaybackUrls).toHaveBeenCalledWith("public-name");
    expect(srsService.buildPlaybackUrls).not.toHaveBeenCalledWith(
      "the-real-secret"
    );
  });
});
