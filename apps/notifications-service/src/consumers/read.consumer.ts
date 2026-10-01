import { logger } from "@aimess/logger";
import * as amqp from "amqplib";

import { env } from "../config/env.js";
import { roomTags } from "../lib/push-tags.js";
import { dismissTrayCards } from "../services/push-dismiss.js";

const CHAT_READ_QUEUE = "chat.read.queue";

interface ConversationReadPayload {
  readerId: string;
  conversationId: string;
  conversationType: "PRIVATE" | "GROUP" | "COMMUNITY";
  readAt: number;
  /** Device that performed the read, when known — it needs no dismiss. */
  deviceId?: string;
  /**
   * Why the room's cards go away; READ when absent (older publishers). CLEARED,
   * DELETED, LEFT and REMOVED reuse this queue because for the tray they mean
   * the same thing: nothing about this room is worth showing any more.
   */
  reason?: "READ" | "CLEARED" | "DELETED" | "LEFT" | "REMOVED";
}

/**
 * The user read (or cleared, deleted, left) this conversation somewhere, so every
 * device of theirs must drop its tray cards for it: the chat summary, the mention
 * card and, for a room, the live / "added you" cards. Data-only and
 * settings-bypassing: this is a dismissal, not a notification.
 *
 * Still typed `MESSAGE_READ` because shipped mobile builds already act on it;
 * `op` / `tags` are what newer clients close by.
 */
async function handleConversationRead(
  data: ConversationReadPayload
): Promise<void> {
  if (!data.readerId || !data.conversationId) {
    logger.warn("[push:consume] conversation_read dropped — missing ids");
    return;
  }

  await dismissTrayCards({
    userId: data.readerId,
    type: "MESSAGE_READ",
    tags: roomTags(data.conversationId),
    reason: data.reason ?? "READ",
    alwaysPushMobile: true,
    collapseKey: `read:${data.conversationId}`,
    ...(data.deviceId ? { excludeDeviceId: data.deviceId } : {}),
    data: {
      conversationId: data.conversationId,
      conversationType: data.conversationType ?? "",
      readAt: String(data.readAt ?? ""),
    },
  });
}

export async function startReadConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  // Args MUST match the publisher (apps/chat-service/src/events/publish-conversation-read.ts).
  await channel.assertQueue(CHAT_READ_QUEUE, { durable: true });
  await channel.prefetch(50);

  logger.info("Conversation-read push consumer started");

  void channel.consume(CHAT_READ_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: unknown;
        };
        if (parsed.type === "chat.conversation_read") {
          await handleConversationRead(parsed.data as ConversationReadPayload);
        } else {
          logger.warn(`Unknown read event type: ${parsed.type}`);
        }
        channel.ack(message);
      } catch (error) {
        logger.error("Read push consumer failed to process message", error);
        channel.nack(message, false, false);
      }
    })();
  });
}
