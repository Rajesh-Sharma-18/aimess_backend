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
}

/**
 * SRS (OSSRS) integration helper. Mints the publish/playback URLs handed to a
 * creator/viewer and best-effort terminates a publisher on a manual stop.
 *
 * NOTE (kick API shape): SRS exposes `GET /api/v1/streams` to enumerate live
 * streams (each carries a numeric `id`) and `DELETE /api/v1/clients/:id` /
 * `DELETE /api/v1/streams/:id` to kick. There is no documented "delete by
 * stream name" endpoint, so `kickStream` resolves the stream id by name first,
 * then issues the DELETE. The whole call is best-effort and never throws — SRS
 * also fires `on_unpublish` when the publisher actually drops, which is the
 * authoritative ENDED signal.
 */
export class SrsService {
  private readonly ingestModes: Set<string>;

  constructor() {
    this.ingestModes = new Set(
      env.STREAM_INGEST_MODES.split(",")
        .map((m) => m.trim().toLowerCase())
        .filter(Boolean)
    );
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
    };
  }

  /**
   * Best-effort: ask SRS to drop the publisher for `streamKey`. Resolves the
   * numeric stream id by name via the streams API, then DELETEs it. Swallows
   * all errors (logs a warning) — bounded by a 5s AbortController.
   */
  async kickStream(streamKey: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const listRes = await fetch(`${env.SRS_API_URL}/api/v1/streams/`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!listRes.ok) {
        logger.warn(
          `SRS kickStream: list streams returned ${String(listRes.status)} for key=${streamKey}`
        );
        return;
      }
      const body = (await listRes.json()) as {
        streams?: Array<{ id?: string | number; name?: string }>;
      };
      const match = (body.streams ?? []).find((s) => s.name === streamKey);
      if (!match?.id) {
        // No live publisher under that key — nothing to kick.
        return;
      }
      const delRes = await fetch(
        `${env.SRS_API_URL}/api/v1/streams/${String(match.id)}`,
        { method: "DELETE", signal: controller.signal }
      );
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
