import { logger } from "@aimess/logger";
import {
  AdminUserEvents,
  type AdminUserEventType,
  type AdminUserEventPayload,
} from "@aimess/shared-types";
import amqp from "amqplib";

import { env } from "../config/env.js";

/**
 * Publisher for `admin.user_*` account-state events. auth-service is the
 * eventual consumer (it owns AuthUser status) and will assert the same queue +
 * DLX topology. Mirrors the auth-service publisher convention
 * (apps/auth-service/src/messaging/publish-user-created.ts): one cached
 * channel, durable queue with a DLX, persistent messages, and a fire-and-forget
 * `*Safe` wrapper so an admin request never fails because the broker is down.
 */
const ADMIN_USER_QUEUE = "admin.user.queue";

/**
 * Dead-letter topology for admin.user.queue. Must stay in sync with the
 * auth-service consumer; queue arguments are immutable once declared so both
 * sides MUST assert identical deadLetter* args or RabbitMQ throws
 * PRECONDITION_FAILED.
 */
const ADMIN_USER_DLX = "admin.user.queue.dlx";
const ADMIN_USER_DLQ_ROUTING_KEY = "admin.user.queue.dead";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertExchange(ADMIN_USER_DLX, "direct", { durable: true });
      await channel.assertQueue(ADMIN_USER_QUEUE, {
        durable: true,
        deadLetterExchange: ADMIN_USER_DLX,
        deadLetterRoutingKey: ADMIN_USER_DLQ_ROUTING_KEY,
      });
      return channel;
    })();
  }
  return channelPromise;
}

async function publish(
  type: AdminUserEventType,
  data: AdminUserEventPayload
): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({ type, data });
  channel.sendToQueue(ADMIN_USER_QUEUE, Buffer.from(payload), {
    persistent: true,
  });
}

/** Fire-and-forget; an admin action must not fail if the broker is down. */
export function publishUserBannedSafe(data: AdminUserEventPayload): void {
  void publish(AdminUserEvents.USER_BANNED, data).catch((error) => {
    logger.error("Failed to publish admin.user_banned event");
    logger.error(error);
  });
}

export function publishUserUnbannedSafe(data: AdminUserEventPayload): void {
  void publish(AdminUserEvents.USER_UNBANNED, data).catch((error) => {
    logger.error("Failed to publish admin.user_unbanned event");
    logger.error(error);
  });
}

export function publishUserSuspendedSafe(data: AdminUserEventPayload): void {
  void publish(AdminUserEvents.USER_SUSPENDED, data).catch((error) => {
    logger.error("Failed to publish admin.user_suspended event");
    logger.error(error);
  });
}
