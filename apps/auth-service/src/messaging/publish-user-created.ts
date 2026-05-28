import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { UserEvents, type UserCreatedPayload } from "@aimess/shared-types";

import { env } from "../config/env.js";

const USER_QUEUE = "user.queue";

/**
 * Dead-letter topology for user.queue. Must stay in sync with the user-service
 * consumer; queue arguments are immutable once declared so both sides MUST
 * assert identical deadLetter* args or RabbitMQ throws PRECONDITION_FAILED.
 */
const USER_DLX = "user.queue.dlx";
const USER_DLQ_ROUTING_KEY = "user.queue.dead";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertExchange(USER_DLX, "direct", { durable: true });
      await channel.assertQueue(USER_QUEUE, {
        durable: true,
        deadLetterExchange: USER_DLX,
        deadLetterRoutingKey: USER_DLQ_ROUTING_KEY,
      });
      return channel;
    })();
  }
  return channelPromise;
}

export async function publishUserCreated(
  data: UserCreatedPayload
): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({ type: UserEvents.USER_CREATED, data });
  channel.sendToQueue(USER_QUEUE, Buffer.from(payload), { persistent: true });
}

/** Fire-and-forget; registration must not fail if the broker is down. */
export function publishUserCreatedSafe(data: UserCreatedPayload): void {
  void publishUserCreated(data).catch((error) => {
    logger.error("Failed to publish user.created event");
    logger.error(error);
  });
}
