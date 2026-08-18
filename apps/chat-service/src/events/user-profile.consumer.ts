import type { Channel, ConsumeMessage, ChannelModel } from "amqplib";
import { logger } from "@aimess/logger";
import { publishChatUserEvent } from "@aimess/redis";
import {
  UserEvents,
  type UserProfileUpdatedPayload,
} from "@aimess/shared-types";

import { prisma } from "../config/prisma.js";
import { redis } from "../config/redis.js";
import { CacheRepository } from "../repositories/cache.repository.js";
import { GroupMemberRepository } from "../repositories/group-member.repository.js";

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
  private groupMemberRepo = new GroupMemberRepository(prisma);

  /**
   * Realtime half of account deletion, for viewers who are looking at the
   * deleted user RIGHT NOW and would otherwise keep their old name and avatar
   * on screen until the next fetch.
   *
   * Two fan-outs, because a deleted user is visible in two kinds of place and
   * neither existing channel covers both:
   *
   *  - `user:<userId>` on /chat. The api-gateway mirrors this one event to
   *    room `presence:<userId>` — the room every peer with this user's DM row
   *    or chat header open already joined via `presence:subscribe`. That is
   *    precisely the audience for "the person in your conversation list is
   *    gone", and it needs no new subscription on the client.
   *  - `conv:<roomId>` for each of the user's ACTIVE group rooms, reusing the
   *    existing `group:member:updated` roster event rather than minting a
   *    group-specific deletion event. Its consumers already refetch the roster,
   *    which is exactly the required behavior.
   *
   * Communities are deliberately absent: community-service consumes this same
   * `user.profile_updated` message and already broadcasts
   * `community:member:updated` into every community the user belongs to.
   *
   * Entirely best-effort — the cache invalidation above is what makes the state
   * correct; this only makes it correct SOONER. A failure here must not nack
   * the message and replay the invalidation.
   */
  private async broadcastAccountDeleted(
    userId: string,
    updatedAt: string
  ): Promise<void> {
    const payload = { userId, isDeletedUser: true, updatedAt };
    await publishChatUserEvent(
      redis,
      userId,
      "user:account_deleted",
      payload
    ).catch(() => undefined);

    const roomIds = await this.groupMemberRepo
      .getActiveRoomIds(userId)
      .catch(() => [] as string[]);
    await Promise.all(
      roomIds.map((roomId) =>
        redis
          .publish(
            `conv:${roomId}`,
            JSON.stringify({
              event: "group:member:updated",
              data: {
                roomId,
                conversationType: "GROUP" as const,
                memberId: userId,
                actorId: userId,
                isDeletedUser: true,
                updatedAt: Date.now(),
              },
            })
          )
          .catch(() => undefined)
      )
    );
  }

  /**
   * Realtime half of a plain profile change (rename / new profile picture), for
   * viewers who have this user on screen RIGHT NOW and would otherwise keep the
   * old name and avatar until their next fetch.
   *
   * Signal only — `{ userId, updatedAt }`, no identity values. Same contract as
   * `user:account_deleted` above and for the same reasons: the server stays the
   * source of truth for what a profile looks like, a client can never write a
   * half-profile from the wire, and no field the recipient is not already
   * authorized to see can leak. Recipients answer with the refetch they were
   * always going to do — which resolves a fresh presigned avatar URL, so there
   * is nothing to cache-bust.
   *
   * Two fan-outs, matching the two places a peer sees this user:
   *
   *  - `user:<userId>` on /chat. Reaches the user's OWN devices (their avatar on
   *    their own messages), and the api-gateway mirrors it to
   *    `presence:<userId>` — the room every peer with this user's DM row or
   *    chat header open already joined via `presence:subscribe`.
   *  - `conv:<roomId>` for each ACTIVE group room, which is where group member
   *    lists, headers and message avatars are rendered.
   *
   * Communities are deliberately absent: community-service consumes this same
   * `user.profile_updated` message and already broadcasts
   * `community:member:updated` into every community the user belongs to.
   *
   * Entirely best-effort — the cache invalidation is what makes the state
   * correct; this only makes it correct SOONER, so a failure must never nack
   * the message and replay the invalidation.
   */
  private async broadcastProfileUpdated(
    userId: string,
    updatedAt: string
  ): Promise<void> {
    const payload = { userId, updatedAt };
    await publishChatUserEvent(
      redis,
      userId,
      "user:profile_updated",
      payload
    ).catch(() => undefined);

    const roomIds = await this.groupMemberRepo
      .getActiveRoomIds(userId)
      .catch(() => [] as string[]);
    await Promise.all(
      roomIds.map((roomId) =>
        redis
          .publish(
            `conv:${roomId}`,
            JSON.stringify({ event: "user:profile_updated", data: payload })
          )
          .catch(() => undefined)
      )
    );
  }

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

        // Both branches emit a client-facing signal, and both carry identity
        // values of exactly zero — the recipient refetches. Deletion keeps its
        // own event because its consumers do more than re-read a name (drop
        // presence, gate profile navigation, freeze member actions).
        if (event.data.isDeleted === true) {
          await this.broadcastAccountDeleted(
            event.data.userId,
            event.data.updatedAt
          );
        } else {
          await this.broadcastProfileUpdated(
            event.data.userId,
            event.data.updatedAt
          );
        }
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
