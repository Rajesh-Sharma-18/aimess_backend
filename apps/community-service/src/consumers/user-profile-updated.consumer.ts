import { logger } from "@aimess/logger";
import amqp from "amqplib";

import {
  UserEvents,
  type UserProfileUpdatedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { communityRepository } from "../repositories/community.repository.js";

const QUEUE = "user.profile_updated.queue";
const DLX = "user.profile_updated.queue.dlx";
const DLQ = "user.profile_updated.queue.dlq";
const DLQ_ROUTING_KEY = "user.profile_updated.queue.dead";

const PREFETCH = 10;

export async function startUserProfileUpdatedConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(DLX, "direct", { durable: true });
  await channel.assertQueue(DLQ, { durable: true });
  await channel.bindQueue(DLQ, DLX, DLQ_ROUTING_KEY);

  await channel.assertQueue(QUEUE, {
    durable: true,
    deadLetterExchange: DLX,
    deadLetterRoutingKey: DLQ_ROUTING_KEY,
  });

  await channel.prefetch(PREFETCH);

  logger.info(
    "Community-service consumer listening on user.profile_updated.queue"
  );

  channel.consume(QUEUE, async (message) => {
    if (!message) return;

    let parsed: { type: string; data: UserProfileUpdatedPayload };
    try {
      parsed = JSON.parse(message.content.toString()) as {
        type: string;
        data: UserProfileUpdatedPayload;
      };
    } catch (error) {
      logger.error("Discarding malformed user.profile_updated message body");
      logger.error(error);
      channel.nack(message, false, false);
      return;
    }

    try {
      if (parsed.type === UserEvents.USER_PROFILE_UPDATED) {
        await communityRepository.updateMemberSnapshotsByUserId(
          parsed.data.userId,
          {
            snapshotUsername: parsed.data.username,
            snapshotDisplayName: parsed.data.displayName,
            snapshotAvatarKey: parsed.data.avatarObjectKey,
          }
        );
      } else {
        logger.warn(
          `Unknown event type on user.profile_updated.queue: ${parsed.type}`
        );
      }

      channel.ack(message);
    } catch (error) {
      logger.error("Failed to process user.profile_updated event");
      logger.error(error);
      channel.nack(message, false, false);
    }
  });
}
