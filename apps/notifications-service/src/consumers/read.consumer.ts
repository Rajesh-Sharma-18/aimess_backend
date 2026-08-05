import { logger } from "@aimess/logger";
import * as amqp from "amqplib";

import { env } from "../config/env.js";
import { pushToUser } from "../services/push.service.js";

const CHAT_READ_QUEUE = "chat.read.queue";

interface ConversationReadPayload {
  readerId: string;
  conversationId: string;
  conversationType: "PRIVATE" | "GROUP" | "COMMUNITY";
  readAt: number;
  /** Device that performed the read, when known — it needs no dismiss. */
  deviceId?: string;
}

/**
 * The user read this conversation somewhere, so every OTHER device of theirs must drop its
 * tray notification for it. Data-only and settings-bypassing: this is a dismissal, not a
 * notification, and suppressing it would leave a stale unread card on the other device.
 */
async function handleConversationRead(
  data: ConversationReadPayload
): Promise<void> {
  if (!data.readerId || !data.conversationId) {
    logger.warn("[push:consume] conversation_read dropped — missing ids");
    return;
  }

  await pushToUser({
    userId: data.readerId,
    category: "chatEnabled",
    type: "MESSAGE_READ",
    title: "",
    body: "",
    bypassSettings: true,
    skipInbox: true,
    dataOnly: true,
    priority: "high",
    ttl: 300,
    collapseKey: `read:${data.conversationId}`,
    ...(data.deviceId ? { excludeDeviceId: data.deviceId } : {}),
    data: {
      type: "MESSAGE_READ",
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
