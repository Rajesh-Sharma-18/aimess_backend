/**
 * The resolver's two silent-failure modes.
 *
 * 1. The SSRF guard. `sourceUrl` is broadcaster-supplied and this service
 *    fetches it from inside the cluster, so a link to `169.254.169.254`
 *    (cloud metadata / instance credentials) or `10.x` reaches things no
 *    external caller can. A hole here reads as "the link just didn't play".
 * 2. Format selection. Picking a video-only rendition plays silent, and
 *    picking a progressive URL for a live source plays a stale fragment.
 *    Neither raises, so only a test catches them.
 */
import {
  isForbiddenAddress,
  selectPlayableFormat,
} from "../../src/services/media-resolver.service.js";

const muxed = (over: Record<string, unknown> = {}) => ({
  url: "https://cdn.example.com/v.mp4",
  ext: "mp4",
  protocol: "https",
  vcodec: "avc1",
  acodec: "mp4a",
  height: 720,
  tbr: 1200,
  ...over,
});

describe("isForbiddenAddress", () => {
  it.each([
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["172.16.0.1"],
    ["172.31.255.254"],
    ["192.168.1.1"],
    // Cloud metadata — the one that leaks instance credentials.
    ["169.254.169.254"],
    ["0.0.0.0"],
    ["100.64.0.1"],
    ["224.0.0.1"],
    ["::1"],
    ["fe80::1"],
    ["fd00::1"],
    // An IPv4-mapped v6 literal must not smuggle a private address through.
    ["::ffff:10.0.0.1"],
  ])("blocks %s", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each([["8.8.8.8"], ["1.1.1.1"], ["93.184.216.34"], ["2606:4700::1111"]])(
    "allows %s",
    (ip) => {
      expect(isForbiddenAddress(ip)).toBe(false);
    }
  );

  it("blocks anything that is not a parseable address", () => {
    expect(isForbiddenAddress("not-an-ip")).toBe(true);
  });
});

describe("selectPlayableFormat", () => {
  it("never picks a video-only rendition, even at a higher resolution", () => {
    const result = selectPlayableFormat(
      JSON.stringify({
        title: "Clip",
        formats: [
          muxed({ url: "https://cdn.example.com/1080.mp4", height: 1080, acodec: "none" }),
          muxed({ url: "https://cdn.example.com/720.mp4", height: 720 }),
        ],
      })
    );
    expect(result.url).toBe("https://cdn.example.com/720.mp4");
    expect(result.kind).toBe("video");
  });

  it("prefers the manifest for a live source", () => {
    const result = selectPlayableFormat(
      JSON.stringify({
        is_live: true,
        formats: [
          muxed({ url: "https://cdn.example.com/stale.mp4", height: 1080 }),
          muxed({
            url: "https://cdn.example.com/live.m3u8",
            ext: "m3u8",
            protocol: "m3u8_native",
            height: 720,
          }),
        ],
      })
    );
    expect(result.url).toBe("https://cdn.example.com/live.m3u8");
    expect(result.kind).toBe("hls");
    expect(result.isLive).toBe(true);
  });

  it("skips renditions above YTDLP_MAX_HEIGHT", () => {
    const result = selectPlayableFormat(
      JSON.stringify({
        formats: [
          muxed({ url: "https://cdn.example.com/4k.mp4", height: 2160 }),
          muxed({ url: "https://cdn.example.com/1080.mp4", height: 1080 }),
        ],
      })
    );
    expect(result.url).toBe("https://cdn.example.com/1080.mp4");
  });

  /**
   * Regression: caught against real yt-dlp output, not a fixture. A live
   * extraction returned 53 formats and ZERO muxed ones — every large platform
   * is adaptive now — and the selector rejected the whole source as
   * unplayable. The renditions share one HLS master playlist that carries
   * both tracks, which is what the players actually want.
   */
  it("uses the shared HLS master when no rendition is muxed", () => {
    const manifest = "https://manifest.example.com/api/hls_variant/x.m3u8";
    const result = selectPlayableFormat(
      JSON.stringify({
        title: "Adaptive only",
        formats: [
          muxed({
            url: "https://cdn.example.com/video-only.m3u8",
            acodec: "none",
            protocol: "m3u8_native",
            height: 2160,
            manifest_url: manifest,
          }),
          muxed({
            url: "https://cdn.example.com/audio-only.m3u8",
            vcodec: "none",
            protocol: "m3u8_native",
            height: null,
            manifest_url: manifest,
          }),
        ],
      })
    );
    expect(result.url).toBe(manifest);
    expect(result.kind).toBe("hls");
  });

  it("prefers a muxed rendition over the master manifest when one exists", () => {
    const result = selectPlayableFormat(
      JSON.stringify({
        formats: [
          muxed({
            url: "https://cdn.example.com/adaptive.m3u8",
            acodec: "none",
            manifest_url: "https://manifest.example.com/master.m3u8",
          }),
          muxed({ url: "https://cdn.example.com/720.mp4", height: 720 }),
        ],
      })
    );
    expect(result.url).toBe("https://cdn.example.com/720.mp4");
    expect(result.kind).toBe("video");
  });

  it("falls back to the info-level url when there is no formats array", () => {
    const result = selectPlayableFormat(
      JSON.stringify({ url: "https://cdn.example.com/only.m3u8", title: "T" })
    );
    expect(result.url).toBe("https://cdn.example.com/only.m3u8");
    // Classified by extension, since there is no format object to inspect.
    expect(result.kind).toBe("hls");
  });

  it("carries the metadata the clients render", () => {
    const result = selectPlayableFormat(
      JSON.stringify({
        title: "A talk",
        thumbnail: "https://cdn.example.com/t.jpg",
        duration: 421,
        formats: [muxed()],
      })
    );
    expect(result.title).toBe("A talk");
    expect(result.thumbnail).toBe("https://cdn.example.com/t.jpg");
    expect(result.durationSec).toBe(421);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("throws when nothing playable is present", () => {
    expect(() =>
      selectPlayableFormat(JSON.stringify({ formats: [] }))
    ).toThrow();
    expect(() => selectPlayableFormat("not json")).toThrow();
  });
});
