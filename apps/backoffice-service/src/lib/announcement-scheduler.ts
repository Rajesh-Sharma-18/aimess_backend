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
