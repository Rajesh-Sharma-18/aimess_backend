import { logger } from "@aimess/logger";
import * as amqp from "amqplib";

import { env } from "../config/env.js";
import { resolveMediaUrl } from "../lib/media-resolve.js";

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

      // Resolve-on-read at the publish boundary: the push (FCM data map) must
      // carry a full, usable avatar URL, never a raw object key. Best-effort and
      // not persisted (notifications-service forwards this into the FCM payload).
      const senderAvatar = await resolveMediaUrl(p.senderAvatar);
      const channel = await getChannel(url);
      const data: MessageSentPayload = {
        conversationId: p.conversationId,
        conversationType: p.conversationType,
        messageId: p.messageId,
        clientMessageId: p.clientMessageId,
        senderId: p.senderId,
        senderName: p.senderName,
        senderAvatar,
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

/**
 * Canonical list/preview string for a message, honoring the documented
 * `ListBumpLastMessage` convention (asyncapi `ListBumpLastMessage` + SOCKET_EVENTS
 * §4.2): TEXT/SYSTEM show the body; media & structured types show a labelled
 * placeholder with the filename / place / contact name interpolated when known.
 * `content` may be the structured content object (`{ text, files[], location,
 * contact }`) or a plain text string (community stores the body as a string), so
 * a non-text message never yields an empty list preview.
 */
export function buildMessagePreview(
  contentType: string,
  content: unknown
): string {
  const type = String(contentType ?? "").toUpperCase();
  const c: Record<string, unknown> =
    content && typeof content === "object"
      ? (content as Record<string, unknown>)
      : { text: typeof content === "string" ? content : "" };
  const text = typeof c.text === "string" ? c.text : "";
  const files = Array.isArray(c.files)
    ? (c.files as Array<Record<string, unknown>>)
    : [];
  const fileName = (files[0]?.name as string) || "";
  const placeName =
    ((c.location as Record<string, unknown> | undefined)
      ?.placeName as string) || "";
  const contactName =
    ((c.contact as Record<string, unknown> | undefined)?.name as string) || "";

  switch (type) {
    case "TEXT":
      return text ? text.slice(0, 200) : "Sent a message";
    case "IMAGE":
      return "📷 Photo";
    case "VIDEO":
      return "🎥 Video";
    case "GIF":
      return "🎞 GIF";
    case "VOICE":
      return "🎤 Voice message";
    case "AUDIO":
      return "🎵 Audio";
    case "DOCUMENT":
      return fileName ? `📎 ${fileName}` : "📎 Document";
    case "STICKER":
      return "🌟 Sticker";
    case "LOCATION":
      return placeName ? `📍 ${placeName}` : "📍 Location";
    case "CONTACT":
      return contactName ? `👤 ${contactName}` : "👤 Contact";
    case "SYSTEM":
      return text || "";
    default:
      return text ? text.slice(0, 200) : "New message";
  }
}

/**
 * Short, notification-ready preview from message type + body text. Thin wrapper
 * over {@link buildMessagePreview} for the push path (which has only the body
 * text in hand, not the structured content object).
 */
export function buildPushPreview(messageType: string, text: string): string {
  return buildMessagePreview(messageType, { text });
}
