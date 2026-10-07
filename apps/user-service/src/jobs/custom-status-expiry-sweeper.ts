import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";
import { customStatusService } from "../services/custom-status.service.js";

const LOCK_KEY = "user:custom-status-sweeper:lock";
const INTERVAL_MS = 30_000;
const BATCH_SIZE = 500;
const MAX_BATCHES_PER_TICK = 20;

let timer: NodeJS.Timeout | null = null;
let running = false;

// Redis down → run lock-free; the atomic claim keeps emits exactly-once.
async function acquireLock(): Promise<boolean> {
  try {
    return (await redis.set(LOCK_KEY, "1", "PX", INTERVAL_MS - 5_000, "NX")) === "OK";
  } catch {
    return true;
  }
}

export async function runCustomStatusSweepOnce(): Promise<number> {
  if (running) return 0;
  running = true;
  let total = 0;
  try {
    if (!(await acquireLock())) return 0;
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      const n = await customStatusService.expireDue(BATCH_SIZE);
      total += n;
      if (n < BATCH_SIZE) break;
    }
    if (total > 0) logger.info(`Custom status sweep expired ${total} status(es)`);
    await redis.del(LOCK_KEY).catch(() => undefined);
  } catch (err) {
    logger.warn("Custom status sweep failed");
    logger.warn(err);
  } finally {
    running = false;
  }
  return total;
}

export function startCustomStatusExpirySweeper(): void {
  if (timer) return;
  timer = setInterval(() => void runCustomStatusSweepOnce(), INTERVAL_MS);
  timer.unref();
  logger.info(`Custom status expiry sweeper started (every ${INTERVAL_MS}ms)`);
}
