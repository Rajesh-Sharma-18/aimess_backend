import { logger } from "@aimess/logger";
import amqp from "amqplib";
import {
  CommunityEvents,
  type CommunityAdminTransferredPayload,
  type CommunityDeletedPayload,
  type CommunityInviteAcceptedPayload,
  type CommunityInviteSentPayload,
  type CommunityJoinRequestedPayload,
  type CommunityMemberAddedPayload,
  type CommunityMemberBannedPayload,
  type CommunityMemberKickedPayload,
  type CommunityMemberRoleChangedPayload,
  type CommunityReportActionedPayload,
  type CommunityReportCreatedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
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
      const recipients = p.moderatorRecipientIds;
      await pushToUsers(recipients, (userId) => ({
        userId,
        title: "New join request",
        body: "Someone requested to join your community.",
        ...base(type, p.communityId, p.userId, {
          requestId: p.requestId,
          requesterId: p.userId,
        }),
      }));
      break;
    }

    case CommunityEvents.MEMBER_ADDED: {
      const p = data as CommunityMemberAddedPayload;
      await pushToUser({
        userId: p.targetUserId,
        title: "Welcome to the community",
        body: "You were added to a community.",
        ...base(type, p.communityId, p.actorId, { via: p.via }),
      });
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
