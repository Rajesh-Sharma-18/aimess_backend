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
  identity: CommunityIdentity,
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
  const { communityId, name: communityName, avatarUrl } = identity;
  // Every notification carries a navigation object — it is what the client
  // routes on. Community identity is folded in here so a call site never has to
  // repeat it, and so the name and the image can never come from two different
  // sources (they are two halves of one resolved record).
  const navigation: NotificationNavigation = {
    screen: "COMMUNITY_DETAILS",
    ...nav,
    communityId,
    communityName: nav?.communityName ?? communityName,
    communityHandle: nav?.communityHandle ?? extra.communityHandle,
    communityAvatarUrl: nav?.communityAvatarUrl ?? avatarUrl,
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
      ...(communityName ? { communityName } : {}),
      // The COMMUNITY's own image — promoted to the FCM/APNs tray image by
      // push.service. Omitted (not ""), so a community with no avatar produces
      // no image field at all rather than an empty/broken one.
      ...(avatarUrl ? { communityAvatarUrl: avatarUrl } : {}),
      ...extra,
      navigation: JSON.stringify(navigation),
    },
  };
}

/** Name + avatar of ONE community, resolved together from ONE record. */
interface CommunityIdentity {
  communityId: string;
  name: string;
  /** Fully-qualified avatar URL; "" when the community has none. */
  avatarUrl: string;
}

/**
 * The community identity every push in this consumer renders: the name in the
 * title/copy and the avatar in the tray image.
 *
 * Moderation, invite, report and lifecycle payloads never carried
 * `communityName`, so their pushes rendered the `NOTIF_UNNAMED_COMMUNITY`
 * placeholder ("Your community") as a TITLE; the same payloads carry no avatar
 * either, so their pushes fell back to the app logo. Both halves are therefore
 * resolved HERE, from the authoritative Community record (community-service
 * owns it), with the emit-time payload values used only when the record cannot
 * be reached.
 *
 * Authoritative-first, not payload-first: it is what makes a renamed or
 * re-imaged community show its CURRENT name and CURRENT picture, and — because
 * both fields come from the same fetched row — what guarantees the title and
 * the image always describe the same version of the same entity. One RPC per
 * event (these are low-frequency lifecycle events, NOT per-message), fanned out
 * to every recipient of that event.
 */
