import { logger } from "@aimess/logger";
import { usersWithRoomOpen } from "@aimess/redis";
import amqp from "amqplib";
import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { buildDeepLink } from "../lib/deep-link.js";
import { chatCopy } from "../lib/notification-copy.js";
import { generateThreadId } from "../lib/thread-id.js";
import { enqueueChatPush } from "../services/chat-push-coalescer.js";
import { pushToUser } from "../services/push.service.js";
import {
  getNotificationSettings,
  isMentionAllMuted,
} from "../services/notification-settings.service.js";
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
  /** Permanent object key behind previewImageUrl — lets a client re-mint an expired URL. */
  previewImageKey?: string;
  messageType: string;
  sentAt: number;
  recipientIds: string[];
  /**
   * GROUP only: recipients @mentioned in this message (already server-validated
   * and sender-excluded by chat-service). Ignored for PRIVATE/COMMUNITY.
   */
  mentionedUserIds?: string[];
  /**
   * GROUP only: recipients reached by @all (server-resolved active members,
   * sender and deleted accounts excluded). Each one's own @all mute applies.
   */
  mentionAllUserIds?: string[];
  /** Edit publish: push ONLY to the mentioned / @all sets, never a plain push. */
  mentionOnly?: boolean;
  /**
   * The album row that holds content.mentions, when it is not `messageId`.
   * Mention rows key and navigate on it; the push keeps `messageId`.
   */
  mentionMessageId?: string;
  /** Re-mention after a retraction: write the rows, never enqueue a push. */
  inboxOnly?: boolean;
}

/** chat-service: the message was deleted, or these users' mention edited out. */
interface MentionRetractedPayload {
  messageId: string;
  conversationId: string;
  userIds: string[];
  /** Name removed while @all stays: retract only if the user muted @all. */
  ifAllMutedUserIds?: string[];
}

/** One claim per (message, recipient) row; the push has its own upstream claim. */
const MENTION_ROW_CLAIM_TTL_SEC = 3600;
const mentionRowClaimKey = (messageId: string, userId: string): string =>
  `notif:mention-row:{${messageId}}:${userId}`;

/**
 * Notification-Center rows for a GROUP @mention: one `chat.mention` row per
 * mentioned recipient, written BEFORE any push is enqueued so a failed write
 * nacks the message with nothing pushed yet.
 *
 * `recipients` has already been through every gate (sender excluded, @all
 * opt-out, mute bypass, mentionOnly), so this only picks the mentioned ones.
 * A Redis SET NX claim makes the write once-only across concurrent first
 * deliveries; it fails open, and the explicit groupKey still turns a replay
 * into an UPDATE instead of a second row. A redelivery (the claim may belong to
 * a crashed first attempt) and an inboxOnly re-mention (the claim outlives the
 * retracted row) skip the claim and lean on the groupKey alone.
 */
