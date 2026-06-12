import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { env } from "../config/env.js";
import { communityRepository } from "../repositories/community.repository.js";

/**
 * Consumes chat-service's community-activity events and bumps
 * `Community.lastActivityAt` (forward-only), so `GET /communities/mine` can
 * order communities by their latest message.
 *
 * Queue args MUST match the publisher (chat-service
 * `publish-community-activity.ts`): a plain durable queue, no DLX — RabbitMQ
 * queue args are immutable, so a mismatch yields PRECONDITION_FAILED.
 */
const QUEUE = "community.activity.queue";
const ACTIVITY_EVENT = "community.activity";
const PREFETCH = 10;

interface CommunityActivityMessage {
  type: string;
  data: {
    communityId: string;
    lastMessageAt: string;
    lastMessageId: string;
    senderUserId?: string;
    senderUsername?: string;
    messagePreview?: string;
    type?: string;
  };
}

export async function startCommunityActivityConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE, { durable: true });
  await channel.prefetch(PREFETCH);

  logger.info(
    "Community-service consumer listening on community.activity.queue"
  );

  void channel.consume(QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      let parsed: CommunityActivityMessage;
      try {
        parsed = JSON.parse(
          message.content.toString()
        ) as CommunityActivityMessage;
      } catch (error) {
        logger.error("Discarding malformed community.activity message body");
        logger.error(error);
        channel.nack(message, false, false);
        return;
      }

      try {
        if (parsed.type === ACTIVITY_EVENT) {
          const at = new Date(parsed.data.lastMessageAt);
          if (parsed.data.communityId && !Number.isNaN(at.getTime())) {
            await communityRepository.updateLastActivity(
              parsed.data.communityId,
              at,
              parsed.data.type ?? "message",
              parsed.data.messagePreview ?? "",
              parsed.data.senderUsername ?? null,
              parsed.data.senderUserId ?? null
            );
          }
        } else {
          logger.warn(
            `Unknown event type on community.activity.queue: ${parsed.type}`
          );
        }
        channel.ack(message);
      } catch (error) {
        // Best-effort denormalization: drop on failure (the next message will
        // re-bump). No DLQ for this queue.
        logger.error("Failed to process community.activity event");
        logger.error(error);
        channel.nack(message, false, false);
      }
    })();
  });
}
