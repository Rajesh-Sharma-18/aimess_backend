import { logger } from "@aimess/logger";
import amqp from "amqplib";

import {
  AdminReportEvents,
  type AdminReportIngestPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";

/**
 * Publisher for `admin.report.ingest` events fired by stream-service (livestream
 * comment reports). Shape + topology must match community-service's mirror
 * publisher exactly: identical queue name, DLX, and queue args — RabbitMQ
 * treats queue args as immutable so any drift throws PRECONDITION_FAILED at
 * assertQueue time. See apps/community-service/src/messaging/publish-admin-report.ts.
 */
const ADMIN_REPORT_INGEST_QUEUE = "admin.report.ingest.queue";
const ADMIN_REPORT_INGEST_DLX = "admin.report.ingest.dlx";
const ADMIN_REPORT_INGEST_DLQ_ROUTING_KEY = "admin.report.ingest.dead";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(url: string): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(url);
      connection.on("close", () => {
        channelPromise = null;
      });
      connection.on("error", (err: Error) => {
        logger.error("admin.report.ingest publisher connection error", err);
      });
      const channel = await connection.createChannel();
      await channel.assertExchange(ADMIN_REPORT_INGEST_DLX, "direct", {
        durable: true,
      });
      await channel.assertQueue(ADMIN_REPORT_INGEST_QUEUE, {
        durable: true,
        deadLetterExchange: ADMIN_REPORT_INGEST_DLX,
        deadLetterRoutingKey: ADMIN_REPORT_INGEST_DLQ_ROUTING_KEY,
      });
      return channel;
    })();
  }
  return channelPromise;
}

async function publish(
  url: string,
  data: AdminReportIngestPayload
): Promise<void> {
  const channel = await getChannel(url);
  const payload = JSON.stringify({
    type: AdminReportEvents.REPORT_INGEST,
    data,
  });
  channel.sendToQueue(ADMIN_REPORT_INGEST_QUEUE, Buffer.from(payload), {
    persistent: true,
  });
}

/**
 * Fire-and-forget; reporting a comment must not fail if the broker is down.
 * No-ops when RABBITMQ_URL is unset (stream-service can run standalone in dev).
 */
export function publishAdminReportIngestSafe(
  data: AdminReportIngestPayload
): void {
  const url = env.RABBITMQ_URL;
  if (!url) return;
  void publish(url, data).catch((error) => {
    logger.error("Failed to publish admin.report.ingest event");
    logger.error(error);
  });
}
