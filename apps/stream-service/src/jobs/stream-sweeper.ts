import { logger } from "@aimess/logger";

import type { LivestreamService } from "../services/livestream.service.js";

const SWEEP_INTERVAL_MS = 30_000; // check every 30 s

/**
 * Start the stream sweeper. Every 30 s it reconciles the DB with SRS,
 * finalizes RECONNECTING streams past the reconnect grace, expires stale
 * PENDING streams, and polls OBS stream quality. It never ends a LIVE stream.
 *
 * Returns a cleanup function that stops the interval (useful for graceful shutdown).
 */
export function startStreamSweeper(
  livestreamService: LivestreamService
): () => void {
  logger.info(`Stream sweeper started (interval=${SWEEP_INTERVAL_MS}ms)`);

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
