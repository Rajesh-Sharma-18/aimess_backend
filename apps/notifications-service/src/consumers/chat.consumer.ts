import { logger } from "@aimess/logger";
import amqp from "amqplib";
import { type SupportedLocale } from "@aimess/constants";
import { type NotificationNavigation } from "@aimess/shared-types";

import { env } from "../config/env.js";
import { buildDeepLink } from "../lib/deep-link.js";
import { chatCopy } from "../lib/notification-copy.js";
import { generateThreadId } from "../lib/thread-id.js";
import { pushToUsers } from "../services/push.service.js";
import {
  filterToActiveCommunityMembers,
  isCommunityActorMuted,
  isGroupMemberMuted,
  isPrivateRoomMutedBy,
} from "../services/notification-eligibility.service.js";

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
  /** Community display name — used as the FCM push title for community messages. */
  communityName?: string;
  messageId: string;
  clientMessageId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  groupName?: string;
  conversationAvatar?: string;
  canReply?: boolean;
  unreadCount?: number;
  preview: string;
  messageType: string;
  sentAt: number;
  recipientIds: string[];
}

async function handleMessageSent(data: MessageSentPayload): Promise<void> {
  const isCommunity = data.conversationType === "COMMUNITY";
  // Prefer explicit communityId; fall back to conversationId (roomId ===
  // communityId for community chat) so the membership gate always has a key.
  const communityId = isCommunity
    ? (data.communityId ?? data.conversationId)
    : data.communityId;

  // Notification eligibility gate (community only). A moderator-muted member's
  // community messages must NOT generate notifications for anyone. PRIVATE/GROUP
  // never invoke the gate (no gRPC call). Fail-open: an oracle outage resolves to
  // "not muted" so notifications still fan out. Returning early here is a
  // SUCCESS (the message is still ACKed by the consume callback) — NOT a nack.
  if (isCommunity && communityId) {
    const muted = await isCommunityActorMuted(data.senderId, communityId);
    if (muted) {
      logger.info(
        `Suppressing community notification fan-out: sender ${data.senderId} is muted in community ${communityId} (message ${data.messageId})`
      );
      return;
    }
  }

  let recipients = (data.recipientIds ?? []).filter(
    (id) => id && id !== data.senderId
  );
  if (recipients.length === 0) return;

  // Private-room mute gate: a recipient who has muted this 1-to-1 conversation
  // must not receive a push for it. Everything else (persistence, unread
  // counts, socket events, ordering) is unaffected — this consumer only
  // decides push delivery. Fail-open on oracle outage (see chatMessagingClient).
  if (
    data.conversationType === "PRIVATE" ||
    data.conversationType === "GROUP"
  ) {
    const muteChecks = await Promise.all(
      recipients.map((id) => isPrivateRoomMutedBy(id, data.conversationId))
    );
    const before = recipients.length;
    recipients = recipients.filter((_, i) => !muteChecks[i]);
    if (recipients.length < before) {
      logger.info(
        `Suppressing ${data.conversationType} push for ${before - recipients.length} muted recipient(s): room=${data.conversationId} message=${data.messageId}`
      );
    }
    if (recipients.length === 0) return;
  }

  // Group-room mute gate: mirror of the private-room gate above, but the mute
  // setting lives on the GroupMember row (per-membership) rather than the room.
  if (data.conversationType === "GROUP") {
    const muteChecks = await Promise.all(
      recipients.map((id) => isGroupMemberMuted(id, data.conversationId))
    );
    const before = recipients.length;
    recipients = recipients.filter((_, i) => !muteChecks[i]);
    if (recipients.length < before) {
      logger.info(
        `Suppressing group push for ${before - recipients.length} muted recipient(s): room=${data.conversationId} message=${data.messageId}`
      );
    }
    if (recipients.length === 0) return;
  }

  // Authoritative ACTIVE-roster filter: chat-service's RoomMember mirror can
  // lag behind leave/kick/ban, so a LEFT user may still appear in recipientIds.
  // Intersect with community-service's live ACTIVE ids before any FCM send.
  // Fail-closed (empty list) on oracle outage — never push to former members.
  if (isCommunity && communityId) {
    const before = recipients.length;
    recipients = await filterToActiveCommunityMembers(communityId, recipients);
    if (recipients.length < before) {
      logger.info(
        `Filtered ${before - recipients.length} non-ACTIVE recipient(s) from community FCM fan-out community=${communityId} message=${data.messageId}`
      );
    }
    if (recipients.length === 0) return;
  }

  const category = isCommunity ? "communityEnabled" : "chatEnabled";

  // For community messages: title = community name (if known), body = "Sender: preview".
  // For private/group: title = sender name, body = preview text.
  const copy = chatCopy.message({
    isCommunity,
    communityName: data.communityName,
    senderName: data.senderName,
    preview: data.preview,
  });

  // Include messageId in the community deep link so the client can scroll to
  // the specific message after navigating to the community chat room.
  const communityTarget = communityId ?? data.conversationId;
  const deepLink = isCommunity
    ? buildDeepLink("community", communityTarget, data.messageId)
    : buildDeepLink("conversation", data.conversationId);

  // showPreviewOverride hides sender name and message content when the user
  // has "show preview" disabled — the title (community/sender name) is safe.
  const navigation = JSON.stringify({
    screen: isCommunity
      ? "COMMUNITY_CHAT"
      : data.conversationType === "GROUP"
        ? "GROUP_CHAT"
        : "PRIVATE_CHAT",
    ...(data.communityId ? { communityId: data.communityId } : {}),
    ...(data.communityName ? { communityName: data.communityName } : {}),
    roomId: data.conversationId,
    conversationType: data.conversationType,
    messageId: data.messageId,
  } satisfies NotificationNavigation);

  const showPreviewOverride = (locale: SupportedLocale): string =>
    chatCopy.messagePreviewHidden(
      isCommunity ? data.communityName : undefined,
      locale
    );

  // Map PRIVATE → PERSONAL for thread-id generation (internal vs wire protocol naming)
  const chatType =
    data.conversationType === "PRIVATE" ? "PERSONAL" : data.conversationType;
  const threadId = generateThreadId(
    chatType as "PERSONAL" | "GROUP" | "COMMUNITY",
    data.conversationId,
    communityId
  );

  await pushToUsers(recipients, (userId) => ({
    userId,
    category,
    // Community chat messages share the `communityEnabled` global category
    // with generic community events but must gate on the community's own
    // `chatEnabled` preference (the "Chat" toggle), not `announcementEnabled`.
    ...(isCommunity ? { communityPrefField: "chatEnabled" as const } : {}),
    type: "MESSAGE",
    copy,
    actorId: data.senderId,
    deepLink,
    collapseKey: `conv:${data.conversationId}`,
    apnsThreadId: threadId,
    chatType: chatType as "PERSONAL" | "GROUP" | "COMMUNITY",
    showPreviewOverride,
    // Chat messages must never create a Notification Center entry — see
    // PushInput.skipInbox. Push (this call) and per-conversation unread
    // badges (chat-service, unrelated to the Notification collection)
    // continue to work unchanged.
    skipInbox: true,
    // FCM data map — all values MUST be strings.
    data: {
      type: "MESSAGE",
      conversationId: data.conversationId,
      conversationType: data.conversationType,
      ...(communityId ? { communityId } : {}),
      ...(data.communityName ? { communityName: data.communityName } : {}),
      messageId: data.messageId,
      clientMessageId: data.clientMessageId ?? "",
      senderId: data.senderId,
      senderName: data.senderName ?? "",
      senderAvatar: data.senderAvatar ?? "",
      ...(data.groupName ? { groupName: data.groupName } : {}),
      ...(data.conversationAvatar
        ? { conversationAvatar: data.conversationAvatar }
        : {}),
      canReply: data.canReply === false ? "false" : "true",
      ...(typeof data.unreadCount === "number"
        ? { unreadCount: String(data.unreadCount) }
        : {}),
      contentType: data.messageType ?? "",
      preview: data.preview ?? "",
      sentAt: String(data.sentAt ?? ""),
      idempotencyKey: data.messageId,
      deepLink,
      navigation,
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
