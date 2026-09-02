import { logger } from "@aimess/logger";
import amqp from "amqplib";
import { env } from "../config/env.js";
import { buildDeepLink } from "../lib/deep-link.js";
import { generateThreadId } from "../lib/thread-id.js";
import { enqueueChatPush } from "../services/chat-push-coalescer.js";
import {
  filterToNotifiableCommunityMembers,
  isCommunityActorMuted,
  filterOutMutedGroupMembers,
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
  previewImageUrl?: string;
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
  //
  // PRIVATE only. It used to run for GROUP as well, but `checkPrivateMute`
  // answers a group room id by MISSING PrivateRoom and then falling through to
  // exactly the `GroupMember.notificationSettings` read that the group gate
  // below performs — same verdict, same expiry semantics, two extra queries per
  // recipient to reach it. A group message therefore spent 3 database queries
  // per member (private miss + member row, then the member row again) where 1
  // decides it, and every one of those is a separate gRPC call into
  // chat-service — the same process serving sends. Dropping the redundant pass
  // suppresses exactly the same recipients.
  if (data.conversationType === "PRIVATE") {
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
    const before = recipients.length;
    // ONE call for the whole fan-out. This was `Promise.all` over
    // `isGroupMemberMuted` — one gRPC round trip per recipient into
    // chat-service, the same process serving message sends, so a 256-member
    // group message opened 256 concurrent calls against it. Community was
    // given the batched treatment after exactly this saturated
    // community-service and tripped its breaker; group had never had it.
    recipients = await filterOutMutedGroupMembers(
      data.conversationId,
      recipients
    );
    if (recipients.length < before) {
      logger.info(
        `Suppressing group push for ${before - recipients.length} muted recipient(s): room=${data.conversationId} message=${data.messageId}`
      );
    }
    if (recipients.length === 0) return;
  }

  // Authoritative ACTIVE-roster + per-recipient "chat notifications on" filter in
  // ONE call: chat-service's RoomMember mirror can lag behind leave/kick/ban, so a
  // LEFT user may still appear in recipientIds. Fail-closed (empty list) on oracle
  // outage — never push to former members. Resolving both gates for the whole
  // fan-out here is what lets pushToUser skip its per-recipient community oracles.
  if (isCommunity && communityId) {
    const before = recipients.length;
    recipients = await filterToNotifiableCommunityMembers(
      communityId,
      recipients,
      "chatEnabled"
    );
    if (recipients.length < before) {
      logger.info(
        `Filtered ${before - recipients.length} non-ACTIVE/opted-out recipient(s) from community FCM fan-out community=${communityId} message=${data.messageId}`
      );
    }
    if (recipients.length === 0) return;
  }

  // Every chat message — private, group AND community — is gated by the one
  // account-level Chat toggle, which is exactly what its subtitle promises
  // ("1-1, group, community messages"). Community messages used to sit under
  // the separate `communityEnabled` category, so turning Chat off left the
  // busiest source of messages still pushing; that category is now retired.
  const category = "chatEnabled" as const;

  const isGroup = data.conversationType === "GROUP";

  // Include messageId in the community deep link so the client can scroll to
  // the specific message after navigating to the community chat room.
  const communityTarget = communityId ?? data.conversationId;
  const deepLink = isCommunity
    ? buildDeepLink("community", communityTarget, data.messageId)
    : buildDeepLink("conversation", data.conversationId);

  // Map PRIVATE → PERSONAL for thread-id generation (internal vs wire protocol naming)
  const chatType =
    data.conversationType === "PRIVATE" ? "PERSONAL" : data.conversationType;
  const threadId = generateThreadId(
    chatType as "PERSONAL" | "GROUP" | "COMMUNITY",
    data.conversationId,
    communityId
  );

  // Hand the message to the per-(recipient, conversation) coalescer instead of
  // dispatching one push per message. Everything above — the mute gates, the
  // ACTIVE-roster filter, the muted-sender check — has already decided WHO is
  // eligible; the coalescer decides WHEN, HOW MANY, and (from presence, at
  // flush time) whether the notification is still worth sending at all.
  for (const userId of recipients) {
    enqueueChatPush(
      {
        userId,
        conversationId: data.conversationId,
        conversationType: data.conversationType,
        ...(communityId ? { communityId } : {}),
        ...(data.communityName ? { communityName: data.communityName } : {}),
        ...(isGroup && data.groupName ? { groupName: data.groupName } : {}),
        ...(data.conversationAvatar
          ? { conversationAvatar: data.conversationAvatar }
          : {}),
        ...(data.canReply !== undefined ? { canReply: data.canReply } : {}),
        deepLink,
        threadId,
        communityGatesPreResolved: isCommunity,
      },
      {
        messageId: data.messageId,
        clientMessageId: data.clientMessageId ?? "",
        senderId: data.senderId,
        senderName: data.senderName ?? "",
        senderAvatar: data.senderAvatar ?? "",
        preview: data.preview ?? "",
        ...(data.previewImageUrl
          ? { previewImageUrl: data.previewImageUrl }
          : {}),
        messageType: data.messageType ?? "",
        sentAt: data.sentAt,
      }
    );
  }
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
        // The queue has no dead-letter exchange, so `nack(requeue=false)` DESTROYS
        // the message — a single transient blip (gRPC timeout, DB hiccup) used to
        // lose that notification permanently. Retry exactly once via redelivery,
        // then drop: a deterministic failure (malformed payload) still can't spin,
        // but a transient one gets a second chance.
        const retry = message.fields?.redelivered !== true;
        logger.error(
          `Chat push consumer failed to process message — ${retry ? "requeueing once" : "dropping after retry"}`,
          error
        );
        channel.nack(message, false, retry);
      }
    })();
  });
}
