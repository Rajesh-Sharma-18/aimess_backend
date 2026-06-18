import { logger } from "@aimess/logger";
import { publishUserSocketEvent } from "@aimess/redis";
import amqp from "amqplib";
import {
  CommunityEvents,
  type CommunityAdminTransferredPayload,
  type CommunityDeletedPayload,
  type CommunityInviteAcceptedPayload,
  type CommunityInviteSentPayload,
  type CommunityJoinRequestApprovedPayload,
  type CommunityJoinRequestedPayload,
  type CommunityJoinRequestRejectedPayload,
  type CommunityMemberAddedPayload,
  type CommunityMemberBannedPayload,
  type CommunityMemberJoinedPayload,
  type CommunityMemberKickedPayload,
  type CommunityMemberMutedPayload,
  type CommunityMemberRoleChangedPayload,
  type CommunityMemberUnmutedPayload,
  type CommunityMemberWarnedPayload,
  type CommunityReportActionedPayload,
  type CommunityReportCreatedPayload,
  type NotificationNavigation,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import {
  pushToUser,
  pushToUsers,
  type PushInput,
} from "../services/push.service.js";

const COMMUNITY_QUEUE = "community.queue";

/** community.* notifications all gate on the communityEnabled category. */
function base(
  type: string,
  communityId: string,
  actorId: string | undefined,
  extra: Record<string, string>
): Pick<PushInput, "category" | "type" | "actorId" | "data"> {
  return {
    category: "communityEnabled",
    type,
    actorId,
    data: { communityId, ...extra },
  };
}

/**
 * Map one CommunityEvent to its recipient pushes. Each branch resolves the
 * recipient roster from the (roster-enriched) payload and fans pushes out.
 * Throwing here → caller nacks(no requeue) so the message DLQs.
 */
async function handleCommunityEvent(
  type: string,
  data: unknown
): Promise<void> {
  switch (type) {
    case CommunityEvents.JOIN_REQUESTED: {
      const p = data as CommunityJoinRequestedPayload;
      const navigation: NotificationNavigation = {
        screen: "COMMUNITY_REQUESTS",
        communityId: p.communityId,
        communityName: p.communityName,
        communityAvatarUrl: p.communityAvatarUrl,
        communityHandle: p.communityHandle,
        requestId: p.requestId,
      };
      const actorSnapshot = {
        userId: p.userId,
        displayName: p.requesterDisplayName,
        avatarUrl: p.requesterAvatarUrl,
      };
      await pushToUsers(p.moderatorRecipientIds, (userId) => ({
        userId,
        title: "New join request",
        body: `${p.requesterDisplayName} requested to join ${p.communityName}.`,
        ...base(type, p.communityId, p.userId, {
          requestId: p.requestId,
          requesterId: p.userId,
          communityName: p.communityName,
          communityHandle: p.communityHandle,
          communityAvatarUrl: p.communityAvatarUrl ?? "",
          requesterDisplayName: p.requesterDisplayName,
          requesterAvatarUrl: p.requesterAvatarUrl ?? "",
          navigation: JSON.stringify(navigation),
          actorSnapshot: JSON.stringify(actorSnapshot),
        }),
      }));
      break;
    }

    case CommunityEvents.JOIN_REQUEST_APPROVED: {
      const p = data as CommunityJoinRequestApprovedPayload;
      const navigation: NotificationNavigation = {
        screen: "COMMUNITY_DETAILS",
        communityId: p.communityId,
        communityName: p.communityName,
        communityAvatarUrl: p.communityAvatarUrl,
        communityHandle: p.communityHandle,
        requestId: p.requestId,
      };
      const actorSnapshot = {
        userId: p.decidedBy.userId,
        displayName: p.decidedBy.displayName,
      };
      await pushToUser({
        userId: p.userId,
        title: "Join request approved",
        body: `Your request to join ${p.communityName} was approved by ${p.decidedBy.displayName}.`,
        ...base(type, p.communityId, p.decidedBy.userId, {
          requestId: p.requestId,
          status: "APPROVED",
          communityName: p.communityName,
          communityHandle: p.communityHandle,
          communityAvatarUrl: p.communityAvatarUrl ?? "",
          decidedByDisplayName: p.decidedBy.displayName,
          navigation: JSON.stringify(navigation),
          actorSnapshot: JSON.stringify(actorSnapshot),
        }),
      });
      await publishUserSocketEvent(
        redis,
        p.userId,
        "community:join_request:update",
        {
          communityId: p.communityId,
          requestId: p.requestId,
          status: "APPROVED",
          communityName: p.communityName,
          decidedAt: p.decidedAt,
          navigation,
        }
      ).catch((e) => logger.error(e));
      break;
    }

    case CommunityEvents.JOIN_REQUEST_REJECTED: {
      const p = data as CommunityJoinRequestRejectedPayload;
      const navigation: NotificationNavigation = {
        screen: "COMMUNITY_DETAILS",
        communityId: p.communityId,
        communityName: p.communityName,
        communityAvatarUrl: p.communityAvatarUrl,
        communityHandle: p.communityHandle,
        requestId: p.requestId,
      };
      const actorSnapshot = {
        userId: p.decidedBy.userId,
        displayName: p.decidedBy.displayName,
      };
      await pushToUser({
        userId: p.userId,
        title: "Join request declined",
        body: `Your request to join ${p.communityName} was declined.`,
        ...base(type, p.communityId, p.decidedBy.userId, {
          requestId: p.requestId,
          status: "REJECTED",
          communityName: p.communityName,
          communityHandle: p.communityHandle,
          communityAvatarUrl: p.communityAvatarUrl ?? "",
          decidedByDisplayName: p.decidedBy.displayName,
          navigation: JSON.stringify(navigation),
          actorSnapshot: JSON.stringify(actorSnapshot),
        }),
      });
      await publishUserSocketEvent(
        redis,
        p.userId,
        "community:join_request:update",
        {
          communityId: p.communityId,
          requestId: p.requestId,
          status: "REJECTED",
          communityName: p.communityName,
          decidedAt: p.decidedAt,
          navigation,
        }
      ).catch((e) => logger.error(e));
      break;
    }

    case CommunityEvents.MEMBER_JOINED: {
      const p = data as CommunityMemberJoinedPayload;
      const navigation: NotificationNavigation = {
        screen: "COMMUNITY_DETAILS",
        communityId: p.communityId,
        communityName: p.communityName,
        communityAvatarUrl: p.communityAvatarUrl,
        communityHandle: p.communityHandle,
      };
      await pushToUser({
        userId: p.userId,
        title: "Joined a community",
        body: `You have joined ${p.communityName}.`,
        ...base(type, p.communityId, p.userId, {
          communityName: p.communityName,
          communityHandle: p.communityHandle,
          communityAvatarUrl: p.communityAvatarUrl ?? "",
          navigation: JSON.stringify(navigation),
        }),
      });
      // Real-time UI flip: "Join" button → "Joined" without a page refresh.
      await publishUserSocketEvent(redis, p.userId, "community:joined", {
        communityId: p.communityId,
        communityName: p.communityName,
        communityHandle: p.communityHandle,
        communityAvatarUrl: p.communityAvatarUrl,
        reactivated: p.reactivated,
      }).catch((e) => logger.error(e));
      break;
    }

    case CommunityEvents.MEMBER_ADDED: {
      const p = data as CommunityMemberAddedPayload;
      // Welcome the joiner — UNLESS they will get the dedicated "approved" or
      // "self_join" (MEMBER_JOINED) notification.
      if (p.via !== "join_request_approved" && p.via !== "self_join") {
        await pushToUser({
          userId: p.targetUserId,
          title: "Welcome to the community",
          body: "You were added to a community.",
          ...base(type, p.communityId, p.actorId, { via: p.via }),
        });
      }
      // Admin/moderator awareness: a member joined.
      const mods = (p.moderatorRecipientIds ?? []).filter(
        (id) => id !== p.actorId && id !== p.targetUserId
      );
      if (mods.length > 0) {
        await pushToUsers(mods, (userId) => ({
          userId,
          title: "New member joined",
          body: "A new member joined your community.",
          ...base(type, p.communityId, p.actorId, {
            via: p.via,
            joinedUserId: p.targetUserId,
          }),
        }));
      }
      break;
    }

    case CommunityEvents.ADMIN_TRANSFERRED: {
      const p = data as CommunityAdminTransferredPayload;
      await pushToUser({
        userId: p.targetUserId,
        title: "You are now an admin",
        body: "Community administration was transferred to you.",
        ...base(type, p.communityId, p.actorId, { reason: p.reason }),
      });
      break;
    }

    case CommunityEvents.MEMBER_ROLE_CHANGED: {
      const p = data as CommunityMemberRoleChangedPayload;
      await pushToUser({
        userId: p.targetUserId,
        title: "Your role changed",
        body: `Your role is now ${p.newRole}.`,
        ...base(type, p.communityId, p.actorId, {
          oldRole: p.oldRole,
          newRole: p.newRole,
        }),
      });
      break;
    }

    case CommunityEvents.MEMBER_KICKED: {
      const p = data as CommunityMemberKickedPayload;
      await pushToUser({
        userId: p.targetUserId,
        title: "Removed from community",
        body: "You were removed from a community.",
        ...base(type, p.communityId, p.actorId, {
          reason: p.reason ?? "",
        }),
      });
      break;
    }

    case CommunityEvents.MEMBER_BANNED: {
      const p = data as CommunityMemberBannedPayload;
      await pushToUser({
        userId: p.targetUserId,
        title: "Banned from community",
        body: "You were banned from a community.",
        ...base(type, p.communityId, p.actorId, {
          reason: p.reason ?? "",
        }),
      });
      break;
    }

    case CommunityEvents.MEMBER_MUTED: {
      const p = data as CommunityMemberMutedPayload;
      await pushToUser({
        userId: p.targetUserId,
        title: "You have been muted",
        body: p.mutedUntil
          ? "You were muted in a community for a limited time."
          : "You were muted in a community.",
        ...base(type, p.communityId, p.actorId, {
          reason: p.reason ?? "",
          mutedUntil: p.mutedUntil ?? "",
        }),
      });
      break;
    }

    case CommunityEvents.MEMBER_UNMUTED: {
      const p = data as CommunityMemberUnmutedPayload;
      await pushToUser({
        userId: p.targetUserId,
        title: "You have been unmuted",
        body: "You can post in the community again.",
        ...base(type, p.communityId, p.actorId, {}),
      });
      break;
    }

    case CommunityEvents.MEMBER_WARNED: {
      const p = data as CommunityMemberWarnedPayload;
      await pushToUser({
        userId: p.targetUserId,
        title: "You received a warning",
        body: p.note || "A moderator issued you a warning in a community.",
        ...base(type, p.communityId, p.actorId, { note: p.note }),
      });
      break;
    }

    case CommunityEvents.MEMBER_LEFT:
      // Self-action — the user voluntarily left; they already know. Explicit
      // no-op (not `default`) so it does not log "Unknown community event type".
      break;

    case CommunityEvents.INVITE_SENT: {
      const p = data as CommunityInviteSentPayload;
      await pushToUser({
        userId: p.inviteeId,
        title: "Community invite",
        body: "You were invited to join a community.",
        ...base(type, p.communityId, p.inviterId, {
          inviteId: p.inviteId,
          inviterId: p.inviterId,
        }),
      });
      break;
    }

    case CommunityEvents.INVITE_ACCEPTED: {
      const p = data as CommunityInviteAcceptedPayload;
      // Notify the original inviter that their invite was accepted.
      await pushToUser({
        userId: p.inviterId,
        title: "Invite accepted",
        body: "Your community invite was accepted.",
        ...base(type, p.communityId, p.userId, {
          inviteId: p.inviteId,
          acceptedById: p.userId,
        }),
      });
      break;
    }

    case CommunityEvents.REPORT_CREATED: {
      const p = data as CommunityReportCreatedPayload;
      const recipients = p.moderatorRecipientIds;
      await pushToUsers(recipients, (userId) => ({
        userId,
        title: "New community report",
        body: "A new report needs review.",
        ...base(type, p.communityId, p.reporterId, {
          reportId: p.reportId,
          reporterId: p.reporterId,
          targetUserId: p.targetUserId ?? "",
        }),
      }));
      break;
    }

    case CommunityEvents.REPORT_ACTIONED: {
      const p = data as CommunityReportActionedPayload;
      await pushToUser({
        userId: p.reporterId,
        title: "Report reviewed",
        body: "Your report was reviewed by a moderator.",
        ...base(type, p.communityId, p.actorId, {
          reportId: p.reportId,
          targetUserId: p.targetUserId ?? "",
        }),
      });
      break;
    }

    case CommunityEvents.DELETED: {
      const p = data as CommunityDeletedPayload;
      await pushToUsers(p.memberIds, (userId) => ({
        userId,
        title: "Community deleted",
        body: "A community you were in was deleted.",
        ...base(type, p.communityId, p.actorId, { reason: p.reason }),
      }));
      break;
    }

    case CommunityEvents.JOINED:
      // Self-join — the user already knows; no notification.
      break;

    default:
      logger.warn(`Unknown community event type: ${type}`);
  }
}

export async function startCommunityConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  // community-service publishes to a plain durable queue (NOT an exchange).
  await channel.assertQueue(COMMUNITY_QUEUE, { durable: true });
  await channel.prefetch(10);

  logger.info("Community notification consumer started");

  void channel.consume(COMMUNITY_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: unknown;
        };
        await handleCommunityEvent(parsed.type, parsed.data);
        channel.ack(message);
      } catch (error) {
        // Deterministic/parse error → drop (no requeue) so it DLQs rather than
        // spinning forever.
        logger.error("Community consumer failed to process message", error);
        channel.nack(message, false, false);
      }
    })();
  });
}
