import { logger } from "@aimess/logger";
import amqp from "amqplib";

import {
  AuthEvents,
  type ChangeEmailOtpRequestedPayload,
  type LinkEmailOtpRequestedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";

const NOTIFICATION_QUEUE = "notification.queue";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertQueue(NOTIFICATION_QUEUE, {
        durable: true,
      });
      return channel;
    })();
  }
  return channelPromise;
}

async function publish(type: string, data: object): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({ type, data });
  channel.sendToQueue(NOTIFICATION_QUEUE, Buffer.from(payload), {
    persistent: true,
  });
}

export function publishLinkEmailOtpSafe(
  data: LinkEmailOtpRequestedPayload
): void {
  void publish(AuthEvents.LINK_EMAIL_OTP_REQUESTED, data).catch((error) => {
    logger.error("Failed to publish auth.link_email_otp_requested event");
    logger.error(error);
  });
}

export function publishChangeEmailOtpSafe(
  data: ChangeEmailOtpRequestedPayload
): void {
  void publish(AuthEvents.CHANGE_EMAIL_OTP_REQUESTED, data).catch((error) => {
    logger.error("Failed to publish auth.change_email_otp_requested event");
    logger.error(error);
  });
}