async function writeMentionRows(
  data: MessageSentPayload,
  recipients: string[],
  individual: Set<string>,
  allowedAll: Set<string>,
  finalAttempt: boolean
): Promise<void> {
  // An album publishes its LAST row as messageId, but only the first row keeps
  // content.mentions: the row, the guard and retraction all key on that one.
  const mentionId = data.mentionMessageId || data.messageId;
  // Without a message id the row has no identity: every such event would share
  // groupKey "mention:" and escape the chat-service guard.
  if (!mentionId) return;
  const rowRecipients = recipients.filter(
    (id) => individual.has(id) || allowedAll.has(id)
  );
  if (rowRecipients.length === 0) return;

  let claimed = rowRecipients;
  if (!finalAttempt && !data.inboxOnly) {
    try {
      const pipeline = redis.pipeline();
      for (const id of rowRecipients) {
        pipeline.set(
          mentionRowClaimKey(mentionId, id),
          "1",
          "EX",
          MENTION_ROW_CLAIM_TTL_SEC,
          "NX"
        );
      }
      const replies = await pipeline.exec();
      if (replies) {
        // Only a clean nil reply means "already claimed"; a per-command error
        // fails open like the pipeline as a whole.
        claimed = rowRecipients.filter((_, i) => {
          const reply = replies[i];
          return !reply || reply[0] !== null || reply[1] !== null;
        });
      }
    } catch (error) {
      logger.warn(
        `Mention row claim failed for message ${mentionId}; writing anyway`
      );
      logger.warn(error);
    }
  }
  if (claimed.length === 0) return;

  // Someone already reading the room gets the row as read: no badge bump.
  const open = await usersWithRoomOpen(redis, data.conversationId, claimed);
  const actorSnapshot = JSON.stringify({
    userId: data.senderId,
    displayName: data.senderName,
    avatarUrl: data.senderAvatar,
  });
  const navigation = JSON.stringify({
    screen: "GROUP_CHAT",
    roomId: data.conversationId,
    conversationType: "GROUP",
    messageId: mentionId,
  });

  // ponytail: one CreateNotification gRPC round per recipient (≤256 members
  // for an @all); add a batch RPC if groups grow past that.
  const results = await Promise.allSettled(
    claimed.map((userId) => {
      // Why THIS reader got the row. Being named wins over being in the room,
      // so "@all @kristi" is one row for Kristi and it says "mentioned you".
      const mentionType = individual.has(userId) ? "USER" : "ALL";
      return pushToUser({
        userId,
        category: "chatEnabled",
        type: "chat.mention",
        skipPush: true,
        actorId: data.senderId,
        inboxTitle: null,
        copy: chatCopy.mentionInbox({
          senderName: data.senderName,
          groupName: data.groupName,
          ...(mentionType === "ALL" ? { all: true } : {}),
        }),
        data: {
          groupKey: `mention:${mentionId}`,
          mentionType,
          conversationId: data.conversationId,
          conversationType: "GROUP",
          messageId: mentionId,
          ...(data.groupName ? { groupName: data.groupName } : {}),
          ...(data.conversationAvatar
            ? { groupAvatarUrl: data.conversationAvatar }
            : {}),
          actorSnapshot,
          navigation,
          ...(open.has(userId) ? { markRead: "true" } : {}),
        },
      });
    })
  );

  const failed = claimed.filter((_, i) => results[i]!.status === "rejected");
  if (failed.length === 0) return;
  // Release the failed claims so the redelivery retries exactly those rows.
  await redis
    .del(...failed.map((id) => mentionRowClaimKey(mentionId, id)))
    .catch((error: unknown) => logger.warn(error));
  const reason = `Mention inbox write failed for ${failed.length} recipient(s): message=${mentionId}`;
  // The redelivery is the last try (the consumer drops after it). Throwing
  // there would cost every group member the PUSH too; lose only the rows.
  if (finalAttempt) {
    logger.error(`${reason}; pushing without them`);
    return;
  }
  throw new Error(reason);
}

/**
 * Remove the mention rows chat-service says are no longer justified. Bypasses
 * settings so a user who has since turned Chat off (or left) is still cleaned
 * up; no row to remove is a no-op on the chat-service side.
 */
async function handleMentionRetracted(
  data: MentionRetractedPayload
): Promise<void> {
  const ifAllMuted = [...new Set(data.ifAllMutedUserIds ?? [])].filter(Boolean);
  // Only notifications-service can see the @all mute; a failed read keeps the row.
  const allMuted = await Promise.all(
    ifAllMuted.map((id) =>
      getNotificationSettings(id)
        .then(isMentionAllMuted)
        .catch(() => false)
    )
  );
  const userIds = [
    ...new Set([
      ...(data.userIds ?? []),
      ...ifAllMuted.filter((_, i) => allMuted[i]),
    ]),
  ].filter(Boolean);
  if (userIds.length === 0) return;
  const results = await Promise.allSettled(
    userIds.map((userId) =>
      pushToUser({
        userId,
        category: "chatEnabled",
        type: "chat.mention_retracted",
        skipPush: true,
        bypassSettings: true,
        data: {
          groupKey: `mention:${data.messageId}`,
          conversationId: data.conversationId,
          messageId: data.messageId,
        },
      })
    )
  );
  // Free the row claims so a later re-mention of the same message writes again.
  // One hash-tagged slot per message, so the multi-key DEL is cluster-safe.
  await redis
    .del(...userIds.map((id) => mentionRowClaimKey(data.messageId, id)))
    .catch((error: unknown) => logger.warn(error));
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    throw new Error(
      `Mention retraction failed for ${failed} recipient(s): message=${data.messageId}`
    );
  }
}

