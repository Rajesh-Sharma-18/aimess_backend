import { createHash, createHmac } from "node:crypto";

import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { streamKeyRef } from "../lib/stream-key-ref.js";
import type { IngestEndpoints, PlaybackUrls } from "./srs.service.js";

/**
 * Impossible to miss in a scrolling terminal — same purpose as the SRS hook's
 * own banner (`routes/internal.routes.ts`), here for the one call whose only
 * job is proving CDN_API_USERNAME/CDN_API_KEY actually work.
 */
function logStreamStatusBanner(message: string): void {
  logger.info("========== AIMESS_CDN_STREAM_STATUS ==========");
  logger.info(message);
  logger.info("========== AIMESS_CDN_STREAM_STATUS_END ======");
}

/** Value stored in `Livestream.provider` for CDN-ingested streams. */
export const CDN_PROVIDER = "CDN";
/** Value stored in `Livestream.provider` for SRS-ingested streams (the default). */
export const SRS_PROVIDER = "SRS";

/** One row of the CDN's per-stream quality snapshot. */
export interface CdnStreamStat {
  resolution: string | null;
  bitrateKbps: number | null;
  fps: number | null;
  /**
   * Viewers the CDN itself counts for this stream (`hists`).
   *
   * Measured against a live stream with 3 HLS + 2 FLV viewers: it reported 5,
   * so it DOES include HLS despite the doc's "excluding HLS" note on real-time
   * data. It lags though — 0 at t+65s, correct at t+143s — so it is a
   * platform-wide figure for reporting, not a live badge.
   */
  viewers: number | null;
}

/**
 * A row with no `provider` predates the CDN split and is SRS — the column is
 * nullable precisely so existing documents keep reading (see schema.prisma).
 */
export function isCdnStream(stream: { provider?: string | null }): boolean {
  return stream.provider === CDN_PROVIDER;
}

/**
 * The CDN has no connection id. Its callbacks carry `milltime`, an event
 * timestamp, which we store in `publisherClientId` behind a `cdn:` prefix so it
 * is never mistaken for an SRS client id. Used ONLY to drop a late End whose
 * timestamp predates the Start currently on air — never fed into
 * `handleUnpublish`'s equality check, which would mismatch on every End.
 */
export function cdnPublisherId(eventMs: number): string {
  return `cdn:${eventMs}`;
}

