import { logger } from "@aimess/logger";
import amqp from "amqplib";
import {
  ChatEvents,
  type ChatGroupMemberAddedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
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
      await pushToUser({
        userId: p.addedUserId,
        category: "chatEnabled",
        type,
        actorId: p.actorId,
        title: "Added to group",
        body: `You were added to ${p.groupName}.`,
        data: { roomId: p.roomId },
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
