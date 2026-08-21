import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { AUDIT_ACTIONS } from "../constants/index.js";
import { redis } from "../config/redis.js";
import { env } from "../config/env.js";
import { authClient } from "../grpc/auth.client.js";
import { communityClient } from "../grpc/community.client.js";
import { announcementRepository } from "../repositories/announcement.repository.js";
import { auditService } from "../services/audit.service.js";
import {
  ANNOUNCEMENT_DELIVERY_QUEUE,
  publishAnnouncementDeliveryCursor,
  type AnnouncementDeliverMessage,
} from "./publish-announcement-delivery.js";
import { publishNotificationAnnouncementBatch } from "./publish-notification-announcement-batch.js";

/** Max delivery attempts (per announcement) before giving up and marking FAILED. */
const MAX_ATTEMPTS = 3;
/** Idempotency-lock / attempt-counter TTL. */
const LOCK_TTL_SECONDS = 3600;

function attemptsKey(announcementId: string): string {
  return `announce:attempts:${announcementId}`;
}

function batchLockKey(batchId: string): string {
  return `announce:batch:${batchId}`;
}

/** One page of recipient userIds for the given target/cursor. */
async function fetchRecipientPage(
  data: AnnouncementDeliverMessage
): Promise<string[]> {
  if (data.target === "ALL") {
    const { users } = await authClient.adminListUsers({
      status: ["ACTIVE"],
      limit: data.limit,
      offset: data.cursor,
    });
    return users.map((u) => u.id);
  }

  const page = Math.floor(data.cursor / data.limit) + 1;
  const { members } = await communityClient.adminListCommunityMembers({
    communityId: data.communityId ?? "",
    search: "",
    role: "",
    page,
    limit: data.limit,
    excludeUserId: "",
    sortField: "",
    sortDir: "",
  });
  return members.map((m) => m.userId);
}

/**
 * Handles one `announcement.deliver` cursor message. Exported separately from
 * the `channel.consume` wiring so tests can call it directly without a real
 * amqp connection or timers.
 */
export async function handleAnnouncementDeliverMessage(
  data: AnnouncementDeliverMessage
): Promise<void> {
  const acquired = await redis.set(
    batchLockKey(data.batchId),
    "1",
    "EX",
    LOCK_TTL_SECONDS,
    "NX"
  );
  if (!acquired) {
    logger.info(`Duplicate announcement batch skipped: ${data.batchId}`);
    return;
  }

  try {
    // Cancellation can only win the CAS while the row is still SCHEDULED, so a
    // single-page announcement can never be cancelled mid-flight. A MULTI-page
    // one re-publishes cursors after it is already PROCESSING, which is a gap
    // the CAS does not cover — re-read the status per page so a cancel that
    // lands between pages stops the remaining fan-out.
    const status = await announcementRepository.getStatus(data.announcementId);
    if (status === "CANCELLED") {
      logger.info(
        `Announcement ${data.announcementId} cancelled — stopping delivery at cursor ${data.cursor}`
      );
      return;
    }

    const recipients = await fetchRecipientPage(data);

    if (recipients.length === 0 && data.cursor === 0) {
      await announcementRepository.markSent(data.announcementId);
      await auditService.record({
        actorId: data.announcementId,
        action: AUDIT_ACTIONS.ANNOUNCEMENT_SENT,
        targetType: "announcement",
        targetId: data.announcementId,
        after: { recipientCount: 0 },
      });
      return;
    }

    if (recipients.length > 0) {
      await publishNotificationAnnouncementBatch({
        announcementId: data.announcementId,
        title: data.title,
        body: data.description,
        kind: data.kind,
        deviceType: data.deviceType,
        userIds: recipients,
        batchId: `ann:${data.announcementId}:notify:${data.cursor}`,
      });
      await announcementRepository.incrementRecipientCount(
        data.announcementId,
        recipients.length
      );
    }

    if (recipients.length === data.limit) {
      // More pages likely — re-publish the next cursor.
      await publishAnnouncementDeliveryCursor({
        ...data,
        cursor: data.cursor + data.limit,
        batchId: `ann:${data.announcementId}:cursor:${data.cursor + data.limit}`,
      });
      return;
    }

    // Last page.
    await announcementRepository.markSent(data.announcementId);
    await auditService.record({
      actorId: data.announcementId,
      action: AUDIT_ACTIONS.ANNOUNCEMENT_SENT,
      targetType: "announcement",
      targetId: data.announcementId,
    });
  } catch (error) {
    const key = attemptsKey(data.announcementId);
    const attempts = await redis.incr(key);
    await redis.expire(key, LOCK_TTL_SECONDS);

    if (attempts >= MAX_ATTEMPTS) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      await announcementRepository.markFailed(data.announcementId, reason);
      await auditService.record({
        actorId: data.announcementId,
        action: AUDIT_ACTIONS.ANNOUNCEMENT_FAILED,
        targetType: "announcement",
        targetId: data.announcementId,
        after: { reason },
      });
      return;
    }

    // Below max attempts — rethrow so the wiring requeues this batch.
    throw error;
  }
}

export async function startAnnouncementDeliveryConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange("announcement.delivery.queue.dlx", "direct", {
    durable: true,
  });
  // Bind a real queue to the DLX. Without it the exchange discarded everything
  // routed to it, so a batch that exhausted its retries was gone with no trace
  // — the failure was invisible in both the broker and the DB.
  await channel.assertQueue("announcement.delivery.queue.dead", {
    durable: true,
  });
  await channel.bindQueue(
    "announcement.delivery.queue.dead",
    "announcement.delivery.queue.dlx",
    "announcement.delivery.queue.dead"
  );
  await channel.assertQueue(ANNOUNCEMENT_DELIVERY_QUEUE, {
    durable: true,
    deadLetterExchange: "announcement.delivery.queue.dlx",
    deadLetterRoutingKey: "announcement.delivery.queue.dead",
  });
  await channel.prefetch(10);

  logger.info("Announcement delivery consumer started");

  void channel.consume(ANNOUNCEMENT_DELIVERY_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: AnnouncementDeliverMessage;
        };
        if (parsed.type === "announcement.deliver") {
          await handleAnnouncementDeliverMessage(parsed.data);
        } else {
          logger.warn(
            `Unknown announcement delivery event type: ${parsed.type}`
          );
        }
        channel.ack(message);
      } catch (error) {
        // requeue=true: the handler's own Redis attempt counter is the bound
        // (MAX_ATTEMPTS, after which it marks the announcement FAILED and
        // returns normally). Discarding here instead is what stranded a
        // half-delivered announcement in PROCESSING: the remaining pages were
        // never re-attempted and nothing was ever marked failed.
        const requeue = !(error instanceof SyntaxError);
        logger.error(`Announcement delivery batch failed (requeue=${requeue})`);
        logger.error(error);
        channel.nack(message, false, requeue);
      }
    })();
  });
}