export function cdnPublisherMs(publisherClientId?: string | null): number | null {
  if (!publisherClientId?.startsWith("cdn:")) return null;
  const ms = Number(publisherClientId.slice(4));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * CDNetworks Media Acceleration Live Broadcast integration — the RTMP-ingest
 * counterpart of {@link SrsService}.
 *
 * What this product does NOT have, and why the shape differs from SRS:
 * - No create-stream API. A stream exists the moment an encoder pushes to
 *   `rtmp://<push domain>/<app>/<name>`, so there is nothing to provision.
 * - No kick/disconnect API. `finalizeAsEnded` therefore skips the kick for CDN
 *   rows; the encoder is evicted on its next reconnect by the remote-auth
 *   endpoint instead (see LivestreamService.authorizeCdnPublish).
 * - No WHIP. WebRTC is a separate CDNetworks product that is not enabled, so
 *   browser-camera streams stay on SRS and `buildIngestEndpoints` mints RTMP only.
 * - Lifecycle events arrive as console-configured HTTP callbacks (start/end),
 *   not as hooks we can deny, and there is no "reconnecting" event.
 *
 * Every method degrades to "unconfigured" rather than throwing, so the service
 * boots and runs with all CDN_* vars blank — which is the state until the
 * vendor account is provisioned.
 */
export class CdnService {
  /** True once both domains are set; false disables CDN provider selection. */
  isConfigured(): boolean {
    return Boolean(env.CDN_PUSH_DOMAIN && env.CDN_PLAYBACK_BASE);
  }

  /** True once API credentials exist; false makes {@link listPublishing} a no-op. */
  isApiConfigured(): boolean {
    return Boolean(env.CDN_API_USERNAME && env.CDN_API_KEY);
  }

  /** True when {@link probeLive} may stand in for the status API. */
  isProbeEnabled(): boolean {
    return env.CDN_PLAYBACK_PROBE;
  }

  /**
   * Liveness by asking the CDN for the stream's own playlist — the fallback for
   * an account with no status API and no working callbacks.
   *
   * Observed behaviour on the delivery domain:
   *   publishing now      -> 200 with a playlist
   *   published, stopped  -> 404, fast
   *   never published     -> no response at all (the request hangs)
   *
   * So only a 200 counts as live, and the timeout doubles as the answer for the
   * hanging case. The body is discarded: the status line is the whole signal.
   */
  async probeLive(playbackUrl: string | null | undefined): Promise<boolean> {
    if (!playbackUrl) return false;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      env.CDN_PLAYBACK_PROBE_TIMEOUT_MS
    );
    try {
      const res = await fetch(playbackUrl, {
        // HEAD is not answered consistently by the edge; a GET's headers arrive
        // just as fast and the body is cancelled below.
        method: "GET",
        // Node sends no User-Agent of its own, and the edge treats such a
        // request differently from a player's — it holds the connection open
        // instead of answering.
        headers: { "user-agent": "aimess-stream-service/1 (liveness-probe)" },
        signal: controller.signal,
      });
      void res.body?.cancel();
      return res.ok;
    } catch {
      // Timeout, DNS, TLS — all "we cannot say it is live", which is the only
      // safe reading for a signal that ends broadcasts.
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Timestamp anti-hotlinking, as configured under Access Control > Token
   * Authentication on the CDN domain. ONE formula — `md5(KEY + PATH + TIME)`
   * with the console's component order set to KEY+PATH+TIME — rather than a
   * matrix of orders: the console is the thing that has to match us, and a
   * mismatch is a publish/playback failure either way.
   *
   * Returns null when no key is configured, in which case URLs carry no auth
   * params at all (valid: the feature is off on the domain until we enable it).
   */
  private tokenParams(path: string): string {
    if (!env.CDN_TOKEN_KEY) return "";
    const seconds = Math.floor(Date.now() / 1000) + env.CDN_TOKEN_TTL_SEC;
    const time = env.CDN_TOKEN_TIME_HEX
      ? seconds.toString(16)
      : String(seconds);
    const signature = createHash("md5")
      .update(`${env.CDN_TOKEN_KEY}${path}${time}`)
      .digest("hex");
    return `wsSecret=${signature}&wsTime=${time}`;
  }

  private streamPath(name: string): string {
    return `/${env.CDN_APP}/${name}`;
  }

  /**
   * Where the OWNER publishes. Same URL shape as the SRS RTMP endpoint
   * (`rtmp://host/<app>/<name>?secret=<streamKey>`) so every client that splits
   * it — the website's `splitRtmpUrl`, iOS's `LiveStreamRepository`, OBS itself
   * — keeps working unchanged; Android passes it through opaquely.
   *
   * The publish secret rides along whether or not remote auth is switched on:
   * the CDN forwards the query string to the remote-auth endpoint as part of
   * `url`, which is the only place it can be checked.
   */
  buildIngestEndpoints(name: string, publishSecret: string): IngestEndpoints {
    const secret = encodeURIComponent(publishSecret);
    const token = this.tokenParams(this.streamPath(name));
    const query = token ? `?secret=${secret}&${token}` : `?secret=${secret}`;
    return {
      rtmpUrl: `rtmp://${env.CDN_PUSH_DOMAIN}/${env.CDN_APP}/${name}${query}`,
    };
  }

  /**
   * Where VIEWERS play from. HLS and HTTP-FLV only — this product has no DASH
   * output, hence the nullable `dashUrl`.
   *
   * NOTE: `CDN_PLAYBACK_BASE` must never point at localhost. The website
   * discards any playback URL that looks local (`isLocalSrsUrl` in
   * `utils/srs.ts`) and silently rebuilds it against the SRS base.
   */
  buildPlaybackUrls(name: string): PlaybackUrls {
    const base = env.CDN_PLAYBACK_BASE.replace(/\/+$/, "");
    const token = this.tokenParams(this.streamPath(name));
    const query = token ? `?${token}` : "";
    return {
      hlsUrl: `${base}/${env.CDN_APP}/${name}.m3u8${query}`,
      flvUrl: `${base}/${env.CDN_APP}/${name}.flv${query}`,
      dashUrl: null,
    };
  }

  /**
   * CDNetworks API auth: Basic, where the password is a per-request HMAC of the
   * `Date` header rather than a static secret. The header must be within 15
   * minutes of the platform clock or every call 401s.
   */
  private apiHeaders(): Record<string, string> {
    const date = new Date().toUTCString();
    const password = createHmac("sha1", env.CDN_API_KEY)
      .update(date)
      .digest("base64");
    return {
      Date: date,
      // Normalises every timestamp in the response; the account default is GMT+08:00.
      "X-Time-Zone": "GMT+00:00",
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(
        `${env.CDN_API_USERNAME}:${password}`
      ).toString("base64")}`,
    };
  }

  /**
   * Every stream currently publishing to the ingest domain, with its quality
   * snapshot. Backs the CDN half of the sweeper: presence recovers a dropped
   * start callback, prolonged absence recovers a dropped end callback, and the
   * stats replace the per-stream SRS quality poll.
   *
   * Returns **null** — never an empty map — when credentials are missing or the
   * call fails, so the reconciler cannot read a degraded reply as "nothing is
   * publishing" and end live streams. Same discipline as
   * `SrsService.listPublishers`.
   *
   * Real-time mode lags roughly 30 s, which is why the CDN reconnect grace is
   * longer than the SRS one.
   */
  async listPublishing(): Promise<Map<string, CdnStreamStat> | null> {
    if (!this.isConfigured() || !this.isApiConfigured()) return null;

    const url =
      `${env.CDN_API_BASE.replace(/\/+$/, "")}/api/quality/stream-status-statistic` +
      `?u=${encodeURIComponent(env.CDN_PUSH_DOMAIN)}&d=push&realtime=true&g=10`;

    // Loud on purpose, both ends. This call is the only proof
    // CDN_API_USERNAME/CDN_API_KEY actually work — silent on success made that
    // unverifiable without reading source, and the sweeper calls this every
    // 30s regardless of whether a stream is live, so "did it ever fire" was
    // its own open question.
    logStreamStatusBanner(`CALLING ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        headers: this.apiHeaders(),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Logged with the status because the most likely failure is silent:
        // an undici-stripped `Date` header makes the HMAC unverifiable and
        // every call 401s while everything else keeps working.
        logStreamStatusBanner(
          `FAILED — HTTP ${res.status} ${res.statusText}. Check CDN_API_USERNAME/CDN_API_KEY.`
        );
        return null;
      }
      const body = (await res.json()) as {
        dataValue?: {
          streamname?: string;
          inbandwidth?: number;
          fps?: number;
          resolution?: string;
          /** Online viewers, the vendor's own count. */
          hists?: number;
        }[];
      };
      const rows = Array.isArray(body.dataValue) ? body.dataValue : [];
      const stats = new Map<string, CdnStreamStat>();
      for (const row of rows) {
        // `streamname` is documented as the channel and observed both bare and
        // as `<domain>/<app>/<name>` — key on the last segment either way.
        const name = (row.streamname ?? "").split("/").pop() ?? "";
        if (!name) continue;
        stats.set(name, {
          resolution: row.resolution ? row.resolution.replace("*", "x") : null,
          bitrateKbps:
            typeof row.inbandwidth === "number"
              ? Math.round(row.inbandwidth / 1000)
              : null,
          fps: typeof row.fps === "number" ? row.fps : null,
          viewers: typeof row.hists === "number" ? row.hists : null,
        });
      }
      // Logs even with 0 rows: an authenticated-but-empty reply is still proof
      // the auth worked, and looks identical to a 401 otherwise.
      logStreamStatusBanner(
        `SUCCESS — ${stats.size} stream(s) publishing on ${env.CDN_PUSH_DOMAIN}` +
          (stats.size
            ? `: ${[...stats.entries()].map(([name, s]) => `${name}=${s.resolution ?? "?"}@${s.bitrateKbps ?? "?"}kbps/${s.fps ?? "?"}fps viewers(hists)=${s.viewers ?? "?"}`).join(", ")}`
            : "")
      );
      return stats;
    } catch (error) {
      logStreamStatusBanner(`FAILED — ${String(error)}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Force a publisher off the CDN — the MALB `StopLivestreaming` API
   * (`POST /api/live/stop`, `type=publish`). This is the disconnect we thought
   * MALB lacked: it cuts an encoder that is still pushing after we have ended a
   * stream on our side (host left OBS running, admin force-end, ban).
   *
   * Two hard limits, both from the vendor, both the caller's problem to respect:
   * - **1 call per 5 minutes** (plus a daily cap). So this is wired ONLY into
   *   the explicit end paths, never the sweeper's natural-end path — a stream
   *   that ended because OBS already dropped has nothing to kick and must not
   *   spend the budget.
   * - It registers a **forbid** (see `QueryForbidLivestreamRecord`), so the
   *   stream may be blocked from re-publishing for a period. Fine for the
   *   moderation/force-end intent; do not call it where the same host is
   *   expected to go live again immediately.
   *
   * The `liveUrl` is the bare push URL with NO query string — the API reads
   * only the part before `?`, so the publish secret is neither needed nor sent.
   * Best-effort: logs and returns false on any failure, never throws into the
   * end path.
   */
  async stopPublishing(name: string): Promise<boolean> {
    if (!this.isConfigured() || !this.isApiConfigured()) return false;

    const liveUrl = `rtmp://${env.CDN_PUSH_DOMAIN}/${env.CDN_APP}/${name}`;
    const url = `${env.CDN_API_BASE.replace(/\/+$/, "")}/api/live/stop`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...this.apiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ liveUrl, type: "publish" }),
        signal: controller.signal,
      });
      const text = await res.text();
      // The vendor answers 200 with a `{code,message}` body even on a logical
      // failure (bad URL, rate-limited, "too many urls today"), so surface the
      // body, not just the HTTP status. `code: "0"` / message "Success" = ok.
      const ok = res.ok && /"code"\s*:\s*"?0"?|success/i.test(text);
      logger.info(
        `CDN stopPublishing name=${streamKeyRef(name)} httpStatus=${res.status} ok=${ok} body=${text.slice(0, 200)}`
      );
      return ok;
    } catch (error) {
      logger.warn(
        `CDN stopPublishing failed for name=${streamKeyRef(name)}: ${String(error)}`
      );
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
