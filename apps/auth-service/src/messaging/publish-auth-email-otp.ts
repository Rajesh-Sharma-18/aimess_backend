import { logger } from "@aimess/logger";
import amqp from "amqplib";

import {
  AuthEvents,
  type ChangeEmailOtpRequestedPayload,
  type LinkEmailOtpRequestedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";

const NOTIFICATION_QUEUE = "notification.queue";
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
