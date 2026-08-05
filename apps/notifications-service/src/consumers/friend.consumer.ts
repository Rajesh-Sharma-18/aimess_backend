import { logger } from "@aimess/logger";
import amqp from "amqplib";
import {
  FriendshipEvents,
  type FriendAcceptedPayload,
  type FriendCancelledPayload,
  type FriendRejectedPayload,
  type FriendRequestedPayload,
  type NotificationNavigation,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { buildDeepLink } from "../lib/deep-link.js";
import { friendCopy } from "../lib/notification-copy.js";
import { pushToUser } from "../services/push.service.js";

// user-service publishes friendship events to a plain durable queue (NOT a
// topic exchange) — match that. (See user-service publish-friendship.ts.)
const FRIENDSHIP_QUEUE = "friendship.queue";

async function handleFriendEvent(type: string, data: unknown): Promise<void> {
  switch (type) {
    case FriendshipEvents.FRIEND_REQUESTED: {
      const p = data as FriendRequestedPayload;
      const deepLink = buildDeepLink("user", p.requesterId);
      // Actor (requester) snapshot — client-side notification UI (Android
      // largeIcon, web push, in-app toast) reads this to show the requester's
      // avatar + name, mirroring the pattern established in community.consumer.ts.
      const actorSnapshot = {
        userId: p.requesterId,
        displayName: p.requesterName,
        avatarUrl: p.requesterAvatarUrl,
      };
      await pushToUser({
        userId: p.addresseeId,
        category: "friendRequestEnabled",
        type,
        actorId: p.requesterId,
        ...friendCopy.requested(p.requesterName),
        deepLink,
        data: {
          friendshipId: p.friendshipId,
          // Alias of friendshipId — matches the FE's pending-conversation
          // contract field name (`friendRequestId`), so a tapped push can
          // open the pending row directly without a name translation.
          friendRequestId: p.friendshipId,
          requesterId: p.requesterId,
          actorSnapshot: JSON.stringify(actorSnapshot),
          deepLink,
          navigation: JSON.stringify({
            // Opens the pending-conversation screen (Accept/Reject only),
            // not the generic friend-requests list — same deep-link target
            // as a real private chat, distinguished by conversationType.
            screen: "PRIVATE_CHAT",
            userId: p.requesterId,
            conversationType: "PRIVATE_PENDING",
            requestId: p.friendshipId,
          } satisfies NotificationNavigation),
        },
      });
      break;
    }

    case FriendshipEvents.FRIEND_ACCEPTED: {
      const p = data as FriendAcceptedPayload;
      const deepLinkForRequester = buildDeepLink("user", p.addresseeId);
      // Requester — the side who sent the original request.
      await pushToUser({
        userId: p.requesterId,
        category: "friendRequestEnabled",
        type,
        actorId: p.addresseeId,
        ...friendCopy.acceptedForRequester(p.addresseeName),
        deepLink: deepLinkForRequester,
        data: {
          friendshipId: p.friendshipId,
          addresseeId: p.addresseeId,
          deepLink: deepLinkForRequester,
          resolution: `${p.addresseeName?.trim() || "Someone"} accepted your friend request.`,
          actorSnapshot: JSON.stringify({
            userId: p.addresseeId,
            displayName: p.addresseeName,
            avatarUrl: p.addresseeAvatarUrl,
          }),
          navigation: JSON.stringify({
            screen: "USER_PROFILE",
            userId: p.addresseeId,
          } satisfies NotificationNavigation),
        },
      });
      // Addressee — the side who just accepted. Update their friend.requested
      // inbox row in-place (gRPC) with a resolution line; keep the Friend Request
      // card title/body intact.
      const deepLinkForAddressee = buildDeepLink("user", p.requesterId);
      await pushToUser({
        userId: p.addresseeId,
        category: "friendRequestEnabled",
        type,
        actorId: p.requesterId,
        ...friendCopy.acceptedForAddressee(p.requesterName),
        deepLink: deepLinkForAddressee,
        data: {
          friendshipId: p.friendshipId,
          requesterId: p.requesterId,
          deepLink: deepLinkForAddressee,
          // This user IS the actor — their own accept must not re-flag the row
          // unread on their other devices.
          resurface: "false",
          resolution: "You are now friends!",
          actorSnapshot: JSON.stringify({
            userId: p.requesterId,
            displayName: p.requesterName,
            avatarUrl: p.requesterAvatarUrl,
          }),
          navigation: JSON.stringify({
            screen: "USER_PROFILE",
            userId: p.requesterId,
          } satisfies NotificationNavigation),
        },
      });
      break;
    }

    case FriendshipEvents.FRIEND_REJECTED: {
      const p = data as FriendRejectedPayload;
      const deepLink = buildDeepLink("user", p.addresseeId);
      // Notify the requester that their request was declined.
      await pushToUser({
        userId: p.requesterId,
        category: "friendRequestEnabled",
        type,
        actorId: p.addresseeId,
        ...friendCopy.rejected(p.addresseeName),
        deepLink,
        data: {
          friendshipId: p.friendshipId,
          addresseeId: p.addresseeId,
          deepLink,
          resolution: "Declined your friend request",
          resolutionTone: "danger",
          actorSnapshot: JSON.stringify({
            userId: p.addresseeId,
            displayName: p.addresseeName,
            avatarUrl: p.addresseeAvatarUrl,
          }),
          navigation: JSON.stringify({
            screen: "FRIEND_REQUESTS",
            userId: p.addresseeId,
          } satisfies NotificationNavigation),
        },
      });
      // Update the ADDRESSEE's own friend.requested inbox row in-place so it
      // persists the "I have declined" state across reloads. The gRPC handler
      // detects type="friend.rejected" and replaces the existing friend.requested
      // row instead of creating a new notification (mirrors the friend.accepted path).
      await pushToUser({
        userId: p.addresseeId,
        category: "friendRequestEnabled",
        type,
        actorId: p.requesterId,
        ...friendCopy.rejectedSelf(p.requesterName),
        data: {
          friendshipId: p.friendshipId,
          requesterId: p.requesterId,
          resurface: "false",
          resolution: "You declined this friend request",
          resolutionTone: "danger",
          actorSnapshot: JSON.stringify({
            userId: p.requesterId,
            displayName: p.requesterName,
            avatarUrl: p.requesterAvatarUrl,
          }),
        },
      });
      break;
    }

    case FriendshipEvents.FRIEND_CANCELLED: {
      const p = data as FriendCancelledPayload;
      const deepLink = buildDeepLink("user", p.requesterId);
      // Withdrawing a request must leave NOTHING behind, on either side. The
      // addressee's incoming card is removed below; this removes the requester's
      // own copy of the same friendship group so a cancel from one device doesn't
      // leave a ghost card on their other devices. Both resolve to the same
      // groupKey (friend:<friendshipId>), so the delete branch handles each.
      await pushToUser({
        userId: p.requesterId,
        category: "friendRequestEnabled",
        type,
        actorId: p.addresseeId,
        ...friendCopy.cancelled(p.requesterName),
        dataOnly: true,
        data: {
          friendshipId: p.friendshipId,
          addresseeId: p.addresseeId,
          requesterId: p.requesterId,
        },
      });
      await pushToUser({
        userId: p.addresseeId,
        category: "friendRequestEnabled",
        type,
        actorId: p.requesterId,
        ...friendCopy.cancelled(p.requesterName),
        // Silent: this event REMOVES the request row, so a visible push
        // announcing a cancellation would contradict the row disappearing.
        dataOnly: true,
        deepLink,
        data: {
          friendshipId: p.friendshipId,
          requesterId: p.requesterId,
          deepLink,
          // Terminal — the gRPC handler updates the addressee's existing
          // friend.requested row in place and drops Accept/Reject once it
          // sees this resolution (mirrors the reject/accept paths).
          resolution: "The sender cancelled this friend request",
          resolutionTone: "danger",
          actorSnapshot: JSON.stringify({
            userId: p.requesterId,
            displayName: p.requesterName,
            avatarUrl: p.requesterAvatarUrl,
          }),
          navigation: JSON.stringify({
            screen: "FRIEND_REQUESTS",
            userId: p.requesterId,
          } satisfies NotificationNavigation),
        },
      });
      break;
    }

    case FriendshipEvents.FRIEND_UNFRIENDED:
      // No notification on unfriend (silent per product policy).
      break;

    default:
      logger.warn(`Unknown friendship event type: ${type}`);
  }
}

export async function startFriendConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(FRIENDSHIP_QUEUE, { durable: true });
  await channel.prefetch(10);

  logger.info("Friend notification consumer started");

  void channel.consume(FRIENDSHIP_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: unknown;
        };
        await handleFriendEvent(parsed.type, parsed.data);
        channel.ack(message);
      } catch (error) {
        logger.error("Friend consumer failed to process message", error);
        channel.nack(message, false, false);
      }
    })();
  });
}
