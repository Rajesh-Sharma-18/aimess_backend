import { logger } from "@aimess/logger";
import amqp from "amqplib";

import {
  FriendshipEvents,
  USER_EVENTS_EXCHANGE,
  FriendshipReadModelEvents,
  type FriendRequestedPayload,
  type FriendAcceptedPayload,
  type FriendRejectedPayload,
  type FriendCancelledPayload,
  type FriendUnfriendedPayload,
  type FriendshipReadModelEventType,
  type FriendshipReadModelPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";

const FRIENDSHIP_QUEUE = "friendship.queue";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertQueue(FRIENDSHIP_QUEUE, { durable: true });
      await channel.assertExchange(USER_EVENTS_EXCHANGE, "topic", {
        durable: true,
      });
      return channel;
    })();
  }
  return channelPromise;
}

async function publish(type: string, data: unknown): Promise<void> {
  const channel = await getChannel();
  const payload = JSON.stringify({ type, data });
  channel.sendToQueue(FRIENDSHIP_QUEUE, Buffer.from(payload), {
    persistent: true,
  });
}

function publishSafe(type: string, data: unknown, label: string): void {
  void publish(type, data).catch((error) => {
    logger.error(`Failed to publish ${label}`);
    logger.error(error);
  });
}

export function publishFriendRequestedSafe(data: FriendRequestedPayload): void {
  publishSafe(FriendshipEvents.FRIEND_REQUESTED, data, "friend.requested");
}

export function publishFriendAcceptedSafe(data: FriendAcceptedPayload): void {
  publishSafe(FriendshipEvents.FRIEND_ACCEPTED, data, "friend.accepted");
}

export function publishFriendRejectedSafe(data: FriendRejectedPayload): void {
  publishSafe(FriendshipEvents.FRIEND_REJECTED, data, "friend.rejected");
}

export function publishFriendCancelledSafe(data: FriendCancelledPayload): void {
  publishSafe(FriendshipEvents.FRIEND_CANCELLED, data, "friend.cancelled");
}

export function publishFriendUnfriendedSafe(
  data: FriendUnfriendedPayload
): void {
  publishSafe(FriendshipEvents.FRIEND_UNFRIENDED, data, "friend.unfriended");
}

/**
 * Relationship read-model events for chat-service. Published to the `user.events`
 * TOPIC exchange (routing key == event type) with a TOP-LEVEL payload, matching
 * what chat-service's friendship consumer binds + reads. Independent of the
 * `friendship.queue` notification path above (different exchange + shape).
 */
async function publishToUserEvents(
  type: FriendshipReadModelEventType,
  fields: Omit<FriendshipReadModelPayload, "type" | "timestamp">
): Promise<void> {
  const channel = await getChannel();
  const body: FriendshipReadModelPayload = {
    type,
    timestamp: Date.now(),
    ...fields,
  };
  channel.publish(
    USER_EVENTS_EXCHANGE,
    type,
    Buffer.from(JSON.stringify(body)),
    { persistent: true }
  );
}

/**
 * `isRefriend` — this pair had been friends before. Only that case gets the
 * "now friends" chat system row; see `FriendshipReadModelPayload`.
 */
export function publishFriendshipCreatedSafe(
  userA: string,
  userB: string,
  isRefriend = false
): void {
  void publishToUserEvents(FriendshipReadModelEvents.FRIENDSHIP_CREATED, {
    userA,
    userB,
    status: "ACTIVE",
    isRefriend,
  }).catch((error) => {
    logger.error("Failed to publish friendship.created");
    logger.error(error);
  });
}

export function publishFriendshipDeletedSafe(
  userA: string,
  userB: string
): void {
  void publishToUserEvents(FriendshipReadModelEvents.FRIENDSHIP_DELETED, {
    userA,
    userB,
  }).catch((error) => {
    logger.error("Failed to publish friendship.deleted");
    logger.error(error);
  });
}

/**
 * `userA` blocked `userB`. Activates chat-service's existing (previously
 * unused) `friendship.blocked` consumer branch, which flags the local
 * read-model row so the private-room friendship gate rejects `userA`
 * messaging `userB` — no chat-service changes needed.
 */
export function publishFriendshipBlockedSafe(
  userA: string,
  userB: string
): void {
  void publishToUserEvents(FriendshipReadModelEvents.FRIENDSHIP_BLOCKED, {
    userA,
    userB,
    status: "BLOCKED",
  }).catch((error) => {
    logger.error("Failed to publish friendship.blocked");
    logger.error(error);
  });
}
