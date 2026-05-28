import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { UserEvents, type UserCreatedPayload } from "@aimess/shared-types";

import { env } from "../config/env.js";
import { handleUserCreated } from "../handlers/user-created.handler.js";

const USER_QUEUE = "user.queue";

/**
 * Dead-letter topology for user.queue. Messages nack'd with requeue=false
 * (poison/permanent failures) are routed here instead of being dropped.
 */
const USER_DLX = "user.queue.dlx";
const USER_DLQ = "user.queue.dlq";
const USER_DLQ_ROUTING_KEY = "user.queue.dead";

const PREFETCH = 10;

export async function startUserCreatedConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  // Dead-letter exchange + queue for messages that fail permanently.
  await channel.assertExchange(USER_DLX, "direct", { durable: true });
  await channel.assertQueue(USER_DLQ, { durable: true });
  await channel.bindQueue(USER_DLQ, USER_DLX, USER_DLQ_ROUTING_KEY);

  // Main work queue. Args MUST match the publisher (auth-service) declaration.
  await channel.assertQueue(USER_QUEUE, {
    durable: true,
    deadLetterExchange: USER_DLX,
    deadLetterRoutingKey: USER_DLQ_ROUTING_KEY,
  });

  await channel.prefetch(PREFETCH);

  logger.info("User-service consumer listening on user.queue");

  channel.consume(USER_QUEUE, async (message) => {
    if (!message) return;

    try {
      const parsed = JSON.parse(message.content.toString()) as {
        type: string;
        data: UserCreatedPayload;
      };

      if (parsed.type === UserEvents.USER_CREATED) {
        await handleUserCreated(parsed.data);
      } else {
        logger.warn(`Unknown event type: ${parsed.type}`);
      }

      channel.ack(message);
    } catch (error) {
      if (error instanceof SyntaxError) {
        // Malformed body can never succeed on retry — dead-letter it so the
        // consumer is not wedged by a poison message.
        logger.error("Discarding malformed user.created message body");
        logger.error(error);
        channel.nack(message, false, false);
        return;
      }

      // Transient failure (DB/MinIO/auth down). Route to the DLQ instead of
      // dropping so the profile can be recovered/replayed later.
      logger.error("Failed to process user.created event");
      logger.error(error);
      channel.nack(message, false, false);
    }
  });
}
