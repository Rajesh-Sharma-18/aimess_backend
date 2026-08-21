import { logger } from "@aimess/logger";

import { isTransientConnectionError } from "./db-errors.js";
import { enqueueAnnouncementDeliverySafe } from "../messaging/publish-announcement-delivery.js";
import { announcementRepository } from "../repositories/index.js";
import { DELIVERY_BATCH_LIMIT } from "../services/announcement.service.js";

/**
 * Poll SCHEDULED announcements whose `scheduledAt` is due, claim each one
 * atomically (CAS via `claimScheduled`, guarding against two backoffice-
 * service instances racing the same row), and hand it to the same delivery
 * pipeline immediate announcements use. Exported separately from the
 * `setInterval` wiring so tests can invoke a single tick directly.
 *
 * DB access is best-effort per tick: a transient PostgreSQL connection drop
 * (idle connection reaped by the server/proxy between ticks) skips the rest
 * of THIS tick rather than crashing the process. Nothing is lost — any row
 * not claimed here is still SCHEDULED and is picked up by the next tick.
 */
export async function runSchedulerTick(now: Date = new Date()): Promise<void> {
  let due;
  try {
    due = await announcementRepository.findDueScheduled(now);
  } catch (error) {
    logger.error(
      `Announcement scheduler: skipping tick, DB unavailable (${describeDbError(error)})`
    );
    return;
  }

  for (const row of due) {
    try {
      const claimed = await announcementRepository.claimScheduled(row.id);
      if (!claimed) continue; // another instance already claimed it

      enqueueAnnouncementDeliverySafe({
        announcementId: row.id,
        title: row.title,
        description: row.description,
        target: row.target,
        kind: row.kind,
        deviceType: row.deviceType,
        communityId: row.communityId,
        cursor: 0,
        limit: DELIVERY_BATCH_LIMIT,
        batchId: `ann:${row.id}:cursor:0`,
      });
    } catch (error) {
      // Isolated per-row: a DB hiccup on one announcement must not stop the
      // rest of the due batch. Still SCHEDULED, so it's retried next tick.
      logger.error(
        `Announcement scheduler: failed to claim ${row.id} (${describeDbError(error)})`
      );
    }
  }

  await requeueStalledProcessing(now);
  await failHalfDeliveredProcessing(now);
}

/**
 * A row that delivered some pages and then stopped is NOT safe to replay —
 * everyone already reached would be notified twice. Mark it FAILED so it stops
 * claiming to be in flight and an operator can see (and re-send) it.
 */
async function failHalfDeliveredProcessing(now: Date): Promise<void> {
  let stalled;
  try {
    stalled = await announcementRepository.findHalfDeliveredProcessing(
      new Date(now.getTime() - STALLED_PROCESSING_MS)
    );
  } catch (error) {
    logger.error(
      `Announcement scheduler: skipping half-delivered sweep (${describeDbError(error)})`
    );
    return;
  }

  for (const row of stalled) {
    try {
      await announcementRepository.markFailed(
        row.id,
        `Delivery stalled after ${row.recipientCount} recipients — remaining batches were not processed`
      );
      logger.warn(
        `Announcement ${row.id} marked FAILED: stalled at ${row.recipientCount} recipients`
      );
    } catch (error) {
      logger.error(
        `Announcement scheduler: failed to mark ${row.id} FAILED (${describeDbError(error)})`
      );
    }
  }
}

/**
 * How long a PROCESSING row may sit with nothing delivered before the tick
 * re-enqueues it. Long enough that a slow-but-live delivery is never racing a
 * retry; the in-flight cursor message holds a Redis batch lock anyway.
 *
 * ponytail: fixed window, no attempt counter — a row that keeps stalling is
 * retried every tick. Add a retry cap if that ever shows up in the logs.
 */
const STALLED_PROCESSING_MS = 15 * 60 * 1000;

/**
 * Recover announcements claimed by a process that died before it enqueued
 * anything (the "server restarts mid-send" case). Only rows that provably
 * delivered to nobody are touched, so this can never double-notify.
 */
async function requeueStalledProcessing(now: Date): Promise<void> {
  let stalled;
  try {
    stalled = await announcementRepository.findStalledProcessing(
      new Date(now.getTime() - STALLED_PROCESSING_MS)
    );
  } catch (error) {
    logger.error(
      `Announcement scheduler: skipping stalled sweep (${describeDbError(error)})`
    );
    return;
  }

  for (const row of stalled) {
    logger.warn(
      `Announcement ${row.id} stalled in PROCESSING with no recipients — re-enqueueing`
    );
    enqueueAnnouncementDeliverySafe({
      announcementId: row.id,
      title: row.title,
      description: row.description,
      target: row.target,
      kind: row.kind,
      deviceType: row.deviceType,
      communityId: row.communityId,
      cursor: 0,
      limit: DELIVERY_BATCH_LIMIT,
      // Distinct from the original batchId: that one's Redis idempotency lock
      // is what made the dead attempt un-retryable in the first place.
      batchId: `ann:${row.id}:cursor:0:requeue`,
    });
  }
}

function describeDbError(error: unknown): string {
  if (isTransientConnectionError(error)) return "transient connection drop";
  return error instanceof Error ? error.message : "unknown error";
}

export function startAnnouncementScheduler(
  intervalMs = 30_000
): NodeJS.Timeout {
  return setInterval(() => {
    void runSchedulerTick().catch((error: unknown) => {
      logger.error(
        `Announcement scheduler tick failed (${describeDbError(error)})`
      );
    });
  }, intervalMs);
}
