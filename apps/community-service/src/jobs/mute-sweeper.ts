import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { communityService } from "../services/community.service.js";
import { communityRepository } from "../repositories/community.repository.js";
import { publishCommunityMemberMuteSyncedForChatSafe } from "../messaging/publish-community-chat.js";

/**
 * Auto-unmute sweeper.
 *
 * Timed moderation mutes are enforced via LAZY expiry everywhere (chat-service
 * checks `mutedUntil > now` on the write path, the gRPC mute check filters
 * expired rows), so a member regains posting rights the instant their timer
 * lapses with zero coupling. This background sweep exists for the things lazy
 * expiry can't do on its own:
 *   - deliver the realtime `community:member:unmuted` signal so the composer
 *     re-enables on every device without a refresh,
 *   - post the "X was unmuted" system message,
 *   - write the auto-unmute audit entry, and
 *   - garbage-collect the expired row.
 *
 * Safety / scale:
 *   - Multi-instance safe via a per-row ATOMIC claim in `expireDueMutes`
 *     (deleteMany guarded on id+expiry → exactly-once side-effects). A short
 *     Redis lock additionally de-duplicates the SCAN so N instances don't all
 *     page the same rows; if Redis is down the claim still guarantees
 *     correctness, so the sweep proceeds lock-free.
 *   - Batched: each tick drains in pages of `MUTE_SWEEPER_BATCH_SIZE`, bounded
 *     by `MAX_BATCHES_PER_TICK` so one tick can never monopolise the DB.
 *   - Non-overlapping: a slow tick never overlaps the next on the same instance.
 */

const LOCK_KEY = "community:mute-sweeper:lock";
/** Backstop so a huge backlog can't hold the DB for a whole tick — the rest
 *  drains on subsequent ticks. */
const MAX_BATCHES_PER_TICK = 50;

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Acquire a short-lived single-sweeper lock. Returns true when this instance
 * owns the tick. Best-effort: any Redis error returns true so the sweep still
 * runs (the atomic per-row claim keeps it exactly-once regardless of the lock).
 */
async function acquireLock(ttlMs: number): Promise<boolean> {
  try {
    const res = await redis.set(LOCK_KEY, "1", "PX", ttlMs, "NX");
    return res === "OK";
  } catch {
    return true; // Redis unavailable — rely on the atomic claim.
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
    // Lock TTL just under the interval so a crashed holder frees it by next tick.
    const ttl = Math.max(5_000, env.MUTE_SWEEPER_INTERVAL_MS - 5_000);
    if (!(await acquireLock(ttl))) return; // another instance owns this tick

    let total = 0;
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      const n = await communityService.expireDueMutes(
        env.MUTE_SWEEPER_BATCH_SIZE
      );
      total += n;
      if (n < env.MUTE_SWEEPER_BATCH_SIZE) break; // drained
    }
    if (total > 0) logger.info(`Auto-unmute sweep expired ${total} mute(s)`);
    await releaseLock();
  } catch (err) {
    logger.warn("Auto-unmute sweep failed");
    logger.warn(err);
  } finally {
    running = false;
  }
}

/**
 * One-shot migration backfill: re-mirror every currently-active mute into
 * chat-service. New `RoomMember.isMuted`/`mutedUntil` default to false/null, so
 * mutes that predate this feature would otherwise go un-enforced in chat until
 * re-applied or expired. Idempotent (chat-service upserts the mirror), paged,
 * and fully best-effort — never blocks startup.
 */
export async function backfillActiveMutesToChat(): Promise<void> {
  if (!env.MUTE_SWEEPER_ENABLED) return;
  try {
    const now = new Date();
    let afterId: string | undefined;
    let total = 0;
    const PAGE = 500;
    for (let page = 0; page < 10_000; page++) {
      const rows = await communityRepository.listActiveMutesPage({
        now,
        afterId,
        limit: PAGE,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        publishCommunityMemberMuteSyncedForChatSafe({
          communityId: row.communityId,
          userId: row.userId,
          isMuted: true,
          mutedUntil: row.mutedUntil ? row.mutedUntil.toISOString() : null,
        });
      }
      total += rows.length;
      afterId = rows[rows.length - 1].id;
      if (rows.length < PAGE) break;
    }
    if (total > 0) {
      logger.info(
        `Mute backfill: re-synced ${total} active mute(s) to chat-service`
      );
    }
  } catch (err) {
    logger.warn("Mute backfill to chat-service failed (non-fatal)");
    logger.warn(err);
  }
}

/** Start the periodic auto-unmute sweep (no-op when disabled). */
export function startMuteSweeper(): void {
  if (!env.MUTE_SWEEPER_ENABLED) {
    logger.info("Mute sweeper disabled (MUTE_SWEEPER_ENABLED=false)");
    return;
  }
  if (timer) return; // already started
  timer = setInterval(() => void runOnce(), env.MUTE_SWEEPER_INTERVAL_MS);
  // Don't keep the process alive solely for the sweep.
  if (typeof timer.unref === "function") timer.unref();
  logger.info(
    `Mute sweeper started (every ${env.MUTE_SWEEPER_INTERVAL_MS}ms, batch ${env.MUTE_SWEEPER_BATCH_SIZE})`
  );
}

export function stopMuteSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info("Mute sweeper stopped");
  }
}
