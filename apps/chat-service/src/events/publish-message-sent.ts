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
  conversationType: "PRIVATE" | "GROUP" | "COMMUNITY";
  /** Present when conversationType === "COMMUNITY" */
  communityId?: string;
  /** Display name of the community — used as the push notification title. */
  communityName?: string;
  messageId: string;
  clientMessageId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  /** Display name of the group — a GROUP push must title on the group, not the sender. */
  groupName?: string;
  /** Group/community avatar for the notification's large icon. */
  conversationAvatar?: string;
  /** False when the room is read-only for the recipient — hides the Reply action. */
  canReply?: boolean;
  /** Short, render-ready preview text (already truncated). */
  preview: string;
  /** Object key of the image (or video poster) to render inline in the push. */
  previewImageKey?: string;
  /** Resolved from previewImageKey at the publish boundary — never a raw object key. */
  previewImageUrl?: string;
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
      const previewImageUrl = p.previewImageKey
        ? await resolveMediaUrl(p.previewImageKey).catch(() => "")
        : "";
      const channel = await getChannel(url);
      const data: MessageSentPayload = {
        conversationId: p.conversationId,
        conversationType: p.conversationType,
        ...(p.communityId ? { communityId: p.communityId } : {}),
        ...(p.communityName ? { communityName: p.communityName } : {}),
        messageId: p.messageId,
        clientMessageId: p.clientMessageId,
        senderId: p.senderId,
        senderName: p.senderName,
        senderAvatar,
        // Group identity: resolved fresh from GroupRoom on every send (see
        // chat-message-orchestrator's getPushHeader call). These were declared
        // on the payload but never copied onto the wire, so a GROUP push had no
        // group name to title on at all — renamed or not.
        ...(p.groupName ? { groupName: p.groupName } : {}),
        ...(p.conversationAvatar
          ? { conversationAvatar: p.conversationAvatar }
          : {}),
        ...(p.canReply !== undefined ? { canReply: p.canReply } : {}),
        preview: p.preview,
        ...(previewImageUrl ? { previewImageUrl } : {}),
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
 * Preview helpers now live in the centralized MessagePreviewService (the single
 * source of truth for all list/community/push previews). Re-exported here so the
 * many existing `buildMessagePreview` / `buildPushPreview` imports from this file
 * keep working without duplicating the logic. Prefer importing
 * `convertMessageToPreview` from `../services/message-preview.service.js` in new
 * code.
 */
export {
  buildMessagePreview,
  buildPushPreview,
  convertMessageToPreview,
} from "../services/message-preview.service.js";
