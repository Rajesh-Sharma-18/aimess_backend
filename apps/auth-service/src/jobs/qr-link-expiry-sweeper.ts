import { logger } from "@aimess/logger";
import { publishQrLinkEvent } from "@aimess/redis";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import {
  markExpiredAtomic,
  scanLiveLinkTokens,
} from "../lib/device-link-store.js";
import { recordAuditEventSafe } from "../services/audit.service.js";

/**
 * QR device-link expiry sweeper — the scheduler/cron replacement for the old
 * in-process `setTimeout` (which couldn't survive a restart or coordinate
 * across replicas). Mirrors community-service's mute-sweeper.ts pattern:
 * a periodic `setInterval` tick, a best-effort Redis lock so N replicas don't
 * all redo the same SCAN, and — critically — an ATOMIC per-key claim
 * (`markExpiredAtomic`) so exactly one replica ever wins the PENDING/SCANNED →
 * EXPIRED transition and publishes `auth:qr:expired`, regardless of the lock.
 */

const LOCK_KEY = "auth:qr-link-sweeper:lock";

let timer: NodeJS.Timeout | null = null;
let running = false;

async function acquireLock(ttlMs: number): Promise<boolean> {
  try {
    const res = await redis.set(LOCK_KEY, "1", "PX", ttlMs, "NX");
    return res === "OK";
  } catch {
    return true; // Redis unavailable — rely on the atomic per-key claim.
  }
}

async function releaseLock(): Promise<void> {
  try {
    await redis.del(LOCK_KEY);
  } catch {
    /* lock self-expires via its TTL */
  }
}

async function runOnce(): Promise<void> {
  if (running) return; // never overlap ticks on this instance
  running = true;
  try {
    const ttl = Math.max(5_000, env.QR_LINK_SWEEPER_INTERVAL_MS - 5_000);
    if (!(await acquireLock(ttl))) return; // another instance owns this tick

    const tokens = await scanLiveLinkTokens();
    let expiredCount = 0;

    for (const linkToken of tokens) {
      const result = await markExpiredAtomic(linkToken);
      if (result !== "OK") continue;
      expiredCount++;

      recordAuditEventSafe({
        event: "QR_EXPIRED",
        targetType: "qr_login_session",
        targetId: linkToken,
      });

      void publishQrLinkEvent(redis, linkToken, "auth:qr:expired", {
        linkToken,
      }).catch((err: unknown) =>
        logger.warn(`Failed to publish auth:qr:expired: ${String(err)}`)
      );
    }

    if (expiredCount > 0) {
      logger.info(`QR link sweep expired ${expiredCount} session(s)`);
    }
    await releaseLock();
  } catch (err) {
    logger.warn("QR link expiry sweep failed");
    logger.warn(err);
  } finally {
    running = false;
  }
}

export function startQrLinkExpirySweeper(): void {
  if (!env.QR_LINK_SWEEPER_ENABLED) {
    logger.info(
      "QR link expiry sweeper disabled (QR_LINK_SWEEPER_ENABLED=false)"
    );
    return;
  }
  if (timer) return; // already started
  timer = setInterval(() => void runOnce(), env.QR_LINK_SWEEPER_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  logger.info(
    `QR link expiry sweeper started (every ${env.QR_LINK_SWEEPER_INTERVAL_MS}ms)`
  );
}

export function stopQrLinkExpirySweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info("QR link expiry sweeper stopped");
  }
}

/** Exposed for tests: run exactly one sweep tick synchronously. */
export async function runQrLinkExpirySweepOnce(): Promise<void> {
  await runOnce();
}
