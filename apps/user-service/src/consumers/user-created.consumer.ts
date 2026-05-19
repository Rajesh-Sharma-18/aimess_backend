import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { UserEvents, type UserCreatedPayload } from "@aimess/shared-types";

import { env } from "../config/env.js";
import { handleUserCreated } from "../handlers/user-created.handler.js";

const USER_QUEUE = "user.queue";

export async function startUserCreatedConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(USER_QUEUE, { durable: true });

  logger.info("User-service consumer listening on user.queue");

  channel.consume(USER_QUEUE, async (message) => {
    if (!message) return;

    const parsed = JSON.parse(message.content.toString()) as {
      type: string;
      data: UserCreatedPayload;
    };

    try {
      if (parsed.type === UserEvents.USER_CREATED) {
        await handleUserCreated(parsed.data);
      } else {
        logger.warn(`Unknown event type: ${parsed.type}`);
      }

      channel.ack(message);
    } catch (error) {
      logger.error("Failed to process user.created event");
      logger.error(error);
      channel.nack(message, false, false);
    }
  });
}
