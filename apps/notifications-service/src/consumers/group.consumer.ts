import { logger } from "@aimess/logger";
import amqp from "amqplib";
import {
  ChatEvents,
  type ChatGroupMemberAddedPayload,
  type ChatGroupMemberMutedPayload,
  type NotificationNavigation,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { buildDeepLink } from "../lib/deep-link.js";
import { groupCopy } from "../lib/notification-copy.js";
import { pushToUser } from "../services/push.service.js";

/**
 * chat-service publishes group lifecycle events (currently MEMBER_ADDED) to a
 * plain durable queue (NOT an exchange) — match that. The added member may not be
 * in the room socket, so we push/inbox them here. Gates on the chat category.
 * Throwing → caller nacks(no requeue) so the message DLQs.
 */
const CHAT_GROUP_QUEUE = "chat.group.queue";

async function handleGroupEvent(type: string, data: unknown): Promise<void> {
  switch (type) {
    case ChatEvents.GROUP_MEMBER_ADDED: {
      const p = data as ChatGroupMemberAddedPayload;
      const deepLink = buildDeepLink("group", p.roomId);
      await pushToUser({
        userId: p.addedUserId,
        category: "chatEnabled",
        type,
        actorId: p.actorId,
        ...groupCopy.memberAdded(p.groupName),
        deepLink,
        data: {
          roomId: p.roomId,
          groupName: p.groupName,
          actorId: p.actorId,
          deepLink,
          navigation: JSON.stringify({
            screen: "GROUP_CHAT",
            roomId: p.roomId,
            conversationType: "GROUP",
          } satisfies NotificationNavigation),
        },
      });
      break;
    }

    // Moderation mute/unmute — target only, mirroring community's
    // MEMBER_MUTED / MEMBER_UNMUTED push. A member whose devices were all
    // offline when the mute landed learns about it here instead of from a
    // rejected send.
    case ChatEvents.GROUP_MEMBER_MUTED:
    case ChatEvents.GROUP_MEMBER_UNMUTED: {
      const p = data as ChatGroupMemberMutedPayload;
      const isMute = type === ChatEvents.GROUP_MEMBER_MUTED;
      const deepLink = buildDeepLink("group", p.roomId);
      await pushToUser({
        userId: p.targetUserId,
        category: "chatEnabled",
        type,
        actorId: p.actorId,
        ...(isMute
          ? groupCopy.memberMuted(p.groupName, p.mutedUntil)
          : groupCopy.memberUnmuted(p.groupName)),
        deepLink,
        data: {
          roomId: p.roomId,
          groupName: p.groupName,
          actorId: p.actorId,
          mutedUntil: p.mutedUntil ?? "",
          deepLink,
          navigation: JSON.stringify({
            screen: "GROUP_CHAT",
            roomId: p.roomId,
            conversationType: "GROUP",
          } satisfies NotificationNavigation),
        },
      });
      break;
    }

    default:
      logger.warn(`Unknown chat group event type: ${type}`);
  }
}

export async function startGroupConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(CHAT_GROUP_QUEUE, { durable: true });
  await channel.prefetch(10);

  logger.info("Group notification consumer started");

  void channel.consume(CHAT_GROUP_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: unknown;
        };
        await handleGroupEvent(parsed.type, parsed.data);
        channel.ack(message);
      } catch (error) {
        logger.error("Group consumer failed to process message", error);
        channel.nack(message, false, false);
      }
    })();
  });
}
