import { logger } from "@aimess/logger";

import { purgeStaleLoginFailures } from "./admin-login-lockout.js";

/**
 * Prunes admin login-failure rows whose lockout window has closed.
 *
 * The counter used to live in Redis, where expiry was free. Making it durable
 * (so a cache flush cannot clear a lockout on the highest-privilege login on
 * the platform) means nothing removes the rows on its own, and every address a
 * password spray tries once leaves one behind.
 *
 * Hourly is ample: the rows are tiny, and a closed window is already ignored on
 * read, so a late sweep is a storage question and never a correctness one.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export async function runLoginFailureSweepOnce(): Promise<number> {
  const removed = await purgeStaleLoginFailures();
  if (removed > 0) {
    logger.info("pruned stale admin login-failure rows", {
      service: "backoffice-service",
      removed,
    });
  }
  return removed;
}

export function startLoginFailureSweeper(
  intervalMs = SWEEP_INTERVAL_MS
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void runLoginFailureSweepOnce().catch((error: unknown) => {
      logger.warn("admin login-failure sweep failed", {
        service: "backoffice-service",
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalMs);

  // Housekeeping must never be the reason the process stays alive.
  timer.unref();
  return timer;
}
