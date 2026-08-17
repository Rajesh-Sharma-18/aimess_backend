import { logger } from "@aimess/logger";
import * as amqp from "amqplib";

import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
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
  /**
   * Group/community avatar for the notification's large icon, as a FULL URL.
   * Callers may pass a raw object key OR omit it entirely — `publishMessageSentSafe`
   * resolves it (and falls back to the room row) before it goes on the wire.
   */
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

/**
 * The conversation's OWN identity (name + avatar object key) for a GROUP or
 * COMMUNITY push, read from the authoritative room row at publish time.
 *
 * A group/community notification must represent the CONVERSATION, not the
 * actor — so the title is the room name and the tray image is the room avatar.
 * Reading it here rather than at each producer is what keeps the two halves in
 * sync: both come from the same row, on every send, so a rename or a new avatar
 * is picked up by the very next push and the pair can never describe two
 * different versions of the entity.
 *
 * GeneralRoom (community) is the local mirror kept current by
 * `community.meta_synced`; GroupRoom is chat-service's own authoritative row.
 * Both store a RAW object key — never a resolved URL.
 */
async function conversationHeader(
  conversationType: MessageSentPayload["conversationType"],
  conversationId: string
): Promise<{ name: string; avatarKey: string }> {
  if (conversationType === "GROUP") {
    const room = await prisma.groupRoom.findUnique({
      where: { roomId: conversationId },
      select: { name: true, avatar: true },
    });
    return { name: room?.name ?? "", avatarKey: room?.avatar ?? "" };
  }
  const room = await prisma.generalRoom.findUnique({
    where: { id: conversationId },
    select: { name: true, logo: true },
  });
  return { name: room?.name ?? "", avatarKey: room?.logo ?? "" };
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

      // Conversation identity for GROUP/COMMUNITY. Resolved HERE, once, for
      // every producer: the REST/socket orchestrator, the gRPC send path, the
      // community system-message bridge, call rows and group-invite DMs all
      // publish through this function, and only one of them used to supply a
      // name — none supplied an avatar for community. Room row wins over
      // whatever the caller carried (a request body can be stale; the row is
      // the mirror the rename/avatar sync writes to).
      const header =
        p.conversationType === "PRIVATE"
          ? null
          : await conversationHeader(
              p.conversationType,
              p.conversationId
            ).catch(() => null);
      const groupName =
        p.conversationType === "GROUP" ? header?.name || p.groupName || "" : "";
      const communityName =
        p.conversationType === "COMMUNITY"
          ? header?.name || p.communityName || ""
          : "";
      // Idempotent: an already-resolved http(s) URL passes through unchanged,
      // a raw object key gets presigned, anything unresolvable degrades to "".
      const conversationAvatar = await resolveMediaUrl(
        p.conversationAvatar || header?.avatarKey
      ).catch(() => "");

      const channel = await getChannel(url);
      const data: MessageSentPayload = {
        conversationId: p.conversationId,
        conversationType: p.conversationType,
        ...(p.communityId ? { communityId: p.communityId } : {}),
        ...(communityName ? { communityName } : {}),
        messageId: p.messageId,
        clientMessageId: p.clientMessageId,
        senderId: p.senderId,
        senderName: p.senderName,
        senderAvatar,
        // Group/community identity: resolved fresh from the room row above on
        // every send. These were declared on the payload but never copied onto
        // the wire, so a GROUP push had no group name to title on at all —
        // renamed or not — and no conversation carried an avatar for the tray.
        ...(groupName ? { groupName } : {}),
        ...(conversationAvatar ? { conversationAvatar } : {}),
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
