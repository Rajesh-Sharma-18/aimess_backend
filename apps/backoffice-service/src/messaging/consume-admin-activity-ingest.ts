import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { resolveAuditSource } from "@aimess/constants";
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
// Without a queue bound to the DLX, a dead-lettered event is discarded by the broker
// and the evidence of the bad publish goes with it. Bind one so poison messages are
// inspectable instead of silently gone.
const ADMIN_ACTIVITY_INGEST_DLQ = "admin.activity.ingest.dlq";
/** How long to wait before redelivering after a transient (infrastructure) failure. */
const REQUEUE_DELAY_MS = 5_000;

const KNOWN_ACTIONS = new Set<string>(Object.values(USER_AUDIT_ACTIONS));
// Server-side allowlist for the publisher-declared source. An unrecognized value is
// normalized rather than rejected: a publisher on an older build sends none at all,
// and losing the row would be worse than losing the attribution.
const KNOWN_SOURCES = new Set<string>([
  "ADMIN_PANEL",
  "WEB",
  "ANDROID",
  "IOS",
  "SYSTEM",
]);
// Which of those a person can actually have acted from. A user row may hold only
// these — see resolveIngestSource.
const CLIENT_SOURCES = new Set<string>([
  "ADMIN_PANEL",
  "WEB",
  "ANDROID",
  "IOS",
]);

/**
 * Mirrors the publisher's rule so an older service still on the previous build
 * cannot land a user action attributed to the platform: a row with an actor names
 * the client that actor used, falling back to the stored user-agent and finally to
 * WEB. SYSTEM is reserved for actor-less rows (sweepers, tripwires, consumers).
 */
function resolveIngestSource(data: AdminActivityIngestPayload): AuditSource {
  const declared =
    data.source && KNOWN_SOURCES.has(data.source) ? data.source : null;
  if (data.actorType !== "USER") return (declared ?? "SYSTEM") as AuditSource;
  if (declared && CLIENT_SOURCES.has(declared)) return declared as AuditSource;
  const sniffed = data.userAgent
    ? resolveAuditSource({ "user-agent": data.userAgent })
    : null;
  return (
    sniffed && CLIENT_SOURCES.has(sniffed) ? sniffed : "WEB"
  ) as AuditSource;
}
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

/**
 * A message that will never succeed no matter how often it is redelivered — a
 * malformed payload, an unknown action, a bad actor. Only these are dead-lettered;
 * anything else (a DB outage, a dropped pool connection) is transient and must be
 * retried, or a five-minute database blip would silently erase audit history.
 */
export class UnprocessableActivityEvent extends Error {
  override readonly name = "UnprocessableActivityEvent";
}

export async function handleActivityIngest(
  data: AdminActivityIngestPayload
): Promise<void> {
  if (!data || !data.action || !data.targetType || !data.eventId) {
    throw new UnprocessableActivityEvent(
      "Malformed admin.activity.ingest payload"
    );
  }
  // An unknown action would silently pollute the filter dropdown; reject it loudly
  // (DLQ) so a publisher typo surfaces instead of landing an unfilterable row.
  if (!KNOWN_ACTIONS.has(data.action)) {
    throw new UnprocessableActivityEvent(
      `Unknown admin.activity.ingest action "${data.action}"`
    );
  }
  if (data.actorType !== "USER" && data.actorType !== "SYSTEM") {
    throw new UnprocessableActivityEvent(
      `Invalid admin.activity.ingest actorType "${String(data.actorType)}"`
    );
  }
  // actorId is a uuid column: a non-uuid would fail the insert at the driver with an
  // opaque error, so normalize an unusable value to null (SYSTEM rows carry none anyway).
  const actorId =
    data.actorId && UUID_PATTERN.test(data.actorId) ? data.actorId : null;
  if (data.actorType === "USER" && !actorId) {
    throw new UnprocessableActivityEvent(
      "admin.activity.ingest USER row is missing a valid actorId"
    );
  }

  const before = toJsonOrSkip(data.before);
  const after = toJsonOrSkip(data.after);
  const source = resolveIngestSource(data);

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

// A dropped broker connection used to end website-activity ingestion for the rest of
// the process's life: publishers kept filling the durable queue and nothing drained it,
// so every website/Android/iOS action silently stopped reaching the audit log until a
// manual restart. The queue is durable, so re-attaching replays everything that piled up.
const RECONNECT_DELAY_MS = 5_000;

let activeConnection: amqp.ChannelModel | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void openActivityIngestConsumer().catch((error) => {
      logger.warn(
        `Admin activity ingest consumer reconnect failed, retrying: ${String(error)}`
      );
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
  // Never hold the event loop open on this timer alone.
  reconnectTimer.unref();
}

async function openActivityIngestConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  activeConnection = connection;

  connection.on("error", (error: Error) => {
    logger.warn(
      `Admin activity ingest consumer connection error: ${error.message}`
    );
  });
  // Only the connection currently in use may trigger a reconnect — a late `close`
  // from a superseded connection must not spawn a second consumer.
  connection.on("close", () => {
    if (activeConnection !== connection) return;
    activeConnection = null;
    logger.warn("Admin activity ingest consumer disconnected — reconnecting");
    scheduleReconnect();
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
  await channel.assertQueue(ADMIN_ACTIVITY_INGEST_DLQ, { durable: true });
  await channel.bindQueue(
    ADMIN_ACTIVITY_INGEST_DLQ,
    ADMIN_ACTIVITY_INGEST_DLX,
    ADMIN_ACTIVITY_INGEST_DLQ_ROUTING_KEY
  );
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
        if (
          error instanceof UnprocessableActivityEvent ||
          error instanceof SyntaxError
        ) {
          logger.error(
            "Admin activity ingest consumer rejected an unprocessable message",
            error
          );
          channel.nack(message, false, false);
          return;
        }
        // Anything else is infrastructure (DB down, pool exhausted). Requeue so the
        // row survives the outage — dropping it would lose audit history that no
        // later retry can reconstruct. Delayed so a sustained outage redelivers
        // slowly instead of spinning the broker and the log.
        logger.error(
          "Admin activity ingest consumer failed to process message; requeueing",
          error
        );
        setTimeout(() => {
          try {
            channel.nack(message, false, true);
          } catch {
            // Channel already gone — the unacked message returns to the queue on close.
          }
        }, REQUEUE_DELAY_MS).unref();
      }
    })();
  });
}

export async function startAdminActivityIngestConsumer(): Promise<void> {
  try {
    await openActivityIngestConsumer();
  } catch (error) {
    // server.ts bounds the FIRST attempt with a 5s race, so a broker that is merely
    // slow at boot must not disable ingestion for the lifetime of the process.
    scheduleReconnect();
    throw error;
  }
}
