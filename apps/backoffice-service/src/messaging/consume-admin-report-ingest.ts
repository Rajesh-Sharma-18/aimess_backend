import { logger } from "@aimess/logger";
import amqp from "amqplib";

import {
  AdminReportEvents,
  type AdminReportIngestPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";

/**
 * Consumer for `admin.report.ingest` — normalized report rows published by
 * community-service and chat-service. Writes them into admin_db.Report.
 * Publisher and consumer MUST assert identical queue + DLX args (RabbitMQ queue
 * args are immutable); a malformed/parse-failed message is nacked without
 * requeue so it dead-letters rather than spinning forever.
 */
const ADMIN_REPORT_INGEST_QUEUE = "admin.report.ingest.queue";
const ADMIN_REPORT_INGEST_DLX = "admin.report.ingest.dlx";
const ADMIN_REPORT_INGEST_DLQ_ROUTING_KEY = "admin.report.ingest.dead";

const VALID_TYPES = new Set(["user", "community", "message", "stream"]);

export async function handleReportIngest(
  data: AdminReportIngestPayload
): Promise<void> {
  if (
    !data ||
    !VALID_TYPES.has(data.type) ||
    !data.targetId ||
    !data.reporterId ||
    !data.reason
  ) {
    throw new Error("Malformed admin.report.ingest payload");
  }
  const created = await prisma.report.create({
    data: {
      type: data.type,
      targetId: data.targetId,
      reporterId: data.reporterId,
      reason: data.reason,
      details: data.details ?? null,
      status: "open",
    },
  });
  // sourceReportId ties this admin_db row back to the upstream report row.
  logger.info(
    `Ingested report ${created.id} (type=${data.type} target=${data.targetId} source=${data.sourceReportId})`
  );
}

export async function startAdminReportIngestConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(ADMIN_REPORT_INGEST_DLX, "direct", {
    durable: true,
  });
  await channel.assertQueue(ADMIN_REPORT_INGEST_QUEUE, {
    durable: true,
    deadLetterExchange: ADMIN_REPORT_INGEST_DLX,
    deadLetterRoutingKey: ADMIN_REPORT_INGEST_DLQ_ROUTING_KEY,
  });
  await channel.prefetch(10);

  logger.info("Admin report ingest consumer started");

  void channel.consume(ADMIN_REPORT_INGEST_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: AdminReportIngestPayload;
        };
        if (parsed.type !== AdminReportEvents.REPORT_INGEST) {
          channel.nack(message, false, false);
          return;
        }
        await handleReportIngest(parsed.data);
        channel.ack(message);
      } catch (error) {
        // Deterministic/parse error → drop (no requeue) so it DLQs rather than
        // spinning forever.
        logger.error(
          "Admin report ingest consumer failed to process message",
          error
        );
        channel.nack(message, false, false);
      }
    })();
  });
}
