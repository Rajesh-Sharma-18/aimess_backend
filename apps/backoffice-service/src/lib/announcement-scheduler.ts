import { logger } from "@aimess/logger";

import { enqueueAnnouncementDeliverySafe } from "../messaging/publish-announcement-delivery.js";
import { announcementRepository } from "../repositories/index.js";
import { DELIVERY_BATCH_LIMIT } from "../services/announcement.service.js";

/**
 * Poll SCHEDULED announcements whose `scheduledAt` is due, claim each one
 * atomically (CAS via `claimScheduled`, guarding against two backoffice-
 * service instances racing the same row), and hand it to the same delivery
 * pipeline immediate announcements use. Exported separately from the
 * `setInterval` wiring so tests can invoke a single tick directly.
 */
export async function runSchedulerTick(now: Date = new Date()): Promise<void> {
  const due = await announcementRepository.findDueScheduled(now);

  for (const row of due) {
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
  }
}

export function startAnnouncementScheduler(
  intervalMs = 30_000
): NodeJS.Timeout {
  return setInterval(() => {
    void runSchedulerTick().catch((error: unknown) => {
      logger.error("Announcement scheduler tick failed");
      logger.error(error);
    });
  }, intervalMs);
}
