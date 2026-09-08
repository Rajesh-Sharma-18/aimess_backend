import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";

import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { isStreamCacheReady } from "../config/redis.js";
import type { redis as RedisClient } from "../config/redis.js";

const execFileAsync = promisify(execFile);

/**
 * A media URL the clients can hand straight to a player.
 *
 * `kind` mirrors the shapes the website's LiveUrlEmbed and the native players
 * already handle: `hls` goes to hls.js / AVPlayer / ExoPlayer, `video` to a
 * plain `<video>` / progressive playback.
 */
export interface ResolvedSource {
  kind: "hls" | "video";
  url: string;
  title: string | null;
  thumbnail: string | null;
  durationSec: number | null;
  isLive: boolean;
  /** When the cached answer stops being trusted; hosts sign these URLs. */
  expiresAt: string;
}

/** yt-dlp `-J` output, narrowed to the fields this service reads. */
interface YtDlpFormat {
  url?: unknown;
  ext?: unknown;
  protocol?: unknown;
  vcodec?: unknown;
  acodec?: unknown;
  height?: unknown;
  tbr?: unknown;
  /** Master/variant playlist this rendition was listed from, when HLS. */
  manifest_url?: unknown;
}

interface YtDlpInfo {
  title?: unknown;
  thumbnail?: unknown;
  duration?: unknown;
  is_live?: unknown;
  url?: unknown;
  formats?: unknown;
}

/**
 * The result of asking for a URL, including the ways it can legitimately have
 * no answer.
 *
 * "The resolver is switched off" and "this link has nothing extractable" are
 * ORDINARY outcomes, not faults — most links a broadcaster pastes already match
 * a platform embed on the client and never reach here at all. Modelling them as
 * errors made a disabled optional feature surface as a red 503 in the console
 * on every paste, which reads as an outage. Only a genuine fault throws.
 */
export type ResolveOutcome =
  | { source: ResolvedSource; reason: null }
  | { source: null; reason: "disabled" | "unsupported" };

/** The URL points somewhere this service must not fetch. A real bad request. */
export class SourceHostForbiddenError extends Error {}
/** Enabled, but the binary is missing — misconfiguration, genuinely a 503. */
export class ResolverUnavailableError extends Error {}
/** Every extraction slot is busy. Temporary and worth retrying. */
export class ResolverBusyError extends Error {}
/** Internal only: turned into a `reason: "unsupported"` outcome by `extract`. */
class SourceUnresolvableError extends Error {}

const cacheKey = (url: string): string => `stream:resolve:${url}`;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Addresses yt-dlp must never be pointed at.
 *
 * `sourceUrl` is attacker-controlled (any community admin can set it) and this
 * service fetches it from INSIDE the cluster, which turns the resolver into a
 * confused deputy: `http://169.254.169.254/` is the cloud metadata endpoint
 * (instance credentials), and `http://10.x` / `127.0.0.1` reach every internal
 * service that trusts the network instead of a token.
 *
 * ponytail: pre-flight DNS check only. It does not close DNS rebinding or an
 * HTTP redirect into private space, because yt-dlp does its own resolution and
 * follows redirects itself. Egress network policy (deny RFC1918 + link-local
 * from this container) is the real control; add it before exposing the
 * resolver to untrusted communities.
 */
export const isForbiddenAddress = (ip: string): boolean => {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    // Link-local (fe80::/10) and unique-local (fc00::/7).
    if (/^fe[89ab]/.test(v6) || /^f[cd]/.test(v6)) return true;
    // IPv4-mapped (::ffff:10.0.0.1) smuggles a private v4 address through.
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isForbiddenAddress(mapped[1]!) : false;
  }

  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local / cloud metadata.
  if (a === 169 && b === 254) return true;
  // Carrier-grade NAT — routable to the host's own provider network.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return a >= 224;
};

