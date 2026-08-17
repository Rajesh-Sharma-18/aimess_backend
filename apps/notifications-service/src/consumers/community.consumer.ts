import { logger } from "@aimess/logger";
import { publishUserSocketEvent } from "@aimess/redis";
import amqp from "amqplib";
import {
  CommunityEvents,
  type CommunityAdminTransferredPayload,
  type CommunityClosedNotifyPayload,
  type CommunityDeletedPayload,
  type CommunityInviteAcceptedPayload,
  type CommunityInviteSentPayload,
  type CommunityJoinRequestApprovedPayload,
  type CommunityJoinRequestCancelledPayload,
  type CommunityJoinRequestedPayload,
  type CommunityJoinRequestRejectedPayload,
  type CommunityLivestreamStartedPayload,
  type CommunityLivestreamEndedPayload,
  type CommunityMemberAddedPayload,
  type CommunityMemberBannedPayload,
  type CommunityMemberJoinedPayload,
  type CommunityMemberKickedPayload,
  type CommunityMemberMutedPayload,
  type CommunityMemberRoleChangedPayload,
  type CommunityMemberUnbannedNotifyPayload,
  type CommunityMemberUnmutedPayload,
  type CommunityMemberWarnedPayload,
  type CommunityReopenedNotifyPayload,
  type CommunityReportActionedPayload,
  type CommunityReportCreatedPayload,
  type CommunityReportResolvedPayload,
  type NotificationNavigation,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { communityClient } from "../grpc/community.client.js";
import { buildDeepLink } from "../lib/deep-link.js";
import { communityCopy } from "../lib/notification-copy.js";
import { generateEventThreadId } from "../lib/thread-id.js";
import { redis } from "../config/redis.js";
import {
  pushToUser,
  pushToUsers,
  type PushInput,
} from "../services/push.service.js";

const COMMUNITY_QUEUE = "community.queue";

/**
 * community.* notification scaffold. Defaults to the communityEnabled category;
 * livestream events pass "liveStreamEnabled" so they honor the dedicated
 * per-user livestream notification toggle.
 */
function base(
  type: string,
  communityId: string,
  actorId: string | undefined,
  extra: Record<string, string>,
  deepLink?: string,
  category: PushInput["category"] = "communityEnabled",
  nav?: Omit<NotificationNavigation, "communityId">,
  apnsThreadId?: string
): Pick<
  PushInput,
  "category" | "type" | "actorId" | "deepLink" | "data" | "apnsThreadId"
> {
  // Every notification carries a navigation object — it is what the client
  // routes on. Community identity is folded in from `extra` so a call site
  // never has to repeat it.
  const navigation: NotificationNavigation = {
    screen: "COMMUNITY_DETAILS",
    ...nav,
    communityId,
    communityName: nav?.communityName ?? extra.communityName,
    communityHandle: nav?.communityHandle ?? extra.communityHandle,
    communityAvatarUrl: nav?.communityAvatarUrl ?? extra.communityAvatarUrl,
  };
  return {
    category,
    type,
    actorId,
    deepLink,
    apnsThreadId,
    data: {
      communityId,
      type,
      deepLink: deepLink ?? "",
      ...extra,
      navigation: JSON.stringify(navigation),
    },
  };
}

/**
 * The community name the copy must show. Moderation, invite, report and
 * lifecycle payloads never carried `communityName`, so every one of their pushes
 * rendered the `NOTIF_UNNAMED_COMMUNITY` placeholder ("Your community") as its
 * TITLE — read by users as a real community name. Fall back to the authoritative
 * Community record (community-service owns it) instead of to a placeholder.
 *
 * Returns "" only when the community genuinely cannot be resolved (deleted, or a
 * community-service outage); the copy layer then still renders its generic line
 * rather than a fabricated name, and the failure is logged.
 */
async function communityNameFor(
  communityId: string,
  carried?: string | null
): Promise<string> {
  // Payload-carried names are captured at emit time — current by definition, and
  // one fewer round-trip. Only the gap-filling lookup costs an RPC.
  const fromPayload = carried?.trim();
  if (fromPayload) return fromPayload;

  const brief = await communityClient.getCommunityBrief(communityId);
  const resolved = brief?.name?.trim();
  if (!resolved) {
    logger.warn("Community name unresolved for notification", {
      communityId,
      resolutionFailed: true,
    });
    return "";
  }
  return resolved;
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
      const actorSnapshot = {
        userId: p.userId,
        displayName: p.requesterDisplayName,
        avatarUrl: p.requesterAvatarUrl,
      };
      await pushToUsers(p.moderatorRecipientIds, (userId) => ({
        userId,
        copy: communityCopy.joinRequested(
          p.communityName,
          p.requesterDisplayName
        ),
        ...base(
          type,
          p.communityId,
          p.userId,
          {
            requestId: p.requestId,
            requesterId: p.userId,
            communityName: p.communityName,
            communityHandle: p.communityHandle,
            communityAvatarUrl: p.communityAvatarUrl ?? "",
            requesterDisplayName: p.requesterDisplayName,
            requesterAvatarUrl: p.requesterAvatarUrl ?? "",
            actorSnapshot: JSON.stringify(actorSnapshot),
          },
          buildDeepLink("community", p.communityId),
          "communityEnabled",
          {
            screen: "COMMUNITY_REQUESTS",
            requestId: p.requestId,
            userId: p.userId,
          },
          generateEventThreadId(type)
        ),
      }));
      break;
    }

    case CommunityEvents.LIVESTREAM_STARTED: {
      const p = data as CommunityLivestreamStartedPayload;
      if (!p.recipientIds?.length) break;
      const hostName = p.hostDisplayName || "Someone";
      const actorSnapshot = {
        userId: p.hostUserId,
        displayName: p.hostDisplayName,
        avatarUrl: p.hostAvatarUrl,
      };
      await pushToUsers(p.recipientIds, (userId) => ({
        userId,
        copy: communityCopy.livestreamStarted(p.communityName, hostName),
        ...base(
          type,
          p.communityId,
          p.hostUserId,
          {
            livestreamId: p.livestreamId,
            hostUserId: p.hostUserId,
            hostName,
            hostAvatarUrl: p.hostAvatarUrl ?? "",
            communityName: p.communityName,
            communityHandle: p.communityHandle ?? "",
            communityAvatarUrl: p.communityAvatarUrl ?? "",
            actorSnapshot: JSON.stringify(actorSnapshot),
          },
          // The community, not the stream: `aimess://stream/<id>` carries no community
          // context, so any client falling back to the deep link (web did) had nothing to
          // open the stream *in*. `livestreamId` still rides in navigation + data.
          buildDeepLink("community", p.communityId),
          "liveStreamEnabled",
          {
            screen: "COMMUNITY_LIVESTREAM",
            livestreamId: p.livestreamId,
          },
          generateEventThreadId(type)
        ),
      }));
      break;
    }

    case CommunityEvents.LIVESTREAM_ENDED: {
      const p = data as CommunityLivestreamEndedPayload;
      if (!p.recipientIds?.length) break;
      const hostName = p.hostDisplayName || "Someone";
      const actorSnapshot = {
        userId: p.hostUserId,
        displayName: p.hostDisplayName,
        avatarUrl: p.hostAvatarUrl,
      };
      await pushToUsers(p.recipientIds, (userId) => ({
        userId,
        copy: communityCopy.livestreamEnded(
          p.communityName,
          hostName,
          p.duration
        ),
        ...base(
          type,
          p.communityId,
          p.hostUserId,
          {
            livestreamId: p.livestreamId,
            hostUserId: p.hostUserId,
            hostName,
            hostAvatarUrl: p.hostAvatarUrl ?? "",
            duration: p.duration ?? "",
            durationSeconds: String(p.durationSeconds ?? 0),
            communityName: p.communityName,
            communityHandle: p.communityHandle ?? "",
            communityAvatarUrl: p.communityAvatarUrl ?? "",
            actorSnapshot: JSON.stringify(actorSnapshot),
          },
          buildDeepLink("community", p.communityId),
          "liveStreamEnabled",
          {
            screen: "COMMUNITY_LIVESTREAM",
            livestreamId: p.livestreamId,
          },
          generateEventThreadId(type)
        ),
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
        copy: communityCopy.joinRequestApproved(
          p.communityName,
          p.decidedBy.displayName
        ),
        ...base(
          type,
          p.communityId,
          p.decidedBy.userId,
          {
            requestId: p.requestId,
            status: "APPROVED",
            communityName: p.communityName,
            communityHandle: p.communityHandle,
            communityAvatarUrl: p.communityAvatarUrl ?? "",
            decidedByDisplayName: p.decidedBy.displayName,
            actorSnapshot: JSON.stringify(actorSnapshot),
          },
          buildDeepLink("community", p.communityId),
          "communityEnabled",
          navigation,
          generateEventThreadId(type)
        ),
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
        copy: communityCopy.joinRequestRejected(p.communityName),
        ...base(
          type,
          p.communityId,
          p.decidedBy.userId,
          {
            requestId: p.requestId,
            status: "REJECTED",
            communityName: p.communityName,
            communityHandle: p.communityHandle,
            communityAvatarUrl: p.communityAvatarUrl ?? "",
            decidedByDisplayName: p.decidedBy.displayName,
            actorSnapshot: JSON.stringify(actorSnapshot),
          },
          buildDeepLink("communities"),
          "communityEnabled",
          navigation,
          generateEventThreadId(type)
        ),
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

    case CommunityEvents.JOIN_REQUEST_CANCELLED: {
      const p = data as CommunityJoinRequestCancelledPayload;
      const navigation: NotificationNavigation = {
        screen: "COMMUNITY_DETAILS",
        communityId: p.communityId,
        communityName: p.communityName,
        communityAvatarUrl: p.communityAvatarUrl,
        communityHandle: p.communityHandle,
        requestId: p.requestId,
      };
      // No push notification — the user cancelled deliberately on another device.
      // Only sync the socket state so other sessions flip back to "Join".
      await publishUserSocketEvent(
        redis,
        p.userId,
        "community:join_request:update",
        {
          communityId: p.communityId,
          requestId: p.requestId,
          status: "CANCELLED",
          communityName: p.communityName,
          decidedAt: p.cancelledAt,
          navigation,
        }
      ).catch((e) => logger.error(e));
      break;
    }

    case CommunityEvents.MEMBER_JOINED: {
      const p = data as CommunityMemberJoinedPayload;
      // No push — the user joined deliberately on this device; they already
      // see the result. Only sync the socket state.
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
      const communityName = await communityNameFor(
        p.communityId,
        p.communityName
      );
      // Welcome the joiner — UNLESS they will get the dedicated "approved" or
      // "self_join" (MEMBER_JOINED) notification.
      if (p.via !== "join_request_approved" && p.via !== "self_join") {
        await pushToUser({
          userId: p.targetUserId,
          copy: communityCopy.memberAdded(communityName),
          ...base(
            type,
            p.communityId,
            p.actorId,
            {
              via: p.via,
              ...(communityName ? { communityName } : {}),
              ...(p.requestId ? { requestId: p.requestId } : {}),
            },
            buildDeepLink("community", p.communityId),
            "communityEnabled",
            { screen: "COMMUNITY_DETAILS", requestId: p.requestId },
            generateEventThreadId(type)
          ),
        });
      }
      // Admin/moderator awareness: a member joined.
      const mods = (p.moderatorRecipientIds ?? []).filter(
        (id) => id !== p.actorId && id !== p.targetUserId
      );
      if (mods.length > 0) {
        await pushToUsers(mods, (userId) => ({
          userId,
          copy: communityCopy.memberAddedForModerators(communityName),
          ...base(
            type,
            p.communityId,
            p.actorId,
            {
              via: p.via,
              joinedUserId: p.targetUserId,
              ...(communityName ? { communityName } : {}),
            },
            buildDeepLink("community", p.communityId),
            "communityEnabled",
            { screen: "COMMUNITY_MEMBERS", userId: p.targetUserId },
            generateEventThreadId(type)
          ),
        }));
      }
      break;
    }

    case CommunityEvents.ADMIN_TRANSFERRED: {
      const p = data as CommunityAdminTransferredPayload;
      const communityName = await communityNameFor(p.communityId);
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.adminTransferred(communityName),
        ...base(
          type,
          p.communityId,
          p.actorId,
          { reason: p.reason, communityName },
          buildDeepLink("community", p.communityId),
          "communityEnabled",
          { screen: "COMMUNITY_DETAILS" },
          generateEventThreadId(type)
        ),
      });
      break;
    }

    case CommunityEvents.MEMBER_ROLE_CHANGED: {
      const p = data as CommunityMemberRoleChangedPayload;
      const communityName = await communityNameFor(p.communityId);
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.roleChanged(p.newRole, communityName),
        ...base(
          type,
          p.communityId,
          p.actorId,
          {
            oldRole: p.oldRole,
            newRole: p.newRole,
            communityName,
          },
          buildDeepLink("community", p.communityId),
          "communityEnabled",
          { screen: "COMMUNITY_DETAILS" },
          generateEventThreadId(type)
        ),
      });
      break;
    }

    case CommunityEvents.MEMBER_KICKED: {
      const p = data as CommunityMemberKickedPayload;
      const communityName = await communityNameFor(p.communityId);
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.memberKicked(communityName),
        bypassSettings: true,
        ...base(
          type,
          p.communityId,
          p.actorId,
          {
            reason: p.reason ?? "",
            communityName,
          },
          buildDeepLink("communities"),
          "communityEnabled",
          { screen: "COMMUNITY_DETAILS", userId: p.targetUserId },
          generateEventThreadId(type)
        ),
      });
      break;
    }

    case CommunityEvents.MEMBER_BANNED: {
      const p = data as CommunityMemberBannedPayload;
      const communityName = await communityNameFor(
        p.communityId,
        p.communityName
      );
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.memberBanned(communityName),
        bypassSettings: true,
        ...base(
          type,
          p.communityId,
          p.actorId,
          {
            reason: p.reason ?? "",
            communityName,
            communityAvatarUrl: p.communityAvatarUrl ?? "",
          },
          buildDeepLink("communities"),
          "communityEnabled",
          { screen: "COMMUNITY_DETAILS", userId: p.targetUserId },
          generateEventThreadId(type)
        ),
      });
      break;
    }

    case CommunityEvents.MEMBER_UNBANNED: {
      const p = data as CommunityMemberUnbannedNotifyPayload;
      const communityName = await communityNameFor(
        p.communityId,
        p.communityName
      );
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.memberUnbanned(communityName),
        ...base(
          type,
          p.communityId,
          p.actorId,
          {
            communityName,
            communityAvatarUrl: p.communityAvatarUrl ?? "",
          },
          buildDeepLink("communities"),
          "communityEnabled",
          { screen: "COMMUNITY_DETAILS", userId: p.targetUserId },
          generateEventThreadId(type)
        ),
      });
      break;
    }

    case CommunityEvents.MEMBER_MUTED: {
      const p = data as CommunityMemberMutedPayload;
      const communityName = await communityNameFor(p.communityId);
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.memberMuted(p.mutedUntil, communityName),
        ...base(
          type,
          p.communityId,
          p.actorId,
          {
            reason: p.reason ?? "",
            mutedUntil: p.mutedUntil ?? "",
            communityName,
          },
          buildDeepLink("community", p.communityId),
          "communityEnabled",
          { screen: "COMMUNITY_DETAILS", userId: p.targetUserId },
          generateEventThreadId(type)
        ),
      });
      break;
    }

    case CommunityEvents.MEMBER_UNMUTED: {
      const p = data as CommunityMemberUnmutedPayload;
      const communityName = await communityNameFor(p.communityId);
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.memberUnmuted(communityName),
        ...base(
          type,
          p.communityId,
          p.actorId,
          { communityName },
          buildDeepLink("community", p.communityId),
          "communityEnabled",
          { screen: "COMMUNITY_DETAILS", userId: p.targetUserId },
          generateEventThreadId(type)
        ),
      });
      break;
    }

    case CommunityEvents.MEMBER_WARNED: {
      const p = data as CommunityMemberWarnedPayload;
      const communityName = await communityNameFor(p.communityId);
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.memberWarned(p.note, communityName),
        ...base(
          type,
          p.communityId,
          p.actorId,
          { note: p.note, communityName },
          buildDeepLink("community", p.communityId),
          "communityEnabled",
          { screen: "COMMUNITY_DETAILS", userId: p.targetUserId },
          generateEventThreadId(type)
        ),
      });
      break;
    }

    case CommunityEvents.MEMBER_LEFT:
      // Self-action — the user voluntarily left; they already know. Explicit
      // no-op (not `default`) so it does not log "Unknown community event type".
      break;

    case CommunityEvents.INVITE_SENT: {
      const p = data as CommunityInviteSentPayload;
      const communityName = await communityNameFor(p.communityId);
      await pushToUser({
        userId: p.inviteeId,
        copy: communityCopy.inviteSent(communityName),
        ...base(
          type,
          p.communityId,
          p.inviterId,
          {
            inviteId: p.inviteId,
            inviterId: p.inviterId,
            communityName,
          },
          buildDeepLink("community", p.communityId),
          "communityEnabled",
          { screen: "COMMUNITY_INVITE", inviteId: p.inviteId },
          generateEventThreadId(type)
        ),
      });
      break;
    }

    case CommunityEvents.INVITE_ACCEPTED: {
      const p = data as CommunityInviteAcceptedPayload;
      const communityName = await communityNameFor(p.communityId);
      // Notify the original inviter that their invite was accepted.
      await pushToUser({
        userId: p.inviterId,
        copy: communityCopy.inviteAccepted(communityName),
        ...base(
          type,
          p.communityId,
          p.userId,
          {
            inviteId: p.inviteId,
            acceptedById: p.userId,
            communityName,
          },
          buildDeepLink("community", p.communityId),
          "communityEnabled",
          {
            screen: "COMMUNITY_INVITE",
            inviteId: p.inviteId,
            userId: p.userId,
          },
          generateEventThreadId(type)
        ),
      });
      break;
    }

    case CommunityEvents.REPORT_CREATED: {
      const p = data as CommunityReportCreatedPayload;
      // The reporter is often an admin/moderator themselves — they filed the
      // report, so "a new report needs review" back at them is noise.
      const recipients = (p.moderatorRecipientIds ?? []).filter(
        (id) => id !== p.reporterId
      );
      if (recipients.length === 0) break;
      const communityName = await communityNameFor(
        p.communityId,
        p.communityName
      );
      await pushToUsers(recipients, (userId) => ({
        userId,
        copy: communityCopy.reportCreated(communityName),
        ...base(
          type,
          p.communityId,
          p.reporterId,
          {
            reportId: p.reportId,
            reporterId: p.reporterId,
            targetUserId: p.targetUserId ?? "",
            communityName,
            communityAvatarUrl: p.communityAvatarUrl ?? "",
          },
          buildDeepLink("community", p.communityId),
          "communityEnabled",
          {
            screen: "COMMUNITY_REPORTS",
            reportId: p.reportId,
            ...(p.targetUserId ? { userId: p.targetUserId } : {}),
          },
          generateEventThreadId(type)
        ),
      }));
      break;
    }

    case CommunityEvents.REPORT_ACTIONED: {
      const p = data as CommunityReportActionedPayload;
      const communityName = await communityNameFor(p.communityId);
      await pushToUser({
        userId: p.reporterId,
        copy: communityCopy.reportActioned(communityName),
        ...base(
          type,
          p.communityId,
          p.actorId,
          {
            reportId: p.reportId,
            targetUserId: p.targetUserId ?? "",
            communityName,
          },
          buildDeepLink("community", p.communityId),
          "communityEnabled",
          {
            screen: "COMMUNITY_REPORTS",
            reportId: p.reportId,
            ...(p.targetUserId ? { userId: p.targetUserId } : {}),
          },
          generateEventThreadId(type)
        ),
      });
      break;
    }

    case CommunityEvents.REPORT_RESOLVED: {
      const p = data as CommunityReportResolvedPayload;
      const communityName = await communityNameFor(p.communityId);
      await pushToUser({
        userId: p.reporterId,
        copy: communityCopy.reportResolved(communityName),
        ...base(
          type,
          p.communityId,
          p.actorId,
          {
            reportId: p.reportId,
            targetUserId: p.targetUserId ?? "",
            resolution: p.resolution,
            communityName,
          },
          buildDeepLink("community", p.communityId),
          "communityEnabled",
          {
            screen: "COMMUNITY_REPORTS",
            reportId: p.reportId,
            ...(p.targetUserId ? { userId: p.targetUserId } : {}),
          },
          generateEventThreadId(type)
        ),
      });
      break;
    }

    case CommunityEvents.DELETED: {
      const p = data as CommunityDeletedPayload;
      // Deletion is soft — community-service still returns the row, so the push
      // can name what was deleted instead of "Your community was deleted".
      const communityName = await communityNameFor(p.communityId);
      await pushToUsers(p.memberIds, (userId) => ({
        userId,
        copy: communityCopy.deleted(communityName),
        bypassSettings: true,
        ...base(
          type,
          p.communityId,
          p.actorId,
          { reason: p.reason, communityName },
          buildDeepLink("communities"),
          "communityEnabled",
          { screen: "COMMUNITY_LIST" },
          generateEventThreadId(type)
        ),
      }));
      break;
    }

    case CommunityEvents.CLOSED: {
      const p = data as CommunityClosedNotifyPayload;
      const communityName = await communityNameFor(p.communityId);
      await pushToUsers(p.memberIds, (userId) => ({
        userId,
        copy: communityCopy.closed(communityName),
        ...base(
          type,
          p.communityId,
          p.actorId,
          { reason: p.reason ?? "", communityName },
          buildDeepLink("communities"),
          "communityEnabled",
          { screen: "COMMUNITY_LIST" },
          generateEventThreadId(type)
        ),
      }));
      break;
    }

    case CommunityEvents.REOPENED: {
      // Members are never evicted on close, so `memberIds` is the same full
      // roster the CLOSED push reached — notify all of them, mirroring CLOSED.
      const p = data as CommunityReopenedNotifyPayload;
      const communityName = await communityNameFor(
        p.communityId,
        p.communityName
      );
      await pushToUsers(p.memberIds, (userId) => ({
        userId,
        copy: communityCopy.reopened(communityName),
        ...base(
          type,
          p.communityId,
          p.actorId,
          {
            communityName,
          },
          buildDeepLink("community", p.communityId),
          "communityEnabled",
          { screen: "COMMUNITY_DETAILS" },
          generateEventThreadId(type)
        ),
      }));
      break;
    }

    case CommunityEvents.INVITE_LINK_SHARED:
      // chat-service owns this one — it lands as a system DM, not a push.
      break;

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
