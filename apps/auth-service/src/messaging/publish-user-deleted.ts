import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { UserEvents, type UserDeletedPayload } from "@aimess/shared-types";

import { env } from "../config/env.js";

const USER_DELETED_QUEUE = "user.deleted.queue";

/**
 * Dead-letter topology for user.deleted.queue. Must stay in sync with the
 * user-service consumer; queue arguments are immutable once declared so both
 * sides MUST assert identical deadLetter* args or RabbitMQ throws
 * PRECONDITION_FAILED.
 */
const USER_DELETED_DLX = "user.deleted.queue.dlx";
const USER_DELETED_DLQ_ROUTING_KEY = "user.deleted.queue.dead";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertExchange(USER_DELETED_DLX, "direct", {
        durable: true,
      });
      await channel.assertQueue(USER_DELETED_QUEUE, {
        durable: true,
        deadLetterExchange: USER_DELETED_DLX,
        deadLetterRoutingKey: USER_DELETED_DLQ_ROUTING_KEY,
      });
      return channel;
    })();
  }
  return channelPromise;
}

export async function publishUserDeleted(
  data: UserDeletedPayload
): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({ type: UserEvents.USER_DELETED, data });
  channel.sendToQueue(USER_DELETED_QUEUE, Buffer.from(payload), {
    persistent: true,
  });
}

/** Fire-and-forget; deletion must not fail if the broker is down. */
export function publishUserDeletedSafe(data: UserDeletedPayload): void {
  void publishUserDeleted(data).catch((error) => {
    logger.error("Failed to publish user.deleted event");
    logger.error(error);
  });
}
