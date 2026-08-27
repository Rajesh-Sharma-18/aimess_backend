import { logger } from "@aimess/logger";
import amqp from "amqplib";

import {
  AdminUserEvents,
  type AdminUserEventPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { accountBanService } from "../services/account-ban.service.js";
import { publishAdminUserNotifySafe } from "./publish-admin-user-notify.js";

/**
 * admin.user.queue carries backoffice ban/suspend/unban events. auth-service is
 * the SOLE consumer: it owns AuthUser sessions, so it force-logs-out the user on
 * ban/suspend and (when notifyUser is set) re-publishes a notify-ready message to
 * admin.user.notify.queue for notifications-service.
 *
 * The queue + DLX topology MUST stay identical to the backoffice publisher
 * (apps/backoffice-service/src/messaging/publish-admin-user-event.ts) — RabbitMQ
 * queue/exchange arguments are immutable once declared, so a mismatch throws
 * PRECONDITION_FAILED (406).
 */
const ADMIN_USER_QUEUE = "admin.user.queue";
const ADMIN_USER_DLX = "admin.user.queue.dlx";
const ADMIN_USER_DLQ = "admin.user.queue.dlq";
const ADMIN_USER_DLQ_ROUTING_KEY = "admin.user.queue.dead";

const PREFETCH = 10;

/**
 * LEGACY FALLBACK copy per admin action, in `STORED_TEXT_LOCALE` (English).
 *
 * Do NOT localize these here: this consumer runs on an admin's action and has
 * no idea what language the affected USER reads in. notifications-service picks
 * the matching `accountCopy` builder off the event type and renders it per
 * recipient and per device (`admin-user.consumer.ts`); these strings only
 * answer for an event type that build does not recognize.
 */
const NOTIFY_COPY: Record<string, { title: string; body: string } | undefined> =
  {
    [AdminUserEvents.USER_BANNED]: {
      title: "Account banned",
      body: "Your account has been banned. Reach out to support if you think this is a mistake.",
    },
    [AdminUserEvents.USER_SUSPENDED]: {
      title: "Account suspended",
      body: "Your account is temporarily suspended",
    },
    [AdminUserEvents.USER_UNBANNED]: {
      title: "Welcome back",
      body: "Your account has been reinstated",
    },
  };

/**
 * Retry amqp.connect with exponential backoff (2s → 4s → … → 30s cap) to cover
 * the Docker/pnpm-dev startup race where RabbitMQ is still initialising.
 */
async function connectWithRetry(
  url: string,
  retries = 8
): Promise<amqp.ChannelModel> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await amqp.connect(url);
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = Math.min(2000 * attempt, 30_000);
      logger.warn(
        `RabbitMQ connection attempt ${String(attempt)}/${String(retries)} failed — retrying in ${String(delay / 1000)}s`
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  /* istanbul ignore next */
  throw new Error("connectWithRetry: unreachable");
}

/**
 * Revoke every active session for a user (admin force-logout). Naturally
 * idempotent: revokeAllForUser filters on revokedAt:null, so a replay is a no-op.
 * Shared with the AdminSetAccountStatus gRPC path so both behave identically.
 */
async function forceLogout(userId: string): Promise<void> {
  await accountBanService.revokeEverySession(userId, "terminated");
}

/**
 * Has a LATER admin action already superseded this message?
 *
 * `admin.user.queue` is at-least-once and RabbitMQ gives no ordering guarantee
 * across redeliveries, so without this a stale `admin.user_banned` replayed
 * after an unban would silently re-ban a reinstated account. Every status write
 * touches AuthUser.updatedAt, so an account modified after the event was
 * published means something newer won — skip the state change (the notify and
 * force-logout halves are harmless and still run).
 */
async function isSuperseded(
  userId: string,
  eventAt: string | undefined
): Promise<boolean> {
  if (!eventAt) return false;
  const publishedAt = new Date(eventAt).getTime();
  if (!Number.isFinite(publishedAt)) return false;
  const row = await prisma.authUser.findUnique({
    where: { id: userId },
    select: { updatedAt: true },
  });
  if (!row) return true;
  return row.updatedAt.getTime() > publishedAt;
}

/** Re-publish a notify-ready message for notifications-service (best-effort). */
function notify(type: string, data: AdminUserEventPayload): void {
  const copy = NOTIFY_COPY[type];
  if (!copy) return;
  publishAdminUserNotifySafe({
    userId: data.userId,
    type,
    title: copy.title,
    body: copy.body,
    data: {
      actorId: data.actorId,
      ...(data.reason ? { reason: data.reason } : {}),
      ...(data.suspendedUntil ? { suspendedUntil: data.suspendedUntil } : {}),
    },
  });
}

async function handleAdminUserEvent(
  type: string,
  data: AdminUserEventPayload
): Promise<void> {
  switch (type) {
    // Permanent system ban. backoffice applies this synchronously over gRPC
    // BEFORE publishing, so by the time this runs the account is normally
    // already BANNED — re-applying is an idempotent no-op. This branch exists
    // as the safety net for the case where the gRPC call was lost.
    case AdminUserEvents.USER_BANNED: {
      if (await isSuperseded(data.userId, data.at)) {
        logger.warn(
          `Skipping superseded admin.user_banned for user=${data.userId}`
        );
      } else {
        await accountBanService.apply({
          userId: data.userId,
          reason: data.reason ?? null,
          actorAdminId: data.actorId,
        });
      }
      if (data.notifyUser) {
        notify(type, data);
      }
      break;
    }

    // Time-boxed suspend keeps its original behaviour: sessions only. It must
    // NOT write BANNED — that status is permanent and nothing expires it.
    case AdminUserEvents.USER_SUSPENDED: {
      if (data.forceLogout) {
        await forceLogout(data.userId);
      }
      if (data.notifyUser) {
        notify(type, data);
      }
      break;
    }

    case AdminUserEvents.USER_UNBANNED: {
      // Sessions cannot be un-revoked; the user signs in fresh. Lifting the
      // status + ban flag is what makes that sign-in possible again.
      if (await isSuperseded(data.userId, data.at)) {
        logger.warn(
          `Skipping superseded admin.user_unbanned for user=${data.userId}`
        );
      } else {
        await accountBanService
          .lift({ userId: data.userId, actorAdminId: data.actorId })
          .catch((err: unknown) => {
            // A deleted/missing account is not an error worth dead-lettering.
            logger.warn(
              `admin.user_unbanned lift skipped for user=${data.userId}: ${String(err)}`
            );
          });
      }
      if (data.notifyUser) {
        notify(type, data);
      }
      break;
    }

    default:
      logger.warn(`Unknown admin.user event type: ${type}`);
  }
}

/**
 * Consume admin.user.queue. On a processing error we nack(no requeue) so the
 * message dead-letters rather than spinning forever.
 */
export async function startAdminUserConsumer(): Promise<void> {
  const connection = await connectWithRetry(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(ADMIN_USER_DLX, "direct", { durable: true });
  await channel.assertQueue(ADMIN_USER_QUEUE, {
    durable: true,
    deadLetterExchange: ADMIN_USER_DLX,
    deadLetterRoutingKey: ADMIN_USER_DLQ_ROUTING_KEY,
  });
  // Bind a durable dead-letter queue to the DLX so a nack(no-requeue) on a
  // transient failure (DB/Redis blip mid force-logout) is RETAINED for replay
  // rather than routed to an exchange with no queue and silently dropped — the
  // ban's session-revocation must not be lost.
  await channel.assertQueue(ADMIN_USER_DLQ, { durable: true });
  await channel.bindQueue(
    ADMIN_USER_DLQ,
    ADMIN_USER_DLX,
    ADMIN_USER_DLQ_ROUTING_KEY
  );

  await channel.prefetch(PREFETCH);

  logger.info(
    `Auth-service admin.user consumer listening on ${ADMIN_USER_QUEUE}`
  );

  void channel.consume(ADMIN_USER_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: AdminUserEventPayload;
        };

        await handleAdminUserEvent(parsed.type, parsed.data);
        channel.ack(message);
      } catch (error) {
        if (error instanceof SyntaxError) {
          // Malformed body — dead-letter so the consumer is not wedged.
          logger.error("Discarding malformed admin.user message body");
          logger.error(error);
          channel.nack(message, false, false);
          return;
        }

        // Transient failure (DB/Redis down) — dead-letter for later replay.
        logger.error("Failed to process admin.user event");
        logger.error(error);
        channel.nack(message, false, false);
      }
    })();
  });
}
