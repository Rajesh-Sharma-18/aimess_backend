import { logger } from "@aimess/logger";
import amqp from "amqplib";
import {
  UserEvents,
  type UserSettingsUpdatedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { invalidateNotificationSettings } from "../services/notification-settings.service.js";

// Mirrors user-service publish-settings-updated.ts (durable queue + DLX). The
// DLX args MUST match the publisher or RabbitMQ throws PRECONDITION_FAILED.
const QUEUE = "user.settings_updated.queue";
const DLX = "user.settings_updated.queue.dlx";
const DLQ_ROUTING_KEY = "user.settings_updated.queue.dead";

export async function startSettingsConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(DLX, "direct", { durable: true });
  await channel.assertQueue(QUEUE, {
    durable: true,
    deadLetterExchange: DLX,
    deadLetterRoutingKey: DLQ_ROUTING_KEY,
  });
  await channel.prefetch(10);

  logger.info("Settings cache-bust consumer started");

  void channel.consume(QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: unknown;
        };
        if (parsed.type === UserEvents.SETTINGS_UPDATED) {
          const p = parsed.data as UserSettingsUpdatedPayload;
          await invalidateNotificationSettings(p.userId);
        }
        channel.ack(message);
      } catch (error) {
        logger.error("Settings consumer failed to process message", error);
        channel.nack(message, false, false);
      }
    })();
  });
}
