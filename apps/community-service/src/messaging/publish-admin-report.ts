import { logger } from "@aimess/logger";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";
import amqp from "amqplib";

import {
  AdminReportEvents,
  type AdminReportIngestPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";

/**
 * Publisher for `admin.report.ingest` events. backoffice-service is the
 * consumer (it owns admin_db.Report) and will assert the same queue + DLX
 * topology. Mirrors the admin.user publisher convention: one cached channel,
 * durable queue with a DLX, persistent messages, and a fire-and-forget `*Safe`
 * wrapper so creating a report never fails because the broker is down.
 */
const ADMIN_REPORT_INGEST_QUEUE = "admin.report.ingest.queue";

/**
 * Dead-letter topology for admin.report.ingest.queue. Must stay in sync with the
 * backoffice consumer; queue arguments are immutable once declared so both sides
 * MUST assert identical deadLetter* args or RabbitMQ throws PRECONDITION_FAILED.
 */
const ADMIN_REPORT_INGEST_DLX = "admin.report.ingest.dlx";
const ADMIN_REPORT_INGEST_DLQ_ROUTING_KEY = "admin.report.ingest.dead";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      // Drop the cached channel on connection loss so the next publish
      // reconnects instead of writing to a dead channel after a broker bounce.
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

async function publish(data: AdminReportIngestPayload): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({
    type: AdminReportEvents.REPORT_INGEST,
    data,
  });
  channel.sendToQueue(ADMIN_REPORT_INGEST_QUEUE, Buffer.from(payload), {
    persistent: true,
  });
}

/** Fire-and-forget; creating a report must not fail if the broker is down. */
export function publishAdminReportIngestSafe(
  data: AdminReportIngestPayload
): void {
  // Same call site feeds the admin panel's audit log: filing a report is website activity.
  publishAdminActivitySafe({
    actorId: data.reporterId,
    action: USER_AUDIT_ACTIONS.REPORT_SUBMITTED,
    targetType: data.type,
    targetId: data.targetId,
    after: { reason: data.reason, reportedUserId: data.reportedUserId ?? null },
    eventAt: data.eventAt,
  });
  void publish(data).catch((error) => {
    logger.error("Failed to publish admin.report.ingest event");
    logger.error(error);
  });
}
