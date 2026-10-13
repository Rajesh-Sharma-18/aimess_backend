import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { communityService } from "../services/community.service.js";

// Admin inactivity: day-20/27 reminders, day-30 handover. Every step is idempotent
// (claimed reminder stage, conditional adminId handover), so the lock only saves work.
const LOCK_KEY = "community:admin-inactivity:lock";

let timer: NodeJS.Timeout | null = null;
let running = false;

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const owned = await redis
      .set(LOCK_KEY, "1", "PX", 10 * 60_000, "NX")
      .then((r) => r === "OK")
      .catch(() => true);
    if (!owned) return;
    const { reminded, handedOver } =
      await communityService.runAdminInactivitySweep();
    if (reminded + handedOver > 0) {
      logger.info(
        `Admin inactivity sweep: reminded=${reminded} handedOver=${handedOver}`
      );
    }
  } catch (err) {
    logger.warn("Admin inactivity sweep failed");
    logger.warn(err);
  } finally {
    running = false;
  }
}

export function startAdminInactivityJob(): void {
  if (!env.ADMIN_INACTIVITY_JOB_ENABLED || timer) return;
  void runOnce();
  timer = setInterval(
    () => void runOnce(),
    env.ADMIN_INACTIVITY_JOB_INTERVAL_MS
  );
  if (typeof timer.unref === "function") timer.unref();
  logger.info(
    `Admin inactivity job started (every ${env.ADMIN_INACTIVITY_JOB_INTERVAL_MS}ms)`
  );
}
