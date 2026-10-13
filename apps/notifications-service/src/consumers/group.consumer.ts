import { logger } from "@aimess/logger";
import { t, type SupportedLocale } from "@aimess/constants";
import amqp from "amqplib";
import {
  ChatEvents,
  type ChatGroupJoinRequestDecidedPayload,
  type ChatGroupJoinRequestedPayload,
  type ChatGroupJoinRequestRetractedPayload,
  type ChatGroupLeaderChangedPayload,
  type ChatGroupMemberAddedPayload,
  type NotificationNavigation,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { userIdentityClient } from "../grpc/user-identity.client.js";
import { buildDeepLink } from "../lib/deep-link.js";
import { groupCopy } from "../lib/notification-copy.js";
import { pushTag } from "../lib/push-tags.js";
import { generateThreadId } from "../lib/thread-id.js";
import { pushToUser, pushToUsers } from "../services/push.service.js";

/**
 * chat-service publishes group lifecycle events (currently MEMBER_ADDED) to a
 * plain durable queue (NOT an exchange) — match that. The added member may not be
 * in the room socket, so we push/inbox them here. Gates on the chat category.
 * Throwing → caller nacks(no requeue) so the message DLQs.
 */
const CHAT_GROUP_QUEUE = "chat.group.queue";

// Mirrors community.consumer's join-request card: one card per (group, requester),
// Accept/Decline re-enter the authenticated /chat/group-join-requests endpoints.
const joinRequestTag = (roomId: string, requesterId: string): string =>
  `group_join_request_${roomId}_${requesterId}`;
const joinRequestGroupKey = (roomId: string, requesterId: string): string =>
  `group:${roomId}:join_request:${requesterId}`;
const joinRequestPushActions = (
  locale: SupportedLocale
): ReadonlyArray<{ action: string; title: string }> => [
  { action: "group_join_request_accept", title: t("NOTIF_ACTION_ACCEPT", locale) },
  { action: "group_join_request_reject", title: t("NOTIF_ACTION_DECLINE", locale) },
];

async function retractJoinRequestCards(
  recipients: string[],
  roomId: string,
  requesterId: string,
  resolution: string,
  requestId?: string,
  raisedAt?: string
): Promise<void> {
  if (recipients.length === 0) return;
  await pushToUsers(recipients, (userId) => ({
    userId,
    category: "chatEnabled" as const,
    type: ChatEvents.GROUP_JOIN_REQUEST_RETRACTED,
    dataOnly: true,
    bypassSettings: true,
    collapseKey: joinRequestTag(roomId, requesterId),
    data: {
      groupKey: joinRequestGroupKey(roomId, requesterId),
      type: ChatEvents.GROUP_JOIN_REQUEST_RETRACTED,
      roomId,
      requesterId,
      resolution,
      tag: joinRequestTag(roomId, requesterId),
      ...(raisedAt ? { staleBefore: raisedAt } : {}),
      ...(requestId ? { requestId, joinRequestId: requestId } : {}),
    },
  }));
}

async function handleGroupEvent(type: string, data: unknown): Promise<void> {
  switch (type) {
    case ChatEvents.GROUP_MEMBER_ADDED: {
      const p = data as ChatGroupMemberAddedPayload;
      const deepLink = buildDeepLink("group", p.roomId);
      // "{actor} added {target} to {group}" — names from user-service, the same
      // "Firstname Lastname" source as the community copy; "" falls back to the
      // localized "Someone" rather than a fabricated name.
      const [actorName, targetName] = await Promise.all([
        userIdentityClient.getDisplayName(p.actorId),
        userIdentityClient.getDisplayName(p.addedUserId),
      ]);
      await pushToUser({
        userId: p.addedUserId,
        category: "chatEnabled",
        type,
        actorId: p.actorId,
        copy: groupCopy.memberAdded(
          p.groupName,
          actorName?.trim() ?? "",
          targetName?.trim() ?? "",
          p.actorId,
          p.addedUserId,
          p.actorRole
        ),
        deepLink,
        apnsThreadId: generateThreadId("GROUP", p.roomId),
        // Closed with the rest of the room's cards once they open it.
        collapseKey: pushTag.added(p.roomId),
        data: {
          roomId: p.roomId,
          groupName: p.groupName,
          actorId: p.actorId,
          // The GROUP's own image, not the actor's — a group notification
          // represents the conversation. push.service promotes this to the
          // FCM/APNs tray image; absent when the group has no avatar.
          ...(p.groupAvatarUrl ? { conversationAvatar: p.groupAvatarUrl } : {}),
          deepLink,
          navigation: JSON.stringify({
            screen: "GROUP_CHAT",
            roomId: p.roomId,
            conversationType: "GROUP",
          } satisfies NotificationNavigation),
        },
      });
      break;
    }

    case ChatEvents.GROUP_LEADER_CHANGED: {
      const p = data as ChatGroupLeaderChangedPayload;
      const deepLink = buildDeepLink("group", p.roomId);
      await pushToUser({
        userId: p.targetUserId,
        category: "chatEnabled",
        type,
        actorId: p.actorId || undefined,
        copy: groupCopy.leaderChanged(p.groupName),
        deepLink,
        data: {
          roomId: p.roomId,
          groupName: p.groupName,
          ...(p.groupAvatarUrl ? { conversationAvatar: p.groupAvatarUrl } : {}),
          deepLink,
          navigation: JSON.stringify({
            screen: "GROUP_CHAT",
            roomId: p.roomId,
            conversationType: "GROUP",
          } satisfies NotificationNavigation),
        },
      });
      break;
    }

    case ChatEvents.GROUP_JOIN_REQUESTED: {
      const p = data as ChatGroupJoinRequestedPayload;
      // ADMIN-only roster from the producer; never the requester themselves.
      const recipients = (p.adminRecipientIds ?? []).filter(
        (id) => id !== p.requesterId
      );
      if (recipients.length === 0) break;
      const requesterName =
        (await userIdentityClient.getDisplayName(p.requesterId))?.trim() ?? "";
      const deepLink = buildDeepLink("group", p.roomId);
      // A new attempt supersedes any card a lost retraction left behind.
      await retractJoinRequestCards(recipients, p.roomId, p.requesterId, "SUPERSEDED");
      await pushToUsers(recipients, (userId) => ({
        userId,
        category: "chatEnabled" as const,
        type,
        actorId: p.requesterId,
        copy: groupCopy.joinRequested(p.groupName, requesterName),
        actions: joinRequestPushActions,
        apnsCategory: "GROUP_JOIN_REQUEST",
        collapseKey: joinRequestTag(p.roomId, p.requesterId),
        deepLink,
        data: {
          groupKey: joinRequestGroupKey(p.roomId, p.requesterId),
          roomId: p.roomId,
          groupName: p.groupName,
          requestId: p.requestId,
          joinRequestId: p.requestId,
          requesterId: p.requesterId,
          requesterDisplayName: requesterName,
          tag: joinRequestTag(p.roomId, p.requesterId),
          ...(p.groupAvatarUrl ? { conversationAvatar: p.groupAvatarUrl } : {}),
          deepLink,
          navigation: JSON.stringify({
            screen: "GROUP_REQUESTS",
            roomId: p.roomId,
            conversationType: "GROUP",
            requestId: p.requestId,
            userId: p.requesterId,
          } satisfies NotificationNavigation),
        },
      }));
      break;
    }

    case ChatEvents.GROUP_JOIN_REQUEST_RETRACTED: {
      const p = data as ChatGroupJoinRequestRetractedPayload;
      await retractJoinRequestCards(
        p.adminRecipientIds ?? [],
        p.roomId,
        p.requesterId,
        p.resolution,
        p.requestId,
        p.eventAt
      );
      break;
    }

    case ChatEvents.GROUP_JOIN_REQUEST_APPROVED:
    case ChatEvents.GROUP_JOIN_REQUEST_REJECTED: {
      const p = data as ChatGroupJoinRequestDecidedPayload;
      const approved = type === ChatEvents.GROUP_JOIN_REQUEST_APPROVED;
      const deepLink = buildDeepLink("group", p.roomId);
      await pushToUser({
        userId: p.requesterId,
        category: "chatEnabled",
        type,
        actorId: p.decidedBy,
        copy: approved
          ? groupCopy.joinRequestApproved(p.groupName)
          : groupCopy.joinRequestRejected(p.groupName),
        deepLink,
        data: {
          roomId: p.roomId,
          groupName: p.groupName,
          requestId: p.requestId,
          status: approved ? "APPROVED" : "REJECTED",
          ...(p.groupAvatarUrl ? { conversationAvatar: p.groupAvatarUrl } : {}),
          deepLink,
          navigation: JSON.stringify({
            screen: approved ? "GROUP_CHAT" : "NOTIFICATIONS",
            roomId: p.roomId,
            conversationType: "GROUP",
            requestId: p.requestId,
          } satisfies NotificationNavigation),
        },
      });
      break;
    }

    default:
      logger.warn(`Unknown chat group event type: ${type}`);
  }
}

export async function startGroupConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(CHAT_GROUP_QUEUE, { durable: true });
  await channel.prefetch(10);

  logger.info("Group notification consumer started");

  void channel.consume(CHAT_GROUP_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: unknown;
        };
        await handleGroupEvent(parsed.type, parsed.data);
        channel.ack(message);
      } catch (error) {
        logger.error("Group consumer failed to process message", error);
        channel.nack(message, false, false);
      }
    })();
  });
}
