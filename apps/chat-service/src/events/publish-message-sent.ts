import { logger } from "@aimess/logger";
import * as amqp from "amqplib";

import { env } from "../config/env.js";

/**
 * V2 §4: durable queue carrying "a message was sent" to notifications-service,
 * which fans an FCM/APNs **data message** out to each recipient's devices for the
 * app-killed / background case. Push is the fallback wake — the socket is primary
 * delivery — so this is best-effort and safely duplicable (client dedups on
 * messageId). Publisher (here) and consumer (notifications-service) MUST assert
 * identical queue args; RabbitMQ queue args are immutable once declared.
 */
const CHAT_MESSAGE_QUEUE = "chat.message.queue";

export const CHAT_MESSAGE_SENT_EVENT = "chat.message_sent";

export interface MessageSentPayload {
  conversationId: string;
  conversationType: "PRIVATE" | "GROUP";
  messageId: string;
  clientMessageId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  /** Short, render-ready preview text (already truncated). */
  preview: string;
  messageType: string;
  /** epoch ms */
  sentAt: number;
  /** Recipients to notify — the publisher excludes the sender. */
  recipientIds: string[];
}

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(url: string): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(url);
      connection.on("close", () => {
        channelPromise = null;
      });
      connection.on("error", (err: Error) => {
        logger.error("chat.message publisher connection error", err);
      });
      const channel = await connection.createChannel();
      await channel.assertQueue(CHAT_MESSAGE_QUEUE, { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

type PublishMessageSentParams = Omit<MessageSentPayload, "recipientIds"> &
  (
    | { recipientIds: string[]; fetchRecipients?: never }
    | { recipientIds?: never; fetchRecipients: () => Promise<string[]> }
  );

/**
 * Fire-and-forget push trigger. The recipient list is supplied directly (private
 * chats — the peer id is in hand) or resolved lazily via `fetchRecipients` (group
 * chats). The sender is always excluded. Best-effort: a failure is logged, never
 * thrown, so a message send never fails on its push event.
 */
export function publishMessageSentSafe(p: PublishMessageSentParams): void {
  const url = env.RABBITMQ_URL;
  if (!url) return; // RabbitMQ not configured — skip (push is a fallback channel)
  void (async () => {
    try {
      const recipients = p.recipientIds ?? (await p.fetchRecipients!());
      const targets = [...new Set(recipients)].filter(
        (id) => id && id !== p.senderId
      );
      if (targets.length === 0) return;

      const channel = await getChannel(url);
      const data: MessageSentPayload = {
        conversationId: p.conversationId,
        conversationType: p.conversationType,
        messageId: p.messageId,
        clientMessageId: p.clientMessageId,
        senderId: p.senderId,
        senderName: p.senderName,
        senderAvatar: p.senderAvatar,
        preview: p.preview,
        messageType: p.messageType,
        sentAt: p.sentAt,
        recipientIds: targets,
      };
      const payload = JSON.stringify({ type: CHAT_MESSAGE_SENT_EVENT, data });
      channel.sendToQueue(CHAT_MESSAGE_QUEUE, Buffer.from(payload), {
        persistent: true,
      });
    } catch (error) {
      channelPromise = null;
      logger.warn(
        `Failed to publish chat.message_sent for ${p.conversationId}: ${String(error)}`
      );
    }
  })();
}

/** Build a short, notification-ready preview from message type + text. */
export function buildPushPreview(messageType: string, text: string): string {
  const type = String(messageType ?? "").toUpperCase();
  if (text && type === "TEXT") return text.slice(0, 200);
  switch (type) {
    case "IMAGE":
      return "📷 Photo";
    case "VIDEO":
      return "🎬 Video";
    case "VOICE":
      return "🎤 Voice message";
    case "DOCUMENT":
      return "📄 Document";
    case "STICKER":
      return "Sticker";
    case "GIF":
      return "GIF";
    case "LOCATION":
      return "📍 Location";
    case "CONTACT":
      return "👤 Contact";
    default:
      return text ? text.slice(0, 200) : "New message";
  }
}
