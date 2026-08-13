import { randomUUID } from "node:crypto";

import * as amqp from "amqplib";

import { logger } from "@aimess/logger";
import {
  AdminActivityEvents,
  type AdminActivityIngestPayload,
} from "@aimess/shared-types";

// Durable queue carrying end-user activity rows to backoffice-service, which writes them
// into admin_db.AuditLog with actorType=USER. Publisher (here, shared by every business
// service) and consumer MUST assert identical queue + DLX args — queue args are immutable.
const ADMIN_ACTIVITY_INGEST_QUEUE = "admin.activity.ingest.queue";
const ADMIN_ACTIVITY_INGEST_DLX = "admin.activity.ingest.dlx";
const ADMIN_ACTIVITY_INGEST_DLQ_ROUTING_KEY = "admin.activity.ingest.dead";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(url: string): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(url);
      connection.on("close", () => {
        channelPromise = null;
      });
      connection.on("error", (err: Error) => {
        logger.error("admin.activity.ingest publisher connection error", err);
      });
      const channel = await connection.createChannel();
      await channel.assertExchange(ADMIN_ACTIVITY_INGEST_DLX, "direct", {
        durable: true,
      });
      await channel.assertQueue(ADMIN_ACTIVITY_INGEST_QUEUE, {
        durable: true,
        deadLetterExchange: ADMIN_ACTIVITY_INGEST_DLX,
        deadLetterRoutingKey: ADMIN_ACTIVITY_INGEST_DLQ_ROUTING_KEY,
      });
      return channel;
    })();
  }
  return channelPromise;
}

// Caller-facing input: `eventAt`, `eventId` and `actorType` are filled in here so no
// call site has to — an actorId means a user acted, its absence means the platform did.
export type AdminActivityInput = Omit<
  AdminActivityIngestPayload,
  "eventAt" | "eventId" | "actorType"
> & {
  actorType?: AdminActivityIngestPayload["actorType"];
  eventAt?: string;
  eventId?: string;
};

function toPayload(data: AdminActivityInput): AdminActivityIngestPayload {
  return {
    ...data,
    actorType: data.actorType ?? (data.actorId ? "USER" : "SYSTEM"),
    eventAt: data.eventAt ?? new Date().toISOString(),
    eventId: data.eventId ?? randomUUID(),
  };
}

/**
 * Fire-and-forget publish of one end-user activity row. Best-effort by design: a
 * failure is logged, never thrown, so a login/join/kick never fails on its audit event.
 * No-ops when RABBITMQ_URL is unset (matches the report-ingest publisher's guard).
 */
export function publishAdminActivitySafe(data: AdminActivityInput): void {
  const url = process.env.RABBITMQ_URL;
  if (!url) {
    // Silent no-ops here cost an audit row, so say it once per process instead.
    warnMissingBrokerOnce();
    return;
  }
  const payload = toPayload(data);
  void (async () => {
    try {
      const channel = await getChannel(url);
      channel.sendToQueue(
        ADMIN_ACTIVITY_INGEST_QUEUE,
        Buffer.from(
          JSON.stringify({
            type: AdminActivityEvents.ACTIVITY_INGEST,
            data: payload,
          })
        ),
        { persistent: true }
      );
    } catch (error) {
      channelPromise = null;
      logger.warn(
        `Failed to publish admin.activity.ingest ${payload.action}: ${String(error)}`
      );
    }
  })();
}

let warnedMissingBroker = false;
function warnMissingBrokerOnce(): void {
  if (warnedMissingBroker) return;
  warnedMissingBroker = true;
  logger.warn(
    "RABBITMQ_URL is unset — admin.activity.ingest events are being dropped, so website activity will not reach the admin audit log"
  );
}

/**
 * Awaitable publish, for backfill/ops scripts that must know the message actually
 * reached the broker before the process exits. Throws on failure (unlike the Safe
 * variant, a backfill wants to know it lost rows).
 */
export async function publishAdminActivity(
  data: AdminActivityInput
): Promise<void> {
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error("RABBITMQ_URL is not set");
  const channel = await getChannel(url);
  const payload = toPayload(data);
  const written = channel.sendToQueue(
    ADMIN_ACTIVITY_INGEST_QUEUE,
    Buffer.from(
      JSON.stringify({
        type: AdminActivityEvents.ACTIVITY_INGEST,
        data: payload,
      })
    ),
    { persistent: true }
  );
  // sendToQueue returns false when the socket buffer is full — wait for drain so a
  // few-thousand-row backfill can't outrun the connection and silently lose messages.
  if (!written) {
    await new Promise<void>((resolve) =>
      channel.once("drain", () => resolve())
    );
  }
}

/** Flush + close the shared channel so a script's event loop can drain and exit. */
export async function closeAdminActivityPublisher(): Promise<void> {
  const pending = channelPromise;
  channelPromise = null;
  if (!pending) return;
  try {
    const channel = await pending;
    await channel.close();
  } catch {
    // Already closed / never opened — nothing to release.
  }
}

/**
 * Deterministic idempotency key for replayed history: the same source row always
 * produces the same `eventId`, and the consumer swallows the duplicate insert, so a
 * backfill can be re-run any number of times without doubling rows.
 */
export function backfillEventId(
  source: string,
  sourceRowId: string,
  facet?: string
): string {
  return `backfill:${source}:${sourceRowId}${facet ? `:${facet}` : ""}`;
}
