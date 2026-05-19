import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { UserEvents, type UserCreatedPayload } from "@aimess/shared-types";

import { env } from "../config/env.js";

const USER_QUEUE = "user.queue";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertQueue(USER_QUEUE, { durable: true });
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
