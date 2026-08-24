import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { env } from "../config/env.js";
import type {
  AnnouncementDeviceType,
  AnnouncementKind,
} from "../types/announcement.types.js";

/**
 * Queue 2 — one resolved batch of recipient userIds (max 100), consumed by
 * notifications-service via `pushToUsers`. Plain durable queue, no DLX: push
 * fan-out (`pushToUser`/`pushToUsers`) never throws, so there is nothing
 * meaningful to dead-letter here (same precedent as `chat.message.queue`).
 */
const NOTIFICATION_ANNOUNCEMENT_QUEUE = "notification.announcement.queue";

export type NotificationAnnouncementBatchMessage = {
  announcementId: string;
  title: string;
  body: string;
  kind: AnnouncementKind;
  /** Which device platforms notifications-service may deliver to. */
  deviceType: AnnouncementDeviceType;
  userIds: string[];
  batchId: string;
};

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      connection.on("close", () => {
        channelPromise = null;
      });
      connection.on("error", (error) => {
        logger.error("notification.announcement.queue connection error");
        logger.error(error);
      });
      const channel = await connection.createChannel();
      await channel.assertQueue(NOTIFICATION_ANNOUNCEMENT_QUEUE, {
        durable: true,
      });
      return channel;
    })();
  }
  return channelPromise;
}

async function publish(
  data: NotificationAnnouncementBatchMessage
): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({
    type: "notification.announcement_batch",
    data,
  });
  channel.sendToQueue(NOTIFICATION_ANNOUNCEMENT_QUEUE, Buffer.from(payload), {
    persistent: true,
  });
}

/**
 * Called from inside the delivery consumer (consume-announcement-delivery.ts).
 * Intentionally NOT swallowed — a publish failure here must fail the current
 * delivery-cursor message so the whole page (including this batch) retries,
 * rather than silently skipping a batch of recipients.
 */
export function publishNotificationAnnouncementBatch(
  data: NotificationAnnouncementBatchMessage
): Promise<void> {
  return publish(data);
}

export { NOTIFICATION_ANNOUNCEMENT_QUEUE };
