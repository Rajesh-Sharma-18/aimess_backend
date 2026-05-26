import { logger } from "@aimess/logger";
import amqp from "amqplib";

import {
  AuthEvents,
  type PasswordResetOtpRequestedPayload,
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

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertExchange(NOTIFICATION_DLX, "direct", {
        durable: true,
      });
      await channel.assertQueue(NOTIFICATION_QUEUE, {
        durable: true,
        deadLetterExchange: NOTIFICATION_DLX,
        deadLetterRoutingKey: NOTIFICATION_DLQ_ROUTING_KEY,
      });
      return channel;
    })();
  }
  return channelPromise;
}

export async function publishPasswordResetOtp(
  data: PasswordResetOtpRequestedPayload
): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({
    type: AuthEvents.PASSWORD_RESET_OTP_REQUESTED,
    data,
  });
  channel.sendToQueue(NOTIFICATION_QUEUE, Buffer.from(payload), {
    persistent: true,
  });
}

/** Fire-and-forget; OTP request must not fail if the broker is down. */
export function publishPasswordResetOtpSafe(
  data: PasswordResetOtpRequestedPayload
): void {
  void publishPasswordResetOtp(data).catch((error) => {
    logger.error("Failed to publish auth.password_reset_otp_requested event");
    logger.error(error);
  });
}
