import type { Channel, ConsumeMessage, ChannelModel } from "amqplib";
import { logger } from "@aimess/logger";
import {
  UserEvents,
  type UserProfileUpdatedPayload,
} from "@aimess/shared-types";

import { redis } from "../config/redis.js";
import { CacheRepository } from "../repositories/cache.repository.js";

/**
 * Invalidates chat-service's cached user snapshot whenever user-service
 * publishes `user.profile_updated`.
 *
 * Snapshots (`user:snapshot:<userId>`) carry the sender's `displayName` and are
 * read on EVERY message send to stamp `senderName` onto the persisted message,
 * the `community:message:new`/`conv:updated`/`community:updated` socket events,
 * the FCM push, and the community-list activity denormalization. They have a 1h
 * TTL and were otherwise never refreshed, so a profile rename left a stale name
 * frozen into all of those surfaces for up to an hour — e.g. the community list
 * kept showing "Vasu Himanshu: 📷 Photo" after the user became "Himanshu Vasu".
 *
 * Binds its own queue to the shared durable fanout exchange (community-service
 * binds another to the same exchange), so adding this consumer needs no
 * publisher change. Best-effort: a delete failure is nacked without requeue.
 */
const EXCHANGE = "user.profile_updated";
const QUEUE = "chat-service.user.profile_updated";

export class UserProfileEventConsumer {
  private channel: Channel | null = null;
  private cacheRepo = new CacheRepository(redis);

  async start(connection: ChannelModel): Promise<void> {
    try {
      this.channel = await connection.createChannel();
      if (!this.channel) {
        throw new Error("Failed to create channel");
      }

      await this.channel.assertExchange(EXCHANGE, "fanout", { durable: true });
      await this.channel.assertQueue(QUEUE, { durable: true });
      await this.channel.bindQueue(QUEUE, EXCHANGE, "");

      await this.channel.consume(QUEUE, (msg: ConsumeMessage | null) =>
        this.handleMessage(msg)
      );

      logger.info("User profile event consumer started");
    } catch (err) {
      logger.error("Failed to start user profile event consumer", err);
      throw err;
    }
  }

  private async handleMessage(msg: ConsumeMessage | null): Promise<void> {
    if (!msg) return;

    try {
      const event = JSON.parse(msg.content.toString()) as {
        type: string;
        data: UserProfileUpdatedPayload;
      };

      if (
        event.type === UserEvents.USER_PROFILE_UPDATED &&
        event.data?.userId
      ) {
        await this.cacheRepo.deleteUserSnapshot(event.data.userId);
        logger.debug(
          `Invalidated user snapshot cache for ${event.data.userId}`
        );
      } else {
        logger.warn(
          `Unexpected message on ${QUEUE}: type=${String(event.type)}`
        );
      }

      this.channel?.ack(msg);
    } catch (err) {
      logger.error("Error processing user.profile_updated event", err);
      // Don't requeue — a malformed/unhandleable message would loop forever.
      this.channel?.nack(msg, false, false);
    }
  }

  async stop(): Promise<void> {
    if (this.channel) {
      try {
        await this.channel.cancel(QUEUE);
        await this.channel.close();
        logger.info("User profile event consumer stopped");
      } catch (err) {
        logger.error("Error stopping user profile consumer", err);
      }
    }
  }
}
