import { logger } from "@aimess/logger";
import amqp from "amqplib";

import {
  UserEvents,
  type UserSettingsUpdatedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";

const QUEUE = "user.settings_updated.queue";
const DLX = "user.settings_updated.queue.dlx";
const DLQ_ROUTING_KEY = "user.settings_updated.queue.dead";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertExchange(DLX, "direct", { durable: true });
      await channel.assertQueue(QUEUE, {
        durable: true,
        deadLetterExchange: DLX,
        deadLetterRoutingKey: DLQ_ROUTING_KEY,
      });
      return channel;
    })();
  }
  return channelPromise;
}

async function publish(data: UserSettingsUpdatedPayload): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({
    type: UserEvents.SETTINGS_UPDATED,
    data,
  });
  channel.sendToQueue(QUEUE, Buffer.from(payload), { persistent: true });
}

/**
 * Fire-and-forget publish of user.settings_updated. notifications-service
 * consumes this to bust its cached notification-settings entry; settings writes
 * must not fail if RabbitMQ is unavailable, so errors are swallowed + logged.
 */
export function publishSettingsUpdatedSafe(
  data: UserSettingsUpdatedPayload
): void {
  void publish(data).catch((error) => {
    logger.error("Failed to publish user.settings_updated");
    logger.error(error);
  });
}
