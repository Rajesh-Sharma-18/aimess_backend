import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { UserEvents, type UserRestoredPayload } from "@aimess/shared-types";

import { env } from "../config/env.js";
import { handleUserRestored } from "../handlers/user-restored.handler.js";

const USER_RESTORED_QUEUE = "user.restored.queue";

/**
 * Dead-letter topology for user.restored.queue — identical in shape to
 * user.deleted.queue's. Queue arguments are immutable once declared, so these
 * MUST match auth-service's publisher declaration or RabbitMQ throws
 * PRECONDITION_FAILED.
 */
const USER_RESTORED_DLX = "user.restored.queue.dlx";
const USER_RESTORED_DLQ = "user.restored.queue.dlq";
const USER_RESTORED_DLQ_ROUTING_KEY = "user.restored.queue.dead";

const PREFETCH = 10;

/** Same startup-race backoff as the user.deleted consumer. */
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

export async function startUserRestoredConsumer(): Promise<void> {
  const connection = await connectWithRetry(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(USER_RESTORED_DLX, "direct", { durable: true });
  await channel.assertQueue(USER_RESTORED_DLQ, { durable: true });
  await channel.bindQueue(
    USER_RESTORED_DLQ,
    USER_RESTORED_DLX,
    USER_RESTORED_DLQ_ROUTING_KEY
  );

  await channel.assertQueue(USER_RESTORED_QUEUE, {
    durable: true,
    deadLetterExchange: USER_RESTORED_DLX,
    deadLetterRoutingKey: USER_RESTORED_DLQ_ROUTING_KEY,
  });

  await channel.prefetch(PREFETCH);

  logger.info("User-service consumer listening on user.restored.queue");

  channel.consume(USER_RESTORED_QUEUE, async (message) => {
    if (!message) return;

    try {
      const parsed = JSON.parse(message.content.toString()) as {
        type: string;
        data: UserRestoredPayload;
      };

      if (parsed.type === UserEvents.USER_RESTORED) {
        await handleUserRestored(parsed.data);
      } else {
        logger.warn(`Unknown event type: ${parsed.type}`);
      }

      channel.ack(message);
    } catch (error) {
      if (error instanceof SyntaxError) {
        logger.error("Discarding malformed user.restored message body");
        logger.error(error);
        channel.nack(message, false, false);
        return;
      }

      // Transient failure (DB/Redis down). Dead-letter rather than drop: unlike
      // a lost delete, a lost restore leaves an account that can log in but
      // still reads as "Deleted Account" everywhere, so the message must stay
      // recoverable for replay. The handler is idempotent, so replay is safe.
      logger.error("Failed to process user.restored event");
      logger.error(error);
      channel.nack(message, false, false);
    }
  });
}
