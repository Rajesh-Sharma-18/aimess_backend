import amqp from "amqplib";
import {
  AdminAuthEvents,
  AuthEvents,
  type EmailChangedPayload,
  type PasswordChangedPayload,
  type SecurityNewLoginPayload,
} from "@aimess/shared-types";
import { NotificationEvents } from "../events/notification.events.js";
import {
  handleAdminPasswordResetOtpRequested,
  handleChangeEmailOtpRequested,
  handleLinkEmailOtpRequested,
  handlePasswordResetOtpRequested,
  handleUserRegistered,
} from "../handlers/notification.handler.js";
import { env } from "../config/env.js";
import { logger } from "@aimess/logger";
import { buildNewLoginNotification } from "../lib/new-login-notification.js";
import { pushToUser } from "../services/push.service.js";

const QUEUE_NAME = "notification.queue";

/**
 * Dead-letter topology for notification.queue. Must stay in sync with every
 * publisher (e.g. auth-service publish-password-reset-otp.ts); queue arguments
 * are immutable once declared so all sides MUST assert identical deadLetter*
 * args or RabbitMQ throws PRECONDITION_FAILED.
 */
const NOTIFICATION_DLX = "notification.queue.dlx";
const NOTIFICATION_DLQ = "notification.queue.dlq";
const NOTIFICATION_DLQ_ROUTING_KEY = "notification.queue.dead";

function isPreconditionFailed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: number }).code === 406
  );
}

async function assertExchangeWithRecovery(
  channel: amqp.Channel,
  exchange: string,
  type: string,
  options: amqp.Options.AssertExchange
) {
  try {
    return await channel.assertExchange(exchange, type, options);
  } catch (error) {
    if (isPreconditionFailed(error)) {
      logger.warn(
        `RabbitMQ exchange ${exchange} precondition failed; deleting and recreating it.`
      );
      await channel.deleteExchange(exchange);
      return await channel.assertExchange(exchange, type, options);
    }
    throw error;
  }
}

async function assertQueueWithRecovery(
  channel: amqp.Channel,
  queue: string,
  options: amqp.Options.AssertQueue
) {
  try {
    return await channel.assertQueue(queue, options);
  } catch (error) {
    if (isPreconditionFailed(error)) {
      logger.warn(
        `RabbitMQ queue ${queue} declared with mismatched arguments; deleting and recreating it.`
      );
      await channel.deleteQueue(queue);
      return await channel.assertQueue(queue, options);
    }
    throw error;
  }
}

/**
 * Retry amqp.connect with exponential backoff (2s → 4s → … → 30s cap).
 * Covers the startup race where RabbitMQ is still initialising when the
 * service boots alongside it in Docker Compose / pnpm dev.
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

export async function startConsumer() {
  const connection = await connectWithRetry(env.RABBITMQ_URL);

  const channel = await connection.createChannel();

  await assertExchangeWithRecovery(channel, NOTIFICATION_DLX, "direct", {
    durable: true,
  });
  await assertQueueWithRecovery(channel, NOTIFICATION_DLQ, {
    durable: true,
  });
  await channel.bindQueue(
    NOTIFICATION_DLQ,
    NOTIFICATION_DLX,
    NOTIFICATION_DLQ_ROUTING_KEY
  );

  await assertQueueWithRecovery(channel, QUEUE_NAME, {
    durable: true,
    deadLetterExchange: NOTIFICATION_DLX,
    deadLetterRoutingKey: NOTIFICATION_DLQ_ROUTING_KEY,
  });
  await channel.prefetch(10);

  logger.info("Notification consumer started");

  channel.consume(QUEUE_NAME, async (message) => {
    if (!message) return;

    try {
      const parsed = JSON.parse(message.content.toString());

      switch (parsed.type) {
        case NotificationEvents.USER_REGISTERED:
          await handleUserRegistered(parsed.data);
          break;

        case AuthEvents.PASSWORD_RESET_OTP_REQUESTED:
          await handlePasswordResetOtpRequested(parsed.data);
          break;
        case AuthEvents.LINK_EMAIL_OTP_REQUESTED:
          await handleLinkEmailOtpRequested(parsed.data);
          break;
        case AuthEvents.CHANGE_EMAIL_OTP_REQUESTED:
          await handleChangeEmailOtpRequested(parsed.data);
          break;
        case AdminAuthEvents.PASSWORD_RESET_OTP_REQUESTED:
          await handleAdminPasswordResetOtpRequested(parsed.data);
          break;

        case AuthEvents.SECURITY_NEW_LOGIN: {
          const p = parsed.data as SecurityNewLoginPayload;
          await pushToUser(buildNewLoginNotification(parsed.type, p));
          break;
        }
        case AuthEvents.PASSWORD_CHANGED: {
          const p = parsed.data as PasswordChangedPayload;
          await pushToUser({
            userId: p.userId,
            category: "systemEnabled",
            type: parsed.type,
            bypassSettings: true,
            title: "Password changed",
            body: "Your password was changed successfully.",
          });
          break;
        }
        case AuthEvents.EMAIL_CHANGED: {
          const p = parsed.data as EmailChangedPayload;
          await pushToUser({
            userId: p.userId,
            category: "systemEnabled",
            type: parsed.type,
            bypassSettings: true,
            title: "Email changed",
            body: "Your account email was changed successfully.",
          });
          break;
        }

        default:
          logger.error(`Unknown notification event type: ${parsed.type}`);
      }

      channel.ack(message);
    } catch (error) {
      logger.error(error);
      // Avoid infinite loops on deterministic errors (bad payload, SMTP auth, etc.).
      channel.nack(message, false, false);
    }
  });
}
