/**
 * CdnService.buildQualityUrls — the ABR ladder delivery map for CDN streams.
 *
 * CDNetworks transcode publishes each rung as its own stream named
 * `<name>_<suffix>`, so a rung URL is just the ordinary playback URL of that
 * derived name (inheriting buildPlaybackUrls' shape, and its token signature per
 * rung when CDN_TOKEN_KEY is set). Delivery is gated on CDN_TRANSCODE_TIERS:
 * empty = no ladder, matching the SRS `build*QualityUrls` helpers returning `{}`
 * when ABR is off — we never advertise a rendition the domain isn't producing.
 *
 * The env is parsed once at config import, so each case reloads the module with
 * its own CDN_TRANSCODE_TIERS via resetModules + dynamic import.
 */
import type { CdnService } from "../../src/services/cdn.service.js";

async function loadCdn(tiers: string): Promise<CdnService> {
  jest.resetModules();
  process.env.CDN_PUSH_DOMAIN = "push.example.com";
  process.env.CDN_PLAYBACK_BASE = "https://playback.example.com";
  process.env.CDN_APP = "live";
  process.env.CDN_TOKEN_KEY = ""; // no anti-hotlink token in this test
  process.env.CDN_TRANSCODE_TIERS = tiers;
  const mod = await import("../../src/services/cdn.service.js");
  return new mod.CdnService();
}

describe("CdnService.buildQualityUrls", () => {
  it("returns empty maps when no tiers are configured (no ladder)", async () => {
    const cdn = await loadCdn("");
    expect(cdn.buildQualityUrls("abc123")).toEqual({ hls: {}, flv: {} });
  });

  it("builds one HLS + FLV rung per configured tier, keyed by suffix", async () => {
    const cdn = await loadCdn("720p,480p");
    const { hls, flv } = cdn.buildQualityUrls("abc123");

    // HLS omits a Source rung — the base hlsUrl already is the source.
    expect(hls).toEqual({
      "720p": "https://playback.example.com/live/abc123_720p.m3u8",
      "480p": "https://playback.example.com/live/abc123_480p.m3u8",
    });
    // FLV includes an explicit Source rung (HTTP-FLV has no ABR/auto tier).
    expect(flv).toEqual({
      Source: "https://playback.example.com/live/abc123.flv",
      "720p": "https://playback.example.com/live/abc123_720p.flv",
      "480p": "https://playback.example.com/live/abc123_480p.flv",
    });
  });

  it("trims and drops blank entries in the tier list", async () => {
    const cdn = await loadCdn(" 720p , , 480p ");
    const { hls } = cdn.buildQualityUrls("xy");
    expect(Object.keys(hls)).toEqual(["720p", "480p"]);
  });
});
