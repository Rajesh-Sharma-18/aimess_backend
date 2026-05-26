import amqp from "amqplib";
import { AuthEvents } from "@aimess/shared-types";
import { NotificationEvents } from "../events/notification.events.js";
import {
  handleChangeEmailOtpRequested,
  handleLinkEmailOtpRequested,
  handlePasswordResetOtpRequested,
  handleUserRegistered,
} from "../handlers/notification.handler.js";
import { env } from "../config/env.js";
import { logger } from "@aimess/logger";

const QUEUE_NAME = "notification.queue";

export async function startConsumer() {
  const connection = await amqp.connect(env.RABBITMQ_URL);

  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE_NAME, {
    durable: true,
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
