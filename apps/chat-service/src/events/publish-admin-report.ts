import { logger } from "@aimess/logger";
import * as amqp from "amqplib";

import {
  AdminReportEvents,
  type AdminReportIngestPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";

/**
 * Durable queue carrying normalized report rows to backoffice-service, which
 * writes them into admin_db.Report. Publisher (here) and consumer
 * (backoffice-service) MUST assert identical queue + DLX args — RabbitMQ queue
 * args are immutable.
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

/**
 * Fire-and-forget publish of a normalized report row. Best-effort: a failure is
 * logged, never thrown, so reporting a message never fails on its ingest event.
 */
export function publishAdminReportIngestSafe(
  data: AdminReportIngestPayload
): void {
  const url = env.RABBITMQ_URL;
  if (!url) return; // RabbitMQ not configured — skip (matches event consumer guard)
  void (async () => {
    try {
      const channel = await getChannel(url);
      const payload = JSON.stringify({
        type: AdminReportEvents.REPORT_INGEST,
        data,
      });
      channel.sendToQueue(ADMIN_REPORT_INGEST_QUEUE, Buffer.from(payload), {
        persistent: true,
      });
    } catch (error) {
      channelPromise = null;
      logger.warn(
        `Failed to publish admin.report.ingest for ${data.sourceReportId}: ${String(error)}`
      );
    }
  })();
}