async function handleMessageSent(
  data: MessageSentPayload,
  finalAttempt = false
): Promise<void> {
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

  // @mentioned recipients (GROUP only). Mentions on any other conversation type
  // are ignored outright — chat-service never persists them there anyway.
  const isGroupMessage = data.conversationType === "GROUP";
  const inRecipients = new Set(recipients);
  const individual = new Set(
    isGroupMessage && Array.isArray(data.mentionedUserIds)
      ? data.mentionedUserIds.filter((id) => inRecipients.has(id))
      : []
  );
  // @all recipients who have not muted @all. A muted-@all user falls back to an
  // ordinary group message (group mute applies, no mention flag).
  // ponytail: N cached settings reads per @all message; add a batch RPC if
  // groups grow well past MAX_GROUP_MEMBERS.
  const allCandidates =
    isGroupMessage && Array.isArray(data.mentionAllUserIds)
      ? [...new Set(data.mentionAllUserIds)].filter(
          (id) => inRecipients.has(id) && !individual.has(id)
        )
      : [];
  const allMuted = await Promise.all(
    allCandidates.map((id) =>
      getNotificationSettings(id)
        .then(isMentionAllMuted)
        .catch(() => false)
    )
  );
  const allowedAll = new Set(allCandidates.filter((_, i) => !allMuted[i]));
  const mentioned = new Set([...individual, ...allowedAll]);

  if (isGroupMessage && data.mentionOnly === true) {
    recipients = recipients.filter((id) => mentioned.has(id));
    if (recipients.length === 0) return;
  }

  // Group-room mute gate: mirror of the private-room gate above, but the mute
  // setting lives on the GroupMember row (per-membership) rather than the room.
  if (data.conversationType === "GROUP") {
    const before = recipients.length;
    // A mention bypasses the member's group mute — the shipped mute copy
    // promises "You will still be notified if you are mentioned". Only the
    // NON-mentioned recipients go through the gate; mentioned ones are only
    // ever taken from recipientIds, never added. Account-level Chat toggle,
    // quiet hours and room-open/foreground suppression still apply downstream.
    //
    // ONE call for the whole fan-out. This was `Promise.all` over
    // `isGroupMemberMuted` — one gRPC round trip per recipient into
    // chat-service, the same process serving message sends, so a 256-member
    // group message opened 256 concurrent calls against it. Community was
    // given the batched treatment after exactly this saturated
    // community-service and tripped its breaker; group had never had it.
    const others = recipients.filter((id) => !mentioned.has(id));
    const unmuted = new Set(
      others.length > 0
        ? await filterOutMutedGroupMembers(data.conversationId, others)
        : []
    );
    recipients = [...new Set(recipients)].filter(
      (id) => mentioned.has(id) || unmuted.has(id)
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

  if (isGroup) {
    await writeMentionRows(
      data,
      recipients,
      individual,
      allowedAll,
      finalAttempt
    );
  }
  // A re-mention of an already-pushed message: the rows are the whole point.
  if (data.inboxOnly) return;

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
        ...(data.previewImageKey
          ? { previewImageKey: data.previewImageKey }
          : {}),
        messageType: data.messageType ?? "",
        sentAt: data.sentAt,
        ...(individual.has(userId)
          ? { mentioned: true }
          : allowedAll.has(userId)
            ? { mentionAll: true }
            : {}),
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
          data: unknown;
        };
        if (parsed.type === "chat.message_sent") {
          await handleMessageSent(
            parsed.data as MessageSentPayload,
            message.fields?.redelivered === true
          );
        } else if (parsed.type === "chat.mention_retracted") {
          await handleMentionRetracted(parsed.data as MentionRetractedPayload);
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
