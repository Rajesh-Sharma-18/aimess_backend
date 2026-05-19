import amqp from "amqplib";
import { NotificationEvents } from "../events/notification.events.js";
import { handleUserRegistered } from "../handlers/notification.handler.js";
import { env } from "../config/env.js";
import { logger } from "@aimess/logger";

const QUEUE_NAME = "notification.queue";

export async function startConsumer() {
  const connection = await amqp.connect(env.RABBITMQ_URL);

  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE_NAME);

  logger.info("Notification consumer started");

  channel.consume(QUEUE_NAME, async (message) => {
    if (!message) return;

    const parsed = JSON.parse(message.content.toString());

    try {
      switch (parsed.type) {
        case NotificationEvents.USER_REGISTERED:
          await handleUserRegistered(parsed.data);
          break;

        default:
          logger.error("Unknown event");
      }

      channel.ack(message);
    } catch (error) {
      logger.error(error);

      channel.nack(message);
    }
  });
}
