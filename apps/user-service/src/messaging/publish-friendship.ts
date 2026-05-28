import { logger } from "@aimess/logger";
import amqp from "amqplib";

import {
  FriendshipEvents,
  type FriendRequestedPayload,
  type FriendAcceptedPayload,
  type FriendUnfriendedPayload,
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

export function publishFriendUnfriendedSafe(
  data: FriendUnfriendedPayload
): void {
  publishSafe(FriendshipEvents.FRIEND_UNFRIENDED, data, "friend.unfriended");
}
