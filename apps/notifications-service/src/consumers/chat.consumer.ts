import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { env } from "../config/env.js";
import { pushToUsers } from "../services/push.service.js";

/**
 * V2 §4: chat-message → FCM/APNs push bridge.
 *
 * chat-service publishes `chat.message_sent` to the durable `chat.message.queue`
 * when a message is persisted. We fan an FCM/APNs **data message** out to each
 * recipient's devices (push.service handles per-category settings, quiet-hours,
 * device-token fan-out, and dead-token pruning).
 *
 * Push is the fallback wake — the socket is primary delivery — so this is
 * best-effort and safely duplicable: the client UPSERTs on `messageId`.
 */
const CHAT_MESSAGE_QUEUE = "chat.message.queue";

interface MessageSentPayload {
  conversationId: string;
  conversationType: "PRIVATE" | "GROUP" | "COMMUNITY";
  /** Present when conversationType === "COMMUNITY" */
  communityId?: string;
  messageId: string;
  clientMessageId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  preview: string;
  messageType: string;
  sentAt: number;
  recipientIds: string[];
}

async function handleMessageSent(data: MessageSentPayload): Promise<void> {
  const recipients = (data.recipientIds ?? []).filter(
    (id) => id && id !== data.senderId
  );
  if (recipients.length === 0) return;

  const title = data.senderName || "New message";
  const body = data.preview || "New message";
  const category =
    data.conversationType === "COMMUNITY" ? "communityEnabled" : "chatEnabled";

  await pushToUsers(recipients, (userId) => ({
    userId,
    category,
    type: "MESSAGE",
    title,
    body,
    actorId: data.senderId,
    // FCM data map — all values MUST be strings. Mirrors PUSH_NOTIFICATIONS_V2.md.
    data: {
      type: "MESSAGE",
      conversationId: data.conversationId,
      conversationType: data.conversationType,
      ...(data.communityId ? { communityId: data.communityId } : {}),
      messageId: data.messageId,
      clientMessageId: data.clientMessageId ?? "",
      senderId: data.senderId,
      senderName: data.senderName ?? "",
      senderAvatar: data.senderAvatar ?? "",
      contentType: data.messageType ?? "",
      preview: data.preview ?? "",
      sentAt: String(data.sentAt ?? ""),
      idempotencyKey: data.messageId,
    },
  }));
}

export async function startChatConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  // chat-service publishes to a plain durable queue (NOT an exchange). Args MUST
  // match the publisher (apps/chat-service/src/events/publish-message-sent.ts).
  await channel.assertQueue(CHAT_MESSAGE_QUEUE, { durable: true });
  await channel.prefetch(20);

  logger.info("Chat message push consumer started");

  void channel.consume(CHAT_MESSAGE_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: MessageSentPayload;
        };
        if (parsed.type === "chat.message_sent") {
          await handleMessageSent(parsed.data);
        } else {
          logger.warn(`Unknown chat event type: ${parsed.type}`);
        }
        channel.ack(message);
      } catch (error) {
        // Deterministic/parse error → drop (no requeue) so it doesn't spin.
        logger.error("Chat push consumer failed to process message", error);
        channel.nack(message, false, false);
      }
    })();
  });
}
