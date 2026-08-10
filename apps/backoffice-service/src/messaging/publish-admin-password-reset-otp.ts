import { logger } from "@aimess/logger";
import { currentLocale } from "@aimess/constants";
import amqp from "amqplib";

import {
  AdminAuthEvents,
  type AdminPasswordResetOtpRequestedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";

const NOTIFICATION_QUEUE = "notification.queue";

/**
 * Dead-letter topology for notification.queue. Must stay in sync with the
 * notifications-service consumer; queue arguments are immutable once declared
 * so both sides MUST assert identical deadLetter* args or RabbitMQ throws
 * PRECONDITION_FAILED.
 */
const NOTIFICATION_DLX = "notification.queue.dlx";
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

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();

      await assertExchangeWithRecovery(channel, NOTIFICATION_DLX, "direct", {
        durable: true,
      });
      await assertQueueWithRecovery(channel, NOTIFICATION_QUEUE, {
        durable: true,
        deadLetterExchange: NOTIFICATION_DLX,
        deadLetterRoutingKey: NOTIFICATION_DLQ_ROUTING_KEY,
      });
      return channel;
    })();
  }
  return channelPromise;
}

export async function publishAdminPasswordResetOtp(
  data: AdminPasswordResetOtpRequestedPayload
): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({
    type: AdminAuthEvents.PASSWORD_RESET_OTP_REQUESTED,
    // The admin has no session yet (this IS the reset flow), so the email
    // follows the `x-lang` of the request that asked for it.
    data: { ...data, locale: currentLocale() },
  });
  channel.sendToQueue(NOTIFICATION_QUEUE, Buffer.from(payload), {
    persistent: true,
  });
}

/** Fire-and-forget; OTP request must not fail if the broker is down. */
export function publishAdminPasswordResetOtpSafe(
  data: AdminPasswordResetOtpRequestedPayload
): void {
  void publishAdminPasswordResetOtp(data).catch((error) => {
    logger.error("Failed to publish admin.password_reset_otp_requested event");
    logger.error(error);
  });
}
