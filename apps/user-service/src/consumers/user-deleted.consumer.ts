import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { UserEvents, type UserDeletedPayload } from "@aimess/shared-types";

import { env } from "../config/env.js";
import { handleUserDeleted } from "../handlers/user-deleted.handler.js";

const USER_DELETED_QUEUE = "user.deleted.queue";

/**
 * Dead-letter topology for user.deleted.queue. Messages nack'd with
 * requeue=false (poison/permanent failures) are routed here instead of being
 * dropped.
 */
const USER_DELETED_DLX = "user.deleted.queue.dlx";
const USER_DELETED_DLQ = "user.deleted.queue.dlq";
const USER_DELETED_DLQ_ROUTING_KEY = "user.deleted.queue.dead";

const PREFETCH = 10;

/**
 * Retry amqp.connect with exponential backoff (2s → 4s → … → 30s cap).
 * Covers the startup race where RabbitMQ is still initialising when the
 * service boots alongside it in Docker Compose / pnpm dev.
 */
async function connectWithRetry(
  url: string,
  retries = 8
): Promise<amqp.ChannelModel> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await amqp.connect(url);
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = Math.min(2000 * attempt, 30_000);
      logger.warn(
        `RabbitMQ connection attempt ${String(attempt)}/${String(retries)} failed — retrying in ${String(delay / 1000)}s`
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  /* istanbul ignore next */
  throw new Error("connectWithRetry: unreachable");
}

export async function startUserDeletedConsumer(): Promise<void> {
  const connection = await connectWithRetry(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  // Dead-letter exchange + queue for messages that fail permanently.
  await channel.assertExchange(USER_DELETED_DLX, "direct", { durable: true });
  await channel.assertQueue(USER_DELETED_DLQ, { durable: true });
  await channel.bindQueue(
    USER_DELETED_DLQ,
    USER_DELETED_DLX,
    USER_DELETED_DLQ_ROUTING_KEY
  );

  // Main work queue. Args MUST match the publisher (auth-service) declaration.
  await channel.assertQueue(USER_DELETED_QUEUE, {
    durable: true,
    deadLetterExchange: USER_DELETED_DLX,
    deadLetterRoutingKey: USER_DELETED_DLQ_ROUTING_KEY,
  });

  await channel.prefetch(PREFETCH);

  logger.info("User-service consumer listening on user.deleted.queue");

  channel.consume(USER_DELETED_QUEUE, async (message) => {
    if (!message) return;

    try {
      const parsed = JSON.parse(message.content.toString()) as {
        type: string;
        data: UserDeletedPayload;
      };

      if (parsed.type === UserEvents.USER_DELETED) {
        await handleUserDeleted(parsed.data);
      } else {
        logger.warn(`Unknown event type: ${parsed.type}`);
      }

      channel.ack(message);
    } catch (error) {
      if (error instanceof SyntaxError) {
        // Malformed body can never succeed on retry — dead-letter it so the
        // consumer is not wedged by a poison message.
        logger.error("Discarding malformed user.deleted message body");
        logger.error(error);
        channel.nack(message, false, false);
        return;
      }

      // Transient failure (DB/Redis down). Route to the DLQ instead of dropping
      // so the deletion can be recovered/replayed later.
      logger.error("Failed to process user.deleted event");
      logger.error(error);
      channel.nack(message, false, false);
    }
  });
}
