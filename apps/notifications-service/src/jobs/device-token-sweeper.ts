import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { deviceTokenService } from "../services/device-token.service.js";

/**
 * Stale device-token sweeper.
 *
 * Every explicit teardown path (logout, remote sign-out, sign-out-all, password
 * change/reset, token-reuse detection, admin ban, account deletion) publishes a
 * session event that deletes the row, and the send path prunes anything FCM or
 * APNs reports dead. This sweep exists for what neither can see:
 *
 *   - a refresh token that simply timed out and was never used again — nothing
 *     revokes it, so no event is ever published for it,
 *   - an uninstalled app or a browser that cleared site data before FCM notices,
 *   - the bound on any event lost while RabbitMQ was unreachable.
 *
 * `lastSeenAt` is the liveness signal: it is stamped at registration (every
 * client re-registers on mount / app launch) and refreshed on a successful
 * push, throttled to once a day. A token unseen by BOTH for
 * `DEVICE_TOKEN_TTL_DAYS` is assumed gone.
 *
 * Safety / scale:
 *   - a Redis lock de-duplicates the tick across replicas; the delete is a
 *     single idempotent `deleteMany`, so a lost lock costs nothing,
 *   - never overlaps itself on one instance,
 *   - fully best-effort: a failed tick logs and retries on the next interval.
 */
const LOCK_KEY = "notifications:device-token-sweeper:lock";

let timer: NodeJS.Timeout | null = null;
let running = false;

async function acquireLock(ttlMs: number): Promise<boolean> {
  try {
    return (await redis.set(LOCK_KEY, "1", "PX", ttlMs, "NX")) === "OK";
  } catch {
    // Redis unavailable — run anyway; deleteMany is idempotent.
    return true;
  }
}

export async function runDeviceTokenSweepOnce(): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const ttl = Math.max(5_000, env.DEVICE_TOKEN_SWEEPER_INTERVAL_MS - 5_000);
    if (!(await acquireLock(ttl))) return 0;

    const removed = await deviceTokenService.sweepStaleTokens(
      env.DEVICE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
    );
    if (removed > 0) {
      logger.info(
        `Device-token sweep removed ${String(removed)} token(s) unseen for ` +
          `${String(env.DEVICE_TOKEN_TTL_DAYS)} day(s)`
      );
    }
    return removed;
  } catch (error) {
    logger.warn("Device-token sweep failed");
    logger.warn(error);
    return 0;
  } finally {
    running = false;
  }
}

export function startDeviceTokenSweeper(): void {
  if (timer) return;
  timer = setInterval(
    () => void runDeviceTokenSweepOnce(),
    env.DEVICE_TOKEN_SWEEPER_INTERVAL_MS
  );
  // Never keep the process alive just for the sweep.
  if (typeof timer.unref === "function") timer.unref();
  logger.info(
    `Device-token sweeper started (every ` +
      `${String(env.DEVICE_TOKEN_SWEEPER_INTERVAL_MS)}ms, TTL ` +
      `${String(env.DEVICE_TOKEN_TTL_DAYS)} days)`
  );
}

export function stopDeviceTokenSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
