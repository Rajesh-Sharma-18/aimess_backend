import { logger } from "@aimess/logger";
import amqp from "amqplib";
import {
  FriendshipEvents,
  type FriendAcceptedPayload,
  type FriendRequestedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { buildDeepLink } from "../lib/deep-link.js";
import { pushToUser } from "../services/push.service.js";

// user-service publishes friendship events to a plain durable queue (NOT a
// topic exchange) — match that. (See user-service publish-friendship.ts.)
const FRIENDSHIP_QUEUE = "friendship.queue";

async function handleFriendEvent(type: string, data: unknown): Promise<void> {
  switch (type) {
    case FriendshipEvents.FRIEND_REQUESTED: {
      const p = data as FriendRequestedPayload;
      const deepLink = buildDeepLink("user", p.requesterId);
      await pushToUser({
        userId: p.addresseeId,
        category: "friendRequestEnabled",
        type,
        actorId: p.requesterId,
        title: "New friend request",
        body: "You have a new friend request.",
        deepLink,
        data: {
          friendshipId: p.friendshipId,
          requesterId: p.requesterId,
          deepLink,
        },
      });
      break;
    }

    case FriendshipEvents.FRIEND_ACCEPTED: {
      const p = data as FriendAcceptedPayload;
      const deepLink = buildDeepLink("user", p.addresseeId);
      await pushToUser({
        userId: p.requesterId,
        category: "friendRequestEnabled",
        type,
        actorId: p.addresseeId,
        title: "Friend request accepted",
        body: "Your friend request was accepted.",
        deepLink,
        data: {
          friendshipId: p.friendshipId,
          addresseeId: p.addresseeId,
          deepLink,
        },
      });
      break;
    }

    case FriendshipEvents.FRIEND_UNFRIENDED:
      // No notification on unfriend (silent per product policy).
      break;

    default:
      logger.warn(`Unknown friendship event type: ${type}`);
  }
}

export async function startFriendConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(FRIENDSHIP_QUEUE, { durable: true });
  await channel.prefetch(10);

  logger.info("Friend notification consumer started");

  void channel.consume(FRIENDSHIP_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: unknown;
        };
        await handleFriendEvent(parsed.type, parsed.data);
        channel.ack(message);
      } catch (error) {
        logger.error("Friend consumer failed to process message", error);
        channel.nack(message, false, false);
      }
    })();
  });
}
