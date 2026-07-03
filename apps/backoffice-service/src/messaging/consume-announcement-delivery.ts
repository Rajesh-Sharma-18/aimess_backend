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

    // Below max attempts — rethrow so the wiring nacks and the broker's DLX
    // retry path (or a manual replay) picks the batch back up.
    throw error;
  }
}

export async function startAnnouncementDeliveryConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange("announcement.delivery.queue.dlx", "direct", {
    durable: true,
  });
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
        logger.error(
          "Announcement delivery consumer failed to process message"
        );
        logger.error(error);
        channel.nack(message, false, false);
      }
    })();
  });
}