/**
 * Turns a watch-page URL into a direct media URL, for hosts that publish no
 * embeddable player.
 *
 * This exists so the website, Android and iOS share ONE definition of "what
 * plays": the clients keep their platform-embed shortcut for the big hosts
 * (that path keeps the host's own player, ads and view count, which is both
 * cheaper and the sanctioned way to embed) and fall back here for everything
 * else.
 *
 * Extraction cannot reach DRM-protected catalogues (Netflix, Disney+, Prime)
 * and is not meant to: those are encrypted under keys only a licensed CDM
 * releases. It resolves public, unencrypted media only.
 */
export class MediaResolverService {
  /**
   * Extractions in flight, keyed by URL. Two viewers opening the same stream
   * at once would otherwise fork two identical yt-dlp processes; the second
   * awaits the first instead.
   */
  private readonly inFlight = new Map<string, Promise<ResolveOutcome>>();

  private running = 0;

  constructor(private readonly redis: typeof RedisClient) {}

  get enabled(): boolean {
    return env.YTDLP_ENABLED;
  }

  async resolve(sourceUrl: string): Promise<ResolveOutcome> {
    // Not an error: the deployment simply has no extractor, and the caller is
    // expected to fall back to its own platform-embed handling.
    if (!env.YTDLP_ENABLED) return { source: null, reason: "disabled" };

    const url = sourceUrl.trim();
    await this.assertPublicHost(url);

    const cached = await this.readCache(url);
    if (cached) return { source: cached, reason: null };

    const existing = this.inFlight.get(url);
    if (existing) return existing;

    const task = this.extract(url).finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, task);
    return task;
  }

  private async assertPublicHost(url: string): Promise<void> {
    let hostname: string;
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("scheme");
      hostname = parsed.hostname;
    } catch {
      throw new SourceHostForbiddenError();
    }

    // A literal IP never reaches DNS, so it is checked directly.
    if (isIP(hostname)) {
      if (isForbiddenAddress(hostname)) throw new SourceHostForbiddenError();
      return;
    }

    let addresses: { address: string }[];
    try {
      addresses = await lookup(hostname, { all: true });
    } catch {
      throw new SourceHostForbiddenError();
    }
    // `all` matters: a host that answers with one public and one private
    // address would pass a check that only looked at the first record.
    if (addresses.some((entry) => isForbiddenAddress(entry.address))) {
      throw new SourceHostForbiddenError();
    }
  }

  private async readCache(url: string): Promise<ResolvedSource | null> {
    if (!isStreamCacheReady()) return null;
    try {
      const raw = await this.redis.get(cacheKey(url));
      return raw ? (JSON.parse(raw) as ResolvedSource) : null;
    } catch {
      // A cache miss and a broken cache are the same thing to the caller.
      return null;
    }
  }

  private async writeCache(url: string, value: ResolvedSource): Promise<void> {
    if (!isStreamCacheReady()) return;
    try {
      await this.redis.set(
        cacheKey(url),
        JSON.stringify(value),
        "EX",
        env.YTDLP_CACHE_TTL_SEC
      );
    } catch (error) {
      logger.warn(`stream: resolver cache write failed — ${String(error)}`);
    }
  }

  private async extract(url: string): Promise<ResolveOutcome> {
    if (this.running >= env.YTDLP_MAX_CONCURRENCY) {
      throw new ResolverBusyError();
    }
    this.running += 1;

    let stdout: string;
    try {
      // execFile, never a shell: the URL is untrusted and reaches argv
      // directly, so there is no command line for it to break out of.
      ({ stdout } = await execFileAsync(
        env.YTDLP_PATH,
        [
          "--dump-single-json",
          "--no-playlist",
          "--no-warnings",
          // A playlist or channel page would otherwise walk every entry.
          "--playlist-items",
          "1",
          url,
        ],
        {
          timeout: env.YTDLP_TIMEOUT_MS,
          // Format lists on big platforms run to several MB of JSON.
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
        }
      ));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      // ENOENT means the binary is missing — an operator problem, not a bad
      // link, and worth separating so the client can fall back quietly.
      if (code === "ENOENT") {
        logger.error(
          `stream: ${env.YTDLP_PATH} not found — set YTDLP_ENABLED=false or install it`
        );
        throw new ResolverUnavailableError();
      }
      // A private, region-locked or simply unsupported link lands here. That is
      // expected traffic, so it is reported as an outcome rather than a fault.
      logger.warn(`stream: yt-dlp extraction failed — ${String(error)}`);
      return { source: null, reason: "unsupported" };
    } finally {
      this.running -= 1;
    }

    let resolved: ResolvedSource;
    try {
      resolved = selectPlayableFormat(stdout);
    } catch {
      return { source: null, reason: "unsupported" };
    }
    await this.writeCache(url, resolved);
    return { source: resolved, reason: null };
  }
}

