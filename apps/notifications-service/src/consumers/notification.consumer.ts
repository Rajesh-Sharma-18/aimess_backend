import amqp from "amqplib";
import { AuthEvents } from "@aimess/shared-types";
import { NotificationEvents } from "../events/notification.events.js";
import {
  handlePasswordResetOtpRequested,
  handleUserRegistered,
} from "../handlers/notification.handler.js";
import { env } from "../config/env.js";
import { logger } from "@aimess/logger";

const QUEUE_NAME = "notification.queue";

/**
 * Dead-letter topology for notification.queue. Must stay in sync with every
 * publisher (e.g. auth-service publish-password-reset-otp.ts); queue arguments
 * are immutable once declared so all sides MUST assert identical deadLetter*
 * args or RabbitMQ throws PRECONDITION_FAILED.
 */
const NOTIFICATION_DLX = "notification.queue.dlx";
const NOTIFICATION_DLQ_ROUTING_KEY = "notification.queue.dead";

export async function startConsumer() {
  const connection = await amqp.connect(env.RABBITMQ_URL);

  const channel = await connection.createChannel();

  await channel.assertExchange(NOTIFICATION_DLX, "direct", { durable: true });
  await channel.assertQueue(QUEUE_NAME, {
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

        default:
          logger.error(`Unknown notification event type: ${parsed.type}`);
      }

      channel.ack(message);
    } catch (error) {
      logger.error(error);
      // requeue=false so the message goes straight to the DLX instead of
      // infinite-looping on deterministic errors (bad payload, SMTP auth, etc.)
      channel.nack(message, false, false);
    }
  });
}
