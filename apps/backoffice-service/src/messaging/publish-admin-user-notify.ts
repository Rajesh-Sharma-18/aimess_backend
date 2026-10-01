import { logger } from "@aimess/logger";
import { type AdminUserNotifyPayload } from "@aimess/shared-types";
import amqp from "amqplib";

import { env } from "../config/env.js";

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
  channel.sendToQueue(
    ADMIN_USER_NOTIFY_QUEUE,
    Buffer.from(JSON.stringify({ type: data.type, data })),
    { persistent: true }
  );
}

export function publishAdminUserNotifySafe(data: AdminUserNotifyPayload): void {
  void publish(data).catch((error: unknown) => {
    channelPromise = null;
    logger.error("Failed to publish admin.user.notify event", { error });
  });
}
