import { logger } from "@aimess/logger";
import {
  PLATFORM_ADMIN_ACTOR_ID,
  t,
  type SupportedLocale,
} from "@aimess/constants";
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
  type CommunityJoinRequestRetractedPayload,
  type CommunityLivestreamStartedPayload,
  type CommunityLivestreamEndedPayload,
  type CommunityMemberAddedPayload,
  type CommunityMemberBannedPayload,
  type CommunityMemberJoinedPayload,
  type CommunityMemberKickedPayload,
  type CommunityMemberLeftPayload,
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
import { userIdentityClient } from "../grpc/user-identity.client.js";
import { buildDeepLink } from "../lib/deep-link.js";
import { communityCopy } from "../lib/notification-copy.js";
import { generateEventThreadId } from "../lib/thread-id.js";
import { pushTag, roomTags } from "../lib/push-tags.js";
import { redis } from "../config/redis.js";
import { dismissTrayCards } from "../services/push-dismiss.js";
import {
  pushToUser,
  pushToUsers,
  type PushInput,
} from "../services/push.service.js";

const COMMUNITY_QUEUE = "community.queue";

/**
 * community.* notification scaffold. Defaults to the communityEnabled
 * category; livestream events pass "liveStreamEnabled" so they honor the
 * dedicated per-user livestream notification toggle.
 *
 * `communityEnabled` no longer has an account-level switch behind it (see
 * RETIRED_CATEGORIES in notification-settings.service). It is kept as the
 * category value because it is what maps these events onto the community's
 * OWN `announcementEnabled` preference in push.service — that per-community
 * toggle, plus ACTIVE membership and quiet hours, is the whole gate now.
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

/**
 * Recipients minus the ACTOR of the event, compared on the canonical AIMess
 * userId — never a username, email, social-provider subject, device or session,
 * so a host who signed in with Google or Apple is excluded exactly like one who
 * signed in with a password.
 *
 * A livestream host is not a recipient of their own start/end announcement.
 * The producer already resolves the roster without them, but the rule belongs
 * HERE too: this is the layer that creates the inbox row, the `notification:new`
 * frame and the FCM/APNs push, and it is the last authority before all three.
 * Enforcing it here means no payload can put the host back into their own
 * fan-out — a replayed event, a hand-published one, a producer running older
 * code, or the next source that grows livestreams (groups) and resolves its own
 * roster.
 *
 * push.service now also drops any recipient equal to `actorId`; filtering here
 * first just skips the name/identity lookups for a roster of one.
 */
function withoutActor(
  recipientIds: string[] | undefined,
  actorId: string | undefined
): string[] {
  if (!recipientIds?.length) return [];
  if (!actorId) return recipientIds;
  return recipientIds.filter((id) => id !== actorId);
}

/**
 * The room is gone for these users (left, kicked, banned, deleted): close its
 * chat / mention / live / added cards on every device of theirs. The kick/ban/
 * delete card itself is untagged by room, so it stays.
 */
async function dismissRoomCards(
  userIds: string[] | undefined,
  communityId: string,
  reason: "LEFT" | "REMOVED" | "DELETED"
): Promise<void> {
  await Promise.all(
    [...new Set(userIds ?? [])].filter(Boolean).map((userId) =>
      dismissTrayCards({
        userId,
        tags: roomTags(communityId),
        reason,
        data: { communityId, conversationId: communityId },
      })
    )
  );
}

const LIVESTREAM_RETRACTED = "community.livestream_retracted";

const liveEndedKey = (livestreamId: string) =>
  `notif:livestream:ended:${livestreamId}`;

/**
 * The end actor gets no "ended" card about their own action, so the "is live"
 * card they were shown is taken back instead: the inbox row (every session, via
 * `notification:deleted`) and the tray card on every device.
 */
