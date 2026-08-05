import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import type { LivestreamService } from "../services/livestream.service.js";

const SWEEP_INTERVAL_MS = 30_000; // check every 30 s

/**
 * Start the stale-stream sweeper. Every 30 s it finds LIVE streams whose host
 * hasn't sent a heartbeat in `STREAM_HEARTBEAT_TIMEOUT_MS` and auto-ends them,
 * firing all the normal ENDED broadcasts (socket, system message, push).
 *
 * Returns a cleanup function that stops the interval (useful for graceful shutdown).
 */
export function startStreamSweeper(
  livestreamService: LivestreamService
): () => void {
  logger.info(
    `Stream sweeper started (interval=${SWEEP_INTERVAL_MS}ms timeout=${env.STREAM_HEARTBEAT_TIMEOUT_MS}ms)`
  );

  const handle = setInterval(() => {
    void livestreamService.sweepStaleStreams().catch((err: unknown) => {
      logger.warn(`Stream sweeper tick failed: ${String(err)}`);
    });
    // Piggyback the OBS quality poll on the same tick — no browser client
    // exists for OBS streams to self-report quality, so this is the only
    // source for it.
    void livestreamService.pollObsStreamQuality().catch((err: unknown) => {
      logger.warn(`OBS quality poll tick failed: ${String(err)}`);
    });
  }, SWEEP_INTERVAL_MS);

  return () => {
    clearInterval(handle);
    logger.info("Stream sweeper stopped");
  };
}
