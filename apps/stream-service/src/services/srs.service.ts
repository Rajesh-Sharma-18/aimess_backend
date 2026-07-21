import { logger } from "@aimess/logger";

import { env } from "../config/env.js";

export interface IngestEndpoints {
  /** WebRTC (WHIP) publish URL — present only when `whip` is an allowed mode. */
  whipUrl?: string;
  /** RTMP publish URL — present only when `rtmp` is an allowed mode. */
  rtmpUrl?: string;
}

export interface PlaybackUrls {
  flvUrl: string;
  hlsUrl: string;
  dashUrl: string;
}

/**
 * SRS (OSSRS) integration helper. Mints the publish/playback URLs handed to a
 * creator/viewer and best-effort terminates a publisher on a manual stop.
 *
 * NOTE (kick API shape, verified against a live SRS instance): `/api/v1/streams`
 * is read-only — DELETEing a stream id returns 405 and does NOT disconnect the
 * publisher. The actual kick lives on the *clients* resource: `GET
 * /api/v1/clients/` lists every open connection (publishers AND viewers) with
 * its own connection id, a `name` (stream key) and a `publish` flag; `DELETE
 * /api/v1/clients/:id` closes that one connection. `kickStream` must match on
 * `name === streamKey && publish === true` — matching on stream name alone
 * risks kicking a viewer's client instead of the publisher. The call is
 * best-effort and never throws — SRS also fires `on_unpublish` when the
 * publisher actually drops, which is the authoritative ENDED signal.
 */
export class SrsService {
  private readonly ingestModes: Set<string>;
  /** Basic Auth header for SRS's http_api — omitted when no credentials are set. */
  private readonly apiAuthHeaders: Record<string, string>;

  constructor() {
    this.ingestModes = new Set(
      env.STREAM_INGEST_MODES.split(",")
        .map((m) => m.trim().toLowerCase())
        .filter(Boolean)
    );
    this.apiAuthHeaders =
      env.SRS_API_USERNAME && env.SRS_API_PASSWORD
        ? {
            Authorization: `Basic ${Buffer.from(
              `${env.SRS_API_USERNAME}:${env.SRS_API_PASSWORD}`
            ).toString("base64")}`,
          }
        : {};
  }

  buildIngestEndpoints(streamKey: string): IngestEndpoints {
    const endpoints: IngestEndpoints = {};
    if (this.ingestModes.has("whip")) {
      endpoints.whipUrl = `${env.SRS_WHIP_BASE}/rtc/v1/whip/?app=live&stream=${streamKey}`;
    }
    if (this.ingestModes.has("rtmp")) {
      endpoints.rtmpUrl = `rtmp://${env.SRS_RTMP_HOST}/live/${streamKey}`;
    }
    return endpoints;
  }

  buildPlaybackUrls(streamKey: string): PlaybackUrls {
    return {
      flvUrl: `${env.SRS_HLS_BASE}/live/${streamKey}.flv`,
      hlsUrl: `${env.SRS_HLS_BASE}/live/${streamKey}.m3u8`,
      dashUrl: `${env.SRS_HLS_BASE}/live/${streamKey}.mpd`,
    };
  }