/**
 * Chooses the one playable rendition from a yt-dlp `--dump-single-json` blob.
 *
 * Pure and exported so the selection rules are testable without a network or
 * the binary. The two ways this degrades are both silent: picking a
 * video-only rendition plays with no sound, and picking a progressive URL for
 * a live source plays a stale fragment. Neither surfaces as an error.
 */
export const selectPlayableFormat = (stdout: string): ResolvedSource => {
  let info: YtDlpInfo;
  try {
    info = JSON.parse(stdout) as YtDlpInfo;
  } catch {
    throw new SourceUnresolvableError();
  }

  const isLive = info.is_live === true;
  const formats = Array.isArray(info.formats)
    ? (info.formats as YtDlpFormat[])
    : [];

  // Only muxed formats are usable. A video-only rendition would need ffmpeg
  // to be married to its audio track, and this service deliberately does no
  // transcoding — that is the re-stream tier, not this one.
  const playable = formats.filter(
    (f) =>
      str(f.url) !== null &&
      f.vcodec !== "none" &&
      f.acodec !== "none" &&
      (num(f.height) ?? 0) <= env.YTDLP_MAX_HEIGHT
  );

  const isHlsFormat = (f: YtDlpFormat): boolean =>
    String(f.protocol ?? "").startsWith("m3u8") ||
    str(f.url)?.includes(".m3u8") === true;

  const score = (f: YtDlpFormat): number =>
    (num(f.height) ?? 0) * 1000 + (num(f.tbr) ?? 0);

  // A live source only has a coherent "now" through its manifest; a
  // progressive URL of a live stream is either absent or a stale fragment.
  const preferred = isLive
    ? (playable.filter(isHlsFormat).sort((a, b) => score(b) - score(a))[0] ??
      playable.sort((a, b) => score(b) - score(a))[0])
    : (playable
        .filter((f) => f.ext === "mp4" && !isHlsFormat(f))
        .sort((a, b) => score(b) - score(a))[0] ??
      playable.sort((a, b) => score(b) - score(a))[0]);

  // Some extractors return no `formats` array at all and put the single
  // playable URL on the info object itself.
  // Adaptive-only sources publish NO muxed rendition at all — every entry is
  // video-only or audio-only, and pairing them is an ffmpeg merge this service
  // deliberately does not do. (Real YouTube output: 53 formats, 0 muxed.) They
  // do share ONE HLS master playlist, which carries both tracks and which
  // hls.js, AVPlayer and ExoPlayer each adapt on their own — so the manifest,
  // not any single track, is the playable answer. Without this the resolver
  // rejected every adaptive host as unplayable.
  const masterManifest = formats.reduce<string | null>(
    (found, f) => found ?? str(f.manifest_url),
    null
  );

  const chosenUrl = str(preferred?.url) ?? masterManifest ?? str(info.url);
  if (!chosenUrl) throw new SourceUnresolvableError();

  return {
    kind:
      (preferred && isHlsFormat(preferred)) ||
      chosenUrl === masterManifest ||
      chosenUrl.includes(".m3u8")
        ? "hls"
        : "video",
    url: chosenUrl,
    title: str(info.title),
    thumbnail: str(info.thumbnail),
    durationSec: num(info.duration),
    isLive,
    expiresAt: new Date(
      Date.now() + env.YTDLP_CACHE_TTL_SEC * 1000
    ).toISOString(),
  };
};
