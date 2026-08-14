import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { USER_AUDIT_ACTIONS } from "@aimess/messaging";
import {
  AdminActivityEvents,
  type AdminActivityIngestPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import type { AuditSource, Prisma } from "../generated/prisma/client.js";
import { emitAuditLogCreated } from "../lib/audit-realtime.js";

// Consumer for `admin.activity.ingest` — end-user activity rows published by auth,
// user, community, chat and stream services. Writes them into admin_db.AuditLog with
// actorType=USER/SYSTEM so the admin panel's audit log shows website activity next to
// admin actions. Publisher and consumer MUST assert identical queue + DLX args.
const ADMIN_ACTIVITY_INGEST_QUEUE = "admin.activity.ingest.queue";
const ADMIN_ACTIVITY_INGEST_DLX = "admin.activity.ingest.dlx";
const ADMIN_ACTIVITY_INGEST_DLQ_ROUTING_KEY = "admin.activity.ingest.dead";

const KNOWN_ACTIONS = new Set<string>(Object.values(USER_AUDIT_ACTIONS));
// Server-side allowlist for the client-declared source. An unrecognized value is
// normalized to SYSTEM rather than rejected: a publisher on an older build sends
// none at all, and losing the row would be worse than losing the attribution.
const KNOWN_SOURCES = new Set<string>([
  "ADMIN_PANEL",
  "WEB",
  "ANDROID",
  "IOS",
  "SYSTEM",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Duck-typed P2002 check (matches consume-admin-report-ingest.ts) so the handler stays
// testable against a faked prisma singleton.
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

// JSON columns reject `undefined`; anything else is stored verbatim.
function toJsonOrSkip(
  value: unknown
): { set: true; value: Prisma.InputJsonValue } | { set: false } {
  if (value === undefined) return { set: false };
  return { set: true, value: value as Prisma.InputJsonValue };
}

export async function handleActivityIngest(
  data: AdminActivityIngestPayload
): Promise<void> {
  if (!data || !data.action || !data.targetType || !data.eventId) {
    throw new Error("Malformed admin.activity.ingest payload");
  }
  // An unknown action would silently pollute the filter dropdown; reject it loudly
  // (DLQ) so a publisher typo surfaces instead of landing an unfilterable row.
  if (!KNOWN_ACTIONS.has(data.action)) {
    throw new Error(`Unknown admin.activity.ingest action "${data.action}"`);
  }
  if (data.actorType !== "USER" && data.actorType !== "SYSTEM") {
    throw new Error(
      `Invalid admin.activity.ingest actorType "${String(data.actorType)}"`
    );
  }
  // actorId is a uuid column: a non-uuid would fail the insert at the driver with an
  // opaque error, so normalize an unusable value to null (SYSTEM rows carry none anyway).
  const actorId =
    data.actorId && UUID_PATTERN.test(data.actorId) ? data.actorId : null;
  if (data.actorType === "USER" && !actorId) {
    throw new Error(
      "admin.activity.ingest USER row is missing a valid actorId"
    );
  }

  const before = toJsonOrSkip(data.before);
  const after = toJsonOrSkip(data.after);
  const source: AuditSource =
    data.source && KNOWN_SOURCES.has(data.source)
      ? (data.source as AuditSource)
      : "SYSTEM";

  try {
    const row = await prisma.auditLog.create({
      data: {
        actorId,
        actorType: data.actorType,
        source,
        action: data.action,
        targetType: data.targetType,
        targetId: data.targetId ?? null,
        ...(before.set ? { before: before.value } : {}),
        ...(after.set ? { after: after.value } : {}),
        ip: data.ip ?? null,
        userAgent: data.userAgent ?? null,
        eventId: data.eventId,
        // Stamp the row with when the action happened, not when it was consumed.
        createdAt: new Date(data.eventAt),
      },
    });
    // Live push to any Super Admin with the audit-log page open. After the commit
    // only: a row that never landed must never appear in the list.
    void emitAuditLogCreated(row.id);
  } catch (error) {
    // eventId is unique: a redelivery after a committed write is a no-op, not a duplicate.
    if (isUniqueConstraintViolation(error)) {
      logger.info(
        `Skipped duplicate admin.activity.ingest (event=${data.eventId})`
      );
      return;
    }
    throw error;
  }
}

export async function startAdminActivityIngestConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(ADMIN_ACTIVITY_INGEST_DLX, "direct", {
    durable: true,
  });
  await channel.assertQueue(ADMIN_ACTIVITY_INGEST_QUEUE, {
    durable: true,
    deadLetterExchange: ADMIN_ACTIVITY_INGEST_DLX,
    deadLetterRoutingKey: ADMIN_ACTIVITY_INGEST_DLQ_ROUTING_KEY,
  });
  await channel.prefetch(20);

  logger.info("Admin activity ingest consumer started");

  void channel.consume(ADMIN_ACTIVITY_INGEST_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: AdminActivityIngestPayload;
        };
        if (parsed.type !== AdminActivityEvents.ACTIVITY_INGEST) {
          channel.nack(message, false, false);
          return;
        }
        await handleActivityIngest(parsed.data);
        channel.ack(message);
      } catch (error) {
        // Deterministic/parse error → drop (no requeue) so it DLQs rather than spinning.
        logger.error(
          "Admin activity ingest consumer failed to process message",
          error
        );
        channel.nack(message, false, false);
      }
    })();
  });
}
