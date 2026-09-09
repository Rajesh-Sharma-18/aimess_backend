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
      let userId: string | null = null;

      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: unknown;
        };
        if (parsed.type === UserEvents.SETTINGS_UPDATED) {
          userId = (parsed.data as UserSettingsUpdatedPayload).userId;
        }
      } catch (error) {
        // Unparseable body: replaying it will fail the same way forever.
        logger.error("Settings consumer received an unreadable message", error);
        channel.nack(message, false, false);
        return;
      }

      if (userId === null) {
        channel.ack(message);
        return;
      }

      try {
        await invalidateNotificationSettings(userId);
        channel.ack(message);
      } catch (error) {
        // A failed DEL is the one failure that silently outlives itself: the
        // stale entry then sits there for the rest of NOTIF_SETTINGS_CACHE_TTL_SEC
        // (300s by default), so the user's new mute / quiet-hours / category
        // choice is ignored for up to five minutes with nothing left to fix it.
        // Dead-lettering it straight away made that the DEFAULT outcome of any
        // Redis blip, so requeue once for a retry before giving up.
        //
        // Once only: `redelivered` bounds it, and a Redis that is still down on
        // the second attempt is failing cache READS too — `getNotificationSettings`
        // falls through to gRPC on a read error, which is fresh by definition —
        // so the staleness this protects against is not reachable in that state.
        const requeue = !message.fields.redelivered;
        logger.error(
          `Settings consumer failed to invalidate cache for ${userId} (requeue=${String(requeue)})`,
          error
        );
        if (requeue) {
          setTimeout(() => channel.nack(message, false, true), 1000);
        } else {
          channel.nack(message, false, false);
        }
      }
    })();
  });
}
