import { logger } from "@aimess/logger";
import { type AdminUserNotifyPayload } from "@aimess/shared-types";
import amqp from "amqplib";

import { env } from "../config/env.js";

/**
 * Notify-ready bridge queue: auth-service re-publishes admin ban/suspend/unban
 * actions here after processing admin.user.queue, and notifications-service
 * consumes them → pushToUser. Plain durable queue (NOT an exchange), matching the
 * project's async fan-out convention; envelope is JSON.stringify({ type, data }).
 */
const ADMIN_USER_NOTIFY_QUEUE = "admin.user.notify.queue";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      connection.on("close", () => {
        channelPromise = null;
      });
      connection.on("error", (err: Error) => {
        logger.error("admin.user.notify publisher connection error", err);
      });
      const channel = await connection.createChannel();
      await channel.assertQueue(ADMIN_USER_NOTIFY_QUEUE, { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

async function publish(data: AdminUserNotifyPayload): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({ type: data.type, data });
  channel.sendToQueue(ADMIN_USER_NOTIFY_QUEUE, Buffer.from(payload), {
    persistent: true,
  });
}

/** Fire-and-forget; notification dispatch must never fail the consumer. */
export function publishAdminUserNotifySafe(data: AdminUserNotifyPayload): void {
  void publish(data).catch((error) => {
    channelPromise = null;
    logger.error("Failed to publish admin.user.notify event");
    logger.error(error);
  });
}