async function communityIdentityFor(
  communityId: string,
  carriedName?: string | null,
  carriedAvatarUrl?: string | null
): Promise<CommunityIdentity> {
  const brief = await communityClient.getCommunityBrief(communityId);
  if (brief) {
    return {
      communityId,
      name: brief.name?.trim() || carriedName?.trim() || "",
      avatarUrl: brief.avatarUrl?.trim() || carriedAvatarUrl?.trim() || "",
    };
  }

  // Fail-open (breaker fallback / deleted community): keep whatever the event
  // captured at emit time rather than dropping the push. "" leaves the copy
  // layer to render its generic line instead of a fabricated name.
  const name = carriedName?.trim() ?? "";
  if (!name) {
    logger.warn("Community name unresolved for notification", {
      communityId,
      resolutionFailed: true,
    });
  }
  return { communityId, name, avatarUrl: carriedAvatarUrl?.trim() ?? "" };
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
      const identity = await communityIdentityFor(
        p.communityId,
        p.communityName,
        p.communityAvatarUrl
      );
      const actorSnapshot = {
        userId: p.userId,
        displayName: p.requesterDisplayName,
        avatarUrl: p.requesterAvatarUrl,
      };
      await pushToUsers(p.moderatorRecipientIds, (userId) => ({
        userId,
        copy: communityCopy.joinRequested(
          identity.name,
          p.requesterDisplayName
        ),
        ...base(
          type,
          identity,
          p.userId,
          {
            requestId: p.requestId,
            requesterId: p.userId,
            communityHandle: p.communityHandle,
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
      const identity = await communityIdentityFor(
        p.communityId,
        p.communityName,
        p.communityAvatarUrl
      );
      const hostName = p.hostDisplayName || "Someone";
      const actorSnapshot = {
        userId: p.hostUserId,
        displayName: p.hostDisplayName,
        avatarUrl: p.hostAvatarUrl,
      };
      await pushToUsers(p.recipientIds, (userId) => ({
        userId,
        copy: communityCopy.livestreamStarted(identity.name, hostName),
        ...base(
          type,
          identity,
          p.hostUserId,
          {
            livestreamId: p.livestreamId,
            hostUserId: p.hostUserId,
            hostName,
            hostAvatarUrl: p.hostAvatarUrl ?? "",
            communityHandle: p.communityHandle ?? "",
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
      const identity = await communityIdentityFor(
        p.communityId,
        p.communityName,
        p.communityAvatarUrl
      );
      const hostName = p.hostDisplayName || "Someone";
      const actorSnapshot = {
        userId: p.hostUserId,
        displayName: p.hostDisplayName,
        avatarUrl: p.hostAvatarUrl,
      };
      await pushToUsers(p.recipientIds, (userId) => ({
        userId,
        copy: communityCopy.livestreamEnded(
          identity.name,
          hostName,
          p.duration
        ),
        ...base(
          type,
          identity,
          p.hostUserId,
          {
            livestreamId: p.livestreamId,
            hostUserId: p.hostUserId,
            hostName,
            hostAvatarUrl: p.hostAvatarUrl ?? "",
            duration: p.duration ?? "",
            durationSeconds: String(p.durationSeconds ?? 0),
            communityHandle: p.communityHandle ?? "",
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
      const identity = await communityIdentityFor(
        p.communityId,
        p.communityName,
        p.communityAvatarUrl
      );
      const navigation: NotificationNavigation = {
        screen: "COMMUNITY_DETAILS",
        communityId: p.communityId,
        communityName: identity.name,
        communityAvatarUrl: identity.avatarUrl,
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
          identity.name,
          p.decidedBy.displayName
        ),
        ...base(
          type,
          identity,
          p.decidedBy.userId,
          {
            requestId: p.requestId,
            status: "APPROVED",
            communityHandle: p.communityHandle,
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
          communityName: identity.name,
          decidedAt: p.decidedAt,
          navigation,
        }
      ).catch((e) => logger.error(e));
      break;
    }

    case CommunityEvents.JOIN_REQUEST_REJECTED: {
      const p = data as CommunityJoinRequestRejectedPayload;
      const identity = await communityIdentityFor(
        p.communityId,
        p.communityName,
        p.communityAvatarUrl
      );
      const navigation: NotificationNavigation = {
        screen: "COMMUNITY_DETAILS",
        communityId: p.communityId,
        communityName: identity.name,
        communityAvatarUrl: identity.avatarUrl,
        communityHandle: p.communityHandle,
        requestId: p.requestId,
      };
      const actorSnapshot = {
        userId: p.decidedBy.userId,
        displayName: p.decidedBy.displayName,
      };
      await pushToUser({
        userId: p.userId,
        copy: communityCopy.joinRequestRejected(identity.name),
        ...base(
          type,
          identity,
          p.decidedBy.userId,
          {
            requestId: p.requestId,
            status: "REJECTED",
            communityHandle: p.communityHandle,
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
          communityName: identity.name,
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
      const identity = await communityIdentityFor(
        p.communityId,
        p.communityName
      );
      const communityName = identity.name;
      // Welcome the joiner — UNLESS they will get the dedicated "approved" or
      // "self_join" (MEMBER_JOINED) notification.
      if (p.via !== "join_request_approved" && p.via !== "self_join") {
        await pushToUser({
          userId: p.targetUserId,
          copy: communityCopy.memberAdded(communityName),
          ...base(
            type,
            identity,
            p.actorId,
            {
              via: p.via,
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
            identity,
            p.actorId,
            {
              via: p.via,
              joinedUserId: p.targetUserId,
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
      const identity = await communityIdentityFor(p.communityId);
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.adminTransferred(identity.name),
        ...base(
          type,
          identity,
          p.actorId,
          { reason: p.reason },
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
      const identity = await communityIdentityFor(p.communityId);
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.roleChanged(p.newRole, identity.name),
        ...base(
          type,
          identity,
          p.actorId,
          {
            oldRole: p.oldRole,
            newRole: p.newRole,
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
      const identity = await communityIdentityFor(p.communityId);
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.memberKicked(identity.name),
        bypassSettings: true,
        ...base(
          type,
          identity,
          p.actorId,
          {
            reason: p.reason ?? "",
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
      const identity = await communityIdentityFor(
        p.communityId,
        p.communityName,
        p.communityAvatarUrl
      );
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.memberBanned(identity.name),
        bypassSettings: true,
        ...base(
          type,
          identity,
          p.actorId,
          {
            reason: p.reason ?? "",
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
      const identity = await communityIdentityFor(
        p.communityId,
        p.communityName,
        p.communityAvatarUrl
      );
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.memberUnbanned(identity.name),
        ...base(
          type,
          identity,
          p.actorId,
          {},
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
      const identity = await communityIdentityFor(p.communityId);
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.memberMuted(p.mutedUntil, identity.name),
        ...base(
          type,
          identity,
          p.actorId,
          {
            reason: p.reason ?? "",
            mutedUntil: p.mutedUntil ?? "",
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
      const identity = await communityIdentityFor(p.communityId);
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.memberUnmuted(identity.name),
        ...base(
          type,
          identity,
          p.actorId,
          {},
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
      const identity = await communityIdentityFor(p.communityId);
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.memberWarned(p.note, identity.name),
        ...base(
          type,
          identity,
          p.actorId,
          { note: p.note },
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
      const identity = await communityIdentityFor(p.communityId);
      await pushToUser({
        userId: p.inviteeId,
        copy: communityCopy.inviteSent(identity.name),
        ...base(
          type,
          identity,
          p.inviterId,
          {
            inviteId: p.inviteId,
            inviterId: p.inviterId,
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
      const identity = await communityIdentityFor(p.communityId);
      // Notify the original inviter that their invite was accepted.
      await pushToUser({
        userId: p.inviterId,
        copy: communityCopy.inviteAccepted(identity.name),
        ...base(
          type,
          identity,
          p.userId,
          {
            inviteId: p.inviteId,
            acceptedById: p.userId,
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
      const identity = await communityIdentityFor(
        p.communityId,
        p.communityName,
        p.communityAvatarUrl
      );
      await pushToUsers(recipients, (userId) => ({
        userId,
        copy: communityCopy.reportCreated(identity.name),
        ...base(
          type,
          identity,
          p.reporterId,
          {
            reportId: p.reportId,
            reporterId: p.reporterId,
            targetUserId: p.targetUserId ?? "",
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
      const identity = await communityIdentityFor(p.communityId);
      await pushToUser({
        userId: p.reporterId,
        copy: communityCopy.reportActioned(identity.name),
        ...base(
          type,
          identity,
          p.actorId,
          {
            reportId: p.reportId,
            targetUserId: p.targetUserId ?? "",
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
      const identity = await communityIdentityFor(p.communityId);
      await pushToUser({
        userId: p.reporterId,
        copy: communityCopy.reportResolved(identity.name),
        ...base(
          type,
          identity,
          p.actorId,
          {
            reportId: p.reportId,
            targetUserId: p.targetUserId ?? "",
            resolution: p.resolution,
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
      const identity = await communityIdentityFor(p.communityId);
      await pushToUsers(p.memberIds, (userId) => ({
        userId,
        copy: communityCopy.deleted(identity.name),
        bypassSettings: true,
        ...base(
          type,
          identity,
          p.actorId,
          { reason: p.reason },
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
      const identity = await communityIdentityFor(p.communityId);
      await pushToUsers(p.memberIds, (userId) => ({
        userId,
        copy: communityCopy.closed(identity.name),
        ...base(
          type,
          identity,
          p.actorId,
          { reason: p.reason ?? "" },
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
      const identity = await communityIdentityFor(
        p.communityId,
        p.communityName
      );
      await pushToUsers(p.memberIds, (userId) => ({
        userId,
        copy: communityCopy.reopened(identity.name),
        ...base(
          type,
          identity,
          p.actorId,
          {},
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
