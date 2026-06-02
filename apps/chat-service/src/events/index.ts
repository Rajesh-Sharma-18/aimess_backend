import * as amqp from "amqplib";
import { logger } from "@aimess/logger";
import { env } from "../config/env.js";
import { FriendshipEventConsumer } from "./friendship.consumer.js";

let connection: amqp.ChannelModel | null = null;
let friendshipConsumer: FriendshipEventConsumer | null = null;

export async function initializeEventConsumers(): Promise<void> {
  if (!env.RABBITMQ_URL) {
    logger.warn("RABBITMQ_URL not configured — event consumers will not start");
    logger.warn(
      "Friendship changes from user-service will not be synced to chat-service"
    );
    return;
  }

  try {
    connection = await amqp.connect(env.RABBITMQ_URL);
    logger.info("Connected to RabbitMQ");

    // Handle connection errors
    connection.on("error", (err: Error) => {
      logger.error("RabbitMQ connection error", err);
    });

    connection.on("close", () => {
      logger.warn("RabbitMQ connection closed");
      connection = null;
      friendshipConsumer = null;
    });

    // Start friendship event consumer
    friendshipConsumer = new FriendshipEventConsumer();
    await friendshipConsumer.start(connection);
  } catch (err) {
    logger.error("Failed to initialize event consumers", err);
    throw err;
  }
}

export async function closeEventConsumers(): Promise<void> {
  try {
    if (friendshipConsumer) {
      await friendshipConsumer.stop();
    }
    if (connection) {
      await connection.close();
      logger.info("RabbitMQ connection closed");
    }
  } catch (err) {
    logger.error("Error closing event consumers", err);
  }
}
