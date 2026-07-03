import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { env } from "../config/env.js";
import type { AnnouncementTarget } from "../types/announcement.types.js";

/**
 * Queue 1 — the pagination-cursor driver for announcement delivery. backoffice-
 * service both publishes and consumes this queue: each message resolves ONE
 * page of the audience (bounded work), then either re-publishes the next
 * cursor or marks the announcement SENT. Mirrors the DLX topology used by
 * `publish-admin-user-event.ts` — a batch that keeps failing lands in the DLQ
 * instead of looping forever.
 */
const ANNOUNCEMENT_DELIVERY_QUEUE = "announcement.delivery.queue";
const ANNOUNCEMENT_DELIVERY_DLX = "announcement.delivery.queue.dlx";
const ANNOUNCEMENT_DELIVERY_DLQ_ROUTING_KEY =
  "announcement.delivery.queue.dead";

export type AnnouncementDeliverMessage = {
  announcementId: string;
  title: string;
  description: string;
  target: AnnouncementTarget;
  communityId: string | null;
  cursor: number;
  limit: number;
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
        logger.error("announcement.delivery.queue connection error");
        logger.error(error);
      });
      const channel = await connection.createChannel();
      await channel.assertExchange(ANNOUNCEMENT_DELIVERY_DLX, "direct", {
        durable: true,
      });
      await channel.assertQueue(ANNOUNCEMENT_DELIVERY_QUEUE, {
        durable: true,
        deadLetterExchange: ANNOUNCEMENT_DELIVERY_DLX,
        deadLetterRoutingKey: ANNOUNCEMENT_DELIVERY_DLQ_ROUTING_KEY,
      });
      return channel;
    })();
  }
  return channelPromise;
}

async function publish(data: AnnouncementDeliverMessage): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({ type: "announcement.deliver", data });
  channel.sendToQueue(ANNOUNCEMENT_DELIVERY_QUEUE, Buffer.from(payload), {
    persistent: true,
  });
}

/**
 * Fire-and-forget entry point used by the create-announcement service call and
 * the scheduler poller. A publish failure here just means delivery never
 * starts for this announcement — logged, not thrown, so the admin request
 * (or scheduler tick) never fails because the broker is down.
 */
export function enqueueAnnouncementDeliverySafe(
  data: AnnouncementDeliverMessage
): void {
  void publish(data).catch((error) => {
    logger.error(
      `Failed to enqueue announcement delivery for ${data.announcementId}`
    );
    logger.error(error);
  });
}

/**
 * Non-swallowing publish used INSIDE the delivery consumer to re-publish the
 * next cursor. If this throws, the caller must nack the current message so
 * the whole batch (including the un-published next cursor) is retried —
 * silently losing this would strand the remaining pages of the audience.
 */
export function publishAnnouncementDeliveryCursor(
  data: AnnouncementDeliverMessage
): Promise<void> {
  return publish(data);
}

export { ANNOUNCEMENT_DELIVERY_QUEUE };