  /**
   * Checks whether SRS has actually received video frames for `streamKey` yet —
   * used to bridge the gap between "publish accepted" (on_publish fires at the
   * RTMP handshake, before any media has flowed) and "HLS/FLV actually has
   * something to serve". Returns false (never throws) on any lookup failure,
   * so callers naturally keep polling instead of misreading a transient error
   * as "not live".
   */
  async hasFrames(streamKey: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const listRes = await fetch(`${env.SRS_API_URL}/api/v1/streams/`, {
        method: "GET",
        headers: this.apiAuthHeaders,
        signal: controller.signal,
      });
      if (!listRes.ok) return false;
      const body = (await listRes.json()) as {
        streams?: Array<{ name?: string; frames?: number }>;
      };
      const match = (body.streams ?? []).find((s) => s.name === streamKey);
      return (match?.frames ?? 0) > 0;
    } catch (error) {
      logger.warn(
        `SRS hasFrames check failed for key=${streamKey}: ${String(error)}`
      );
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Every distinct SRS HTTP API base this deployment talks to. One entry on
   * local Docker SRS (single all-in-one instance); two on the hosted topology
   * where OBS_RTMP lands on the ingest instance (SRS_INGEST_API_URL / I-01) and
   * everything else on SRS_API_URL (I-02). Deduped so a local setup that leaves
   * SRS_INGEST_API_URL unset (or equal) isn't scanned twice.
   */
  private apiBases(): string[] {
    const bases = [env.SRS_API_URL];
    if (env.SRS_INGEST_API_URL && env.SRS_INGEST_API_URL !== env.SRS_API_URL) {
      bases.push(env.SRS_INGEST_API_URL);
    }
    return bases;
  }

  /**
   * Every publisher SRS currently has open, across all API bases, as
   * `{ apiBase, streamKey, clientId }`. Backs the reconciler that repairs
   * DB↔SRS drift when a kick silently failed.
   *
   * Returns `null` — NOT an empty array — if ANY instance lookup fails. The
   * caller cannot distinguish "SRS genuinely has no publishers" from "SRS is
   * unreachable" otherwise, and acting on a false empty would mean treating
   * every live stream as orphaned during a transient API blip.
   */
  async listPublishers(): Promise<
    { apiBase: string; streamKey: string; clientId: string }[] | null
  > {
    const found: { apiBase: string; streamKey: string; clientId: string }[] =
      [];

    for (const apiBase of this.apiBases()) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${apiBase}/api/v1/clients/`, {
          method: "GET",
          headers: this.apiAuthHeaders,
          signal: controller.signal,
        });
        if (!res.ok) {
          logger.warn(
            `SRS listPublishers: ${apiBase} returned ${String(res.status)} — skipping reconcile pass`
          );
          return null;
        }
        const body = (await res.json()) as {
          clients?: Array<{ id?: string; name?: string; publish?: boolean }>;
        };
        for (const client of body.clients ?? []) {
          if (client.publish !== true || !client.name || !client.id) continue;
          found.push({
            apiBase,
            streamKey: client.name,
            clientId: client.id,
          });
        }
      } catch (error) {
        logger.warn(
          `SRS listPublishers failed for ${apiBase}: ${String(error)} — skipping reconcile pass`
        );
        return null;
      } finally {
        clearTimeout(timeout);
      }
    }

    return found;
  }

  /**
   * Close one already-resolved SRS connection by id. Used by the reconciler,
   * which already knows the client id and its owning instance from
   * {@link listPublishers} and so must not re-run the name lookup
   * {@link kickStream} does. Best-effort; never throws.
   */
  async kickClientById(apiBase: string, clientId: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${apiBase}/api/v1/clients/${clientId}`, {
        method: "DELETE",
        headers: this.apiAuthHeaders,
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn(
          `SRS kickClientById: delete returned ${String(res.status)} for client=${clientId}`
        );
        return false;
      }
      return true;
    } catch (error) {
      logger.warn(
        `SRS kickClientById failed for client=${clientId}: ${String(error)}`
      );
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Best-effort: ask SRS to drop the publisher for `streamKey`. Resolves the
   * publisher's connection id by name via the clients API, then DELETEs it.
   * Swallows all errors (logs a warning) — bounded by a 5s AbortController.
   *
   * `sourceType` picks which SRS instance to hit: OBS_RTMP publishes directly
   * into the instance behind SRS_INGEST_API_URL (falls back to SRS_API_URL
   * when unset, e.g. local Docker SRS's single all-in-one instance); every
   * other source (PHONE_CAMERA/WHIP, URL, YOUTUBE) publishes into the
   * instance behind SRS_API_URL. Hitting the wrong instance finds nothing (or
   * a forwarded copy) and silently no-ops instead of kicking the real
   * publisher — see the hosted 3-instance topology this was built for.
   */
  async kickStream(streamKey: string, sourceType: string): Promise<void> {
    const apiBase =
      sourceType === "OBS_RTMP"
        ? (env.SRS_INGEST_API_URL ?? env.SRS_API_URL)
        : env.SRS_API_URL;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const listRes = await fetch(`${apiBase}/api/v1/clients/`, {
        method: "GET",
        headers: this.apiAuthHeaders,
        signal: controller.signal,
      });
      if (!listRes.ok) {
        logger.warn(
          `SRS kickStream: list clients returned ${String(listRes.status)} for key=${streamKey}`
        );
        return;
      }
      const body = (await listRes.json()) as {
        clients?: Array<{ id?: string; name?: string; publish?: boolean }>;
      };
      const match = (body.clients ?? []).find(
        (c) => c.name === streamKey && c.publish === true
      );
      if (!match?.id) {
        // No live publisher under that key — nothing to kick.
        return;
      }
      const delRes = await fetch(`${apiBase}/api/v1/clients/${match.id}`, {
        method: "DELETE",
        headers: this.apiAuthHeaders,
        signal: controller.signal,
      });
      if (!delRes.ok) {
        logger.warn(
          `SRS kickStream: delete returned ${String(delRes.status)} for key=${streamKey}`
        );
      }
    } catch (error) {
      logger.warn(
        `SRS kickStream failed for key=${streamKey}: ${String(error)}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