async function retractLiveCard(
  userId: string,
  communityId: string,
  livestreamId: string
): Promise<void> {
  await pushToUser({
    userId,
    category: "liveStreamEnabled",
    type: LIVESTREAM_RETRACTED,
    skipPush: true,
    bypassSettings: true,
    data: { groupKey: `livestream:${livestreamId}`, communityId, livestreamId },
  }).catch((error: unknown) => {
    logger.warn(`[livestream] retract live row failed user=${userId}`);
    logger.warn(error);
  });
  await dismissTrayCards({
    userId,
    tags: [pushTag.live(livestreamId)],
    reason: "LIVESTREAM_ENDED",
    data: { communityId, livestreamId },
  });
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
 * The ACTOR's name every push in this consumer renders ("<name> approved your
 * request…", "<name> asked to join…", "<name> is live…").
 *
 * Authoritative-first, for the same reason as {@link communityIdentityFor}: the
 * name the producer captured at emit time is only as good as the lookup it did
 * then. A transient user-service miss there used to freeze a placeholder
 * ("Unknown") into the event, and this layer rendered it into the tray card,
 * the inbox row and the socket frame alike — for an admin whose real name was
 * one RPC away. Resolving here, by the canonical AIMess userId, gives the name
 * a second chance after the queue hop and keeps it identical for password,
 * Google and Apple accounts (they all have one profile keyed by that id).
 *
 * "" when neither source knows the name, so the copy layer renders its
 * localized "Someone" rather than a fabricated name.
 */
async function actorNameFor(
  userId: string | undefined,
  carriedName?: string | null
): Promise<string> {
  const fresh = userId ? await userIdentityClient.getDisplayName(userId) : null;
  return fresh?.trim() || carriedName?.trim() || "";
}

/**
 * The tray actions an admin gets on an incoming join request, where the
 * platform renders them (web: Notification API `actions`, iOS: the
 * {@link JOIN_REQUEST_CATEGORY} the app registers). A client that renders none
 * of them still opens the request on tap, so this degrades to today's card.
 *
 * A function of the locale, resolved once per DEVICE language inside
 * `pushToUser`. The `action` ids are contract and never move; only the labels
 * are copy — an admin reading Thai must not get English buttons under a Thai
 * sentence, and the tray is the one surface that cannot be re-rendered later.
 */
const joinRequestPushActions = (
  locale: SupportedLocale
): ReadonlyArray<{ action: string; title: string }> => [
  {
    action: "community_join_request_accept",
    title: t("NOTIF_ACTION_ACCEPT", locale),
  },
  {
    action: "community_join_request_reject",
    title: t("NOTIF_ACTION_DECLINE", locale),
  },
];

/** APNs category the iOS app registers its Accept / Decline buttons under. */
const JOIN_REQUEST_CATEGORY = "COMMUNITY_JOIN_REQUEST";

/**
 * One tray card per (community, requester) — the same grain as the inbox card,
 * so a retraction closes exactly the card the request raised, by id rather than
 * by its rendered text.
 */
const joinRequestPushTag = (communityId: string, requesterId: string): string =>
  `community_join_request_${communityId}_${requesterId}`;

/**
 * Take back the admin cards for one requester's join request — the inbox row
 * AND the tray card.
 *
 * Used by both ends of the lifecycle: when an attempt is settled (approved,
 * rejected, cancelled, auto-resolved) and when a NEW attempt supersedes the
 * previous one. `groupKey` is what chat-service matches the row on (see
 * DELETE_ON_ARRIVAL in notification-identity.ts) and it deletes the whole group,
 * so duplicates left by an earlier failure are cleaned up too.
 *
 * Deliberately `dataOnly` rather than `skipPush`: the row still has to be
 * deleted (that is the inbox half), and the silent data push is what lets a
 * service worker close the tray card — nobody wants a visible "the request you
 * already handled is gone" banner. `bypassSettings` because a card must be
 * cleaned up even for an admin who has since muted the community; leaving it
 * would strand a badge they cannot clear.
 */
async function retractJoinRequestCards(
  recipients: string[],
  communityId: string,
  requesterId: string,
  resolution: string,
  requestId?: string,
  /**
   * When the settlement happened. A cancel and the re-request that follows it
   * race each other through different queues, so the retraction says how old a
   * card it is entitled to take back: anything raised later is a NEW attempt
   * and is left alone (see `raisedAtOrBefore` in the notification repository).
   */
  raisedAt?: string
): Promise<void> {
  if (recipients.length === 0) return;
  await pushToUsers(recipients, (userId) => ({
    userId,
    category: "communityEnabled" as const,
    type: CommunityEvents.JOIN_REQUEST_RETRACTED,
    dataOnly: true,
    bypassSettings: true,
    collapseKey: joinRequestPushTag(communityId, requesterId),
    data: {
      groupKey: `community:${communityId}:join_request:${requesterId}`,
      type: CommunityEvents.JOIN_REQUEST_RETRACTED,
      communityId,
      requesterId,
      resolution,
      // The tag the tray card was drawn with, so a worker can close it without
      // reading any rendered text.
      tag: joinRequestPushTag(communityId, requesterId),
      ...(raisedAt ? { staleBefore: raisedAt } : {}),
      ...(requestId ? { requestId, joinRequestId: requestId } : {}),
    },
  }));
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
      // ADMIN-ONLY event. The producer already narrows the roster to the
      // community's current admin(s) (moderators are excluded there, at the
      // source), so this branch must never widen it back to
      // `moderatorRecipientIds`. The requester filter is belt-and-braces: a
      // community admin asking to join their own community is impossible today,
      // but "your own request needs review" would be nonsense if it ever were.
      const recipients = (p.adminRecipientIds ?? []).filter(
        (id) => id !== p.userId
      );
      if (recipients.length === 0) break;
      const [identity, requesterName] = await Promise.all([
        communityIdentityFor(
          p.communityId,
          p.communityName,
          p.communityAvatarUrl
        ),
        actorNameFor(p.userId, p.requesterDisplayName),
      ]);
      const actorSnapshot = {
        userId: p.userId,
        displayName: requesterName,
        avatarUrl: p.requesterAvatarUrl,
      };
      // Clear the previous attempt's card BEFORE writing this one.
      //
      // A join-request card is grouped per (community, requester), so without
      // this the second attempt would transition the first attempt's row in
      // place — same row id, no `notification:new`, no badge — and the admin
      // would simply never see it. Cancelling already retracts, but relying on
      // that would make a lost retraction silence every future attempt by that
      // requester; retracting here makes the new attempt self-sufficient, and
      // leaves exactly one actionable card whichever way the previous one ended.
      await retractJoinRequestCards(recipients, p.communityId, p.userId, "SUPERSEDED");
      await pushToUsers(recipients, (userId) => ({
        userId,
        copy: communityCopy.joinRequested(identity.name, requesterName),
        // Accept / Decline straight from the tray, where the platform renders
        // them. The payload only NAMES the request — every action re-enters the
        // ordinary authenticated endpoint, so a copied or stale push decides
        // nothing by itself.
        actions: joinRequestPushActions,
        apnsCategory: JOIN_REQUEST_CATEGORY,
        // Stable per requester+community, so the retraction above (and the one
        // on cancel/approve/reject) can close the tray card by tag instead of
        // matching on its rendered text.
        collapseKey: joinRequestPushTag(p.communityId, p.userId),
        ...base(
          type,
          identity,
          p.userId,
          {
            requestId: p.requestId,
            // Named as the clients read it, alongside the legacy `requestId`.
            joinRequestId: p.requestId,
            // WHICH attempt this card decides — echoed back by Accept/Reject so
            // a card left over from a cancelled attempt cannot decide the one
            // that replaced it. See CommunityJoinRequestedPayload.lifecycle.
            lifecycle: p.lifecycle ?? "",
            requesterId: p.userId,
            // Tray tag, so a visible web tab draws the worker's card and the retraction closes it.
            tag: joinRequestPushTag(p.communityId, p.userId),
            communityHandle: p.communityHandle,
            requesterDisplayName: requesterName,
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

    case CommunityEvents.JOIN_REQUEST_RETRACTED: {
      const p = data as CommunityJoinRequestRetractedPayload;
      const recipients = p.adminRecipientIds ?? [];
      if (recipients.length === 0) break;
      await retractJoinRequestCards(
        recipients,
        p.communityId,
        p.requesterId,
        p.resolution,
        p.requestId,
        p.eventAt
      );
      break;
    }

    case CommunityEvents.LIVESTREAM_STARTED: {
      const p = data as CommunityLivestreamStartedPayload;
      const recipients = withoutActor(p.recipientIds, p.hostUserId);
      if (recipients.length === 0) break;
      // A start that lands after its own end must not draw an "is live" card.
      if (await redis.get(liveEndedKey(p.livestreamId)).catch(() => null)) {
        logger.info(`[livestream] start after end skipped stream=${p.livestreamId}`);
        break;
      }
      const [identity, resolvedHostName] = await Promise.all([
        communityIdentityFor(
          p.communityId,
          p.communityName,
          p.communityAvatarUrl
        ),
        actorNameFor(p.hostUserId, p.hostDisplayName),
      ]);
      const hostName = resolvedHostName || "Someone";
      const actorSnapshot = {
        userId: p.hostUserId,
        displayName: resolvedHostName,
        avatarUrl: p.hostAvatarUrl,
      };
      await pushToUsers(recipients, (userId) => ({
        userId,
        copy: communityCopy.livestreamStarted(identity.name, resolvedHostName),
        // Shared with LIVESTREAM_ENDED, so "ended" REPLACES the "Watch now" card
        // instead of leaving a tappable card for a stream that is over.
        collapseKey: pushTag.live(p.livestreamId),
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
            // Client push dedup: one start per stream, never one per community.
            idempotencyKey: `live:${p.livestreamId}:started`,
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
      // The actor of the End Live — never pushed about their own action: the
      // community admin on End for Everyone (the host IS told), else the host.
      // A Super Admin end (ADMIN) has no AIMess actor, so the host is told too.
      const endActorId =
        p.endedByUserId ??
        (p.endedReason === "ADMIN" ? undefined : p.hostUserId);
      await redis
        .set(liveEndedKey(p.livestreamId), "1", "EX", 86_400)
        .catch(() => undefined);
      if (p.endedByUserId && p.endedByUserId !== p.hostUserId) {
        await retractLiveCard(p.endedByUserId, p.communityId, p.livestreamId);
      }
      const recipients = withoutActor(p.recipientIds, endActorId);
      if (recipients.length === 0) break;
      const [identity, resolvedHostName, endedByName] = await Promise.all([
        communityIdentityFor(
          p.communityId,
          p.communityName,
          p.communityAvatarUrl
        ),
        actorNameFor(p.hostUserId, p.hostDisplayName),
        p.endedByUserId
          ? actorNameFor(p.endedByUserId, p.endedByDisplayName)
          : Promise.resolve(""),
      ]);
      const hostName = resolvedHostName || "Someone";
      const actorSnapshot = p.endedByUserId
        ? { userId: p.endedByUserId, displayName: endedByName, avatarUrl: null }
        : {
            userId: p.hostUserId,
            displayName: resolvedHostName,
            avatarUrl: p.hostAvatarUrl,
          };
      // A silent end: the "is live" row is rewritten in place (inbox only, never a
      // push, never re-badged) and its tray card is taken back. Both skip quiet
      // hours and the livestream toggle, so no stale "is live" card survives.
      const endedFor = (userId: string): PushInput => ({
        userId,
        skipPush: true,
        bypassSettings: true,
        // A Super Admin end reads "An administrator", a platform end (moderation,
        // bans) "System" — neither names the host; the host still rides in
        // data/actorSnapshot as the stream owner.
        copy:
          p.endedReason === "ADMIN"
            ? communityCopy.livestreamEndedByAdmin(
                identity.name,
                p.duration,
                // The host reads "Administrator ended the livestream …".
                userId === p.hostUserId ? undefined : resolvedHostName
              )
            : p.endedReason === "SYSTEM"
            ? communityCopy.livestreamEndedBySystem(identity.name, p.duration)
            : communityCopy.livestreamEnded(
                identity.name,
                endedByName || resolvedHostName,
                p.duration,
                // "{admin} ended {host}'s livestream" when the admin ended it.
                endedByName ? resolvedHostName : undefined
              ),
        ...base(
          type,
          identity,
          // push.service drops the recipient equal to actorId: this must be the
          // ending actor, not the host, or the host never hears an admin's end.
          endActorId,
          {
            livestreamId: p.livestreamId,
            hostUserId: p.hostUserId,
            hostName,
            hostAvatarUrl: p.hostAvatarUrl ?? "",
            duration: p.duration ?? "",
            durationSeconds: String(p.durationSeconds ?? 0),
            endedReason: p.endedReason ?? "USER",
            communityHandle: p.communityHandle ?? "",
            actorSnapshot: JSON.stringify(actorSnapshot),
            resurface: "false",
            // Only the host, whose stream someone else ended, gets a row they
            // never had; everyone else only ever sees their "is live" row change.
            ...(userId === p.hostUserId && endActorId !== p.hostUserId
              ? {}
              : { updateOnly: "true" }),
          },
          buildDeepLink("community", p.communityId),
          "liveStreamEnabled",
          // An ended stream has nothing to watch: the row opens the community.
          { screen: "COMMUNITY_CHAT" },
          generateEventThreadId(type)
        ),
      });
      await Promise.all(
        recipients.map(async (userId) => {
          await pushToUser(endedFor(userId)).catch((error: unknown) => {
            logger.warn(`[livestream] ended row failed user=${userId}`);
            logger.warn(error);
          });
          await dismissTrayCards({
            userId,
            tags: [pushTag.live(p.livestreamId)],
            reason: "LIVESTREAM_ENDED",
            data: { communityId: p.communityId, livestreamId: p.livestreamId },
          });
        })
      );
      break;
    }

    case CommunityEvents.JOIN_REQUEST_APPROVED: {
      const p = data as CommunityJoinRequestApprovedPayload;
      const [identity, decidedByName] = await Promise.all([
        communityIdentityFor(
          p.communityId,
          p.communityName,
          p.communityAvatarUrl
        ),
        actorNameFor(p.decidedBy.userId, p.decidedBy.displayName),
      ]);
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
        displayName: decidedByName,
      };
      await pushToUser({
        userId: p.userId,
        copy: communityCopy.joinRequestApproved(identity.name, decidedByName),
        ...base(
          type,
          identity,
          p.decidedBy.userId,
          {
            requestId: p.requestId,
            status: "APPROVED",
            communityHandle: p.communityHandle,
            decidedByDisplayName: decidedByName,
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
      const [identity, decidedByName] = await Promise.all([
        communityIdentityFor(
          p.communityId,
          p.communityName,
          p.communityAvatarUrl
        ),
        actorNameFor(p.decidedBy.userId, p.decidedBy.displayName),
      ]);
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
        displayName: decidedByName,
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
            decidedByDisplayName: decidedByName,
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
      // An admin/moderator's Add Member names both sides — "{actor} added
      // {target} to {community}", with the reader's own side rendered "You".
      // Every other path keeps its own sentence, so its copy gets no ids.
      const byAdd = p.via === "add_members" && p.actorId !== p.targetUserId;
      const [actorName, targetName] = byAdd
        ? await Promise.all([
            actorNameFor(p.actorId),
            actorNameFor(p.targetUserId),
          ])
        : [undefined, undefined];
      const who = byAdd
        ? ([actorName, targetName, p.actorId, p.targetUserId] as const)
        : ([] as const);
      // Welcome the joiner — UNLESS they will get the dedicated "approved" or
      // "self_join" (MEMBER_JOINED) notification.
      if (p.via !== "join_request_approved" && p.via !== "self_join") {
        await pushToUser({
          userId: p.targetUserId,
          // A request auto-accepted because the community went PUBLIC: nobody
          // added or approved them, so it reads "You're now a member of …".
          copy:
            p.via === "join_request_auto_accept"
              ? communityCopy.memberJoined(communityName)
              : communityCopy.memberAdded(communityName, ...who),
          // Closed with the rest of the room's cards once they open it.
          collapseKey: pushTag.added(p.communityId),
          ...base(
            type,
            identity,
            // Invite-link redeem has actor === target, and the joiner is still
            // welcomed by design — so no actorId, or push.service's
            // "actor is never a recipient" guard would drop it.
            p.actorId === p.targetUserId ? undefined : p.actorId,
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
          copy: communityCopy.memberAddedForModerators(communityName, ...who),
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
      // "{actor} removed You from {community}" — same sentence and name
      // sources as the add. A Super Admin is not an AIMess user: the copy
      // carries PLATFORM_ADMIN_ACTOR_ID and reads "Administrator removed You …",
      // and the admin's own id never reaches the row.
      const [identity, actorName, targetName] = await Promise.all([
        communityIdentityFor(p.communityId),
        p.byPlatformAdmin ? "" : actorNameFor(p.actorId),
        actorNameFor(p.targetUserId),
      ]);
      await pushToUser({
        userId: p.targetUserId,
        copy: communityCopy.memberKicked(
          identity.name,
          actorName,
          targetName,
          p.byPlatformAdmin ? PLATFORM_ADMIN_ACTOR_ID : p.actorId,
          p.targetUserId
        ),
        bypassSettings: true,
        ...base(
          type,
          identity,
          p.byPlatformAdmin ? undefined : p.actorId,
          {
            reason: p.reason ?? "",
          },
          buildDeepLink("communities"),
          "communityEnabled",
          { screen: "COMMUNITY_DETAILS", userId: p.targetUserId },
          generateEventThreadId(type)
        ),
      });
      await dismissRoomCards([p.targetUserId], p.communityId, "REMOVED");
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
      await dismissRoomCards([p.targetUserId], p.communityId, "REMOVED");
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

    case CommunityEvents.MEMBER_LEFT: {
      // Self-action — the user voluntarily left (or deleted the conversation);
      // they already know, so no push. Their other devices still hold this
      // room's cards, and those have to go.
      const p = data as CommunityMemberLeftPayload;
      await dismissRoomCards([p.actorId], p.communityId, "LEFT");
      break;
    }

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
      await dismissRoomCards(p.memberIds, p.communityId, "DELETED");
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
