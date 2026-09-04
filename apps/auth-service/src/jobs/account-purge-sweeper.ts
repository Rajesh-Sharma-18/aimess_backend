import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { tryPublishUserPurged } from "../messaging/publish-user-purged.js";
import { authRepository } from "../repositories/auth.repository.js";
import { recordAuditEventSafe } from "../services/audit.service.js";

/**
 * Erase the personal data of accounts whose deletion grace period has elapsed.
 *
 * `DELETE /api/auth/account` marked the account and revoked its sessions, and
 * recorded a `scheduledDeletionAt` 30 days out — which nothing read. No job
 * existed, so no account was ever actually erased: email, phone, password hash,
 * Google/Apple identities and the whole profile were retained indefinitely, and
 * the "Deleted Account" a user saw was a read-time projection over live data.
 * A user who exercised their right to erasure got a flag.
 *
 * This is the job that reads it. Same shape as the QR link-expiry sweeper next
 * door: a periodic tick, a best-effort Redis lock so N replicas do not all scan,
 * and — the part that actually matters — an atomic per-account claim in
 * `purgeAccount`, so exactly one replica erases each account and publishes its
 * event regardless of the lock.
 */

const LOCK_KEY = "auth:account-purge-sweeper:lock";

let timer: NodeJS.Timeout | null = null;
let running = false;

async function acquireLock(ttlMs: number): Promise<boolean> {
  try {
    const res = await redis.set(LOCK_KEY, "1", "PX", ttlMs, "NX");
    return res === "OK";
  } catch {
    // Redis unavailable — proceed and rely on the atomic per-account claim.
    return true;
  }
}

async function releaseLock(): Promise<void> {
  try {
    await redis.del(LOCK_KEY);
  } catch {
    /* the lock self-expires via its TTL */
  }
}

/**
 * One pass. Exported so it can be driven directly by a test or an operator
 * script without waiting for a tick.
 */
export async function runAccountPurgeOnce(): Promise<{
  purged: number;
  deferred: number;
}> {
  const due = await authRepository.findAccountsDueForPurge(
    new Date(),
    env.ACCOUNT_PURGE_BATCH_SIZE
  );

  let purged = 0;
  let deferred = 0;

  for (const account of due) {
    // Announce FIRST, erase second.
    //
    // If the event cannot be published, every other service would keep that
    // user's personal data with nothing to retry — so the account is left for
    // the next tick instead. Publishing before erasing means the worst case is
    // a consumer purging a moment early, which is harmless: the id is all it
    // needs, and the id does not change.
    const published = await tryPublishUserPurged({
      userId: account.id,
      purgedAt: new Date().toISOString(),
    });
    if (!published) {
      deferred += 1;
      continue;
    }

    try {
      const claimed = await authRepository.purgeAccount(account.id);
      if (!claimed) continue; // another replica won the claim

      purged += 1;
      recordAuditEventSafe({
        event: "ACCOUNT_PURGED",
        targetType: "user",
        targetId: account.id,
        userId: account.id,
        metadata: {
          scheduledDeletionAt: account.scheduledDeletionAt?.toISOString(),
        },
      });
    } catch (err) {
      // Leave it for the next tick rather than marking it done. An erasure that
      // half-happened and reported success is worse than one that retries.
      deferred += 1;
      logger.error(
        `account-purge-sweeper: failed to purge account ${account.id}: ${String(err)}`
      );
    }
  }

  if (purged > 0 || deferred > 0) {
    logger.info(
      `account-purge-sweeper: purged=${String(purged)} deferred=${String(deferred)}`
    );
  }

  return { purged, deferred };
}

async function tick(): Promise<void> {
  if (running) return; // never overlap ticks on this instance
  running = true;
  const intervalMs = env.ACCOUNT_PURGE_SWEEP_INTERVAL_SEC * 1000;
  try {
    if (!(await acquireLock(intervalMs))) return;
    try {
      await runAccountPurgeOnce();
    } finally {
      await releaseLock();
    }
  } catch (err) {
    logger.error(`account-purge-sweeper tick failed: ${String(err)}`);
  } finally {
    running = false;
  }
}

export function startAccountPurgeSweeper(): void {
  if (timer) return;
  const intervalMs = env.ACCOUNT_PURGE_SWEEP_INTERVAL_SEC * 1000;
  timer = setInterval(() => void tick(), intervalMs);
  // Do not hold the process open for a sweep.
  timer.unref?.();
  logger.info(
    `account-purge-sweeper started (every ${String(env.ACCOUNT_PURGE_SWEEP_INTERVAL_SEC)}s)`
  );
}

export function stopAccountPurgeSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
