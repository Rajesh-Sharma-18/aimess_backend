/**
 * NotificationEligibilityService — the central CommunityNotificationPolicy gate.
 *
 * Community FCM / inbox delivery must never reach a non-ACTIVE member. The
 * mute gate stays fail-open (oracle outage must not suppress everyone else's
 * pushes). Membership + preference gates are fail-closed so a LEFT/removed
 * user cannot keep receiving community pushes when the oracle is unhealthy.
 */
import { communityClient } from "../grpc/community.client.js";
import { chatMessagingClient } from "../grpc/chat-messaging.client.js";

/**
 * True when `actorId` has an effective moderation mute in `communityId` — i.e.
 * notifications triggered by this actor's community action should be suppressed.
 */
export async function isCommunityActorMuted(
  actorId: string,
  communityId: string
): Promise<boolean> {
  return (
    await communityClient.checkCommunityMute({
      communityId,
      userId: actorId,
    })
  ).isMuted;
}

/**
 * True when `recipientId` has muted private room `roomId` — i.e. this
 * message must not generate a push for them. Fail-open, same as community's
 * `isCommunityActorMuted`: an oracle outage must never suppress a push.
 */
export async function isPrivateRoomMutedBy(
  recipientId: string,
  roomId: string
): Promise<boolean> {
  return (
    await chatMessagingClient.checkPrivateMute({
      roomId,
      userId: recipientId,
    })
  ).isMuted;
}

/**
 * True when `recipientId` has muted group room `roomId` — i.e. this message
 * must not generate a push for them. Fail-open, same as `isPrivateRoomMutedBy`:
 * an oracle outage must never suppress a push.
 */
export async function isGroupMemberMuted(
  recipientId: string,
  roomId: string
): Promise<boolean> {
  return (
    await chatMessagingClient.checkGroupMute({
      roomId,
      userId: recipientId,
    })
  ).isMuted;
}

/**
 * True only when `userId` is an ACTIVE member of `communityId`. Fail-closed:
 * transport / breaker failures resolve to false so former members never get
 * community FCM or inbox pushes during an oracle outage.
 */
export async function isCommunityActiveMember(
  userId: string,
  communityId: string
): Promise<boolean> {
  return (
    await communityClient.checkCommunityMembership({
      communityId,
      userId,
    })
  ).isMember;
}

/**
 * Intersect `userIds` with the authoritative ACTIVE roster for `communityId`.
 * Fail-closed: oracle outage → empty list (suppress the whole fan-out).
 */
export async function filterToActiveCommunityMembers(
  communityId: string,
  userIds: string[]
): Promise<string[]> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return [];

  const { userIds: activeIds } =
    await communityClient.getCommunityActiveMemberIds({ communityId });
  const active = new Set(activeIds);
  return unique.filter((id) => active.has(id));
}

/**
 * Intersect `userIds` with the members of `communityId` who are ACTIVE **and**
 * still want `field` pushes. One gRPC call for the whole fan-out — the batched
 * replacement for calling `isCommunityActiveMember` + `isCommunityNotificationEnabled`
 * once per recipient (4 DB queries each, which saturated community-service, tripped
 * the 2s breaker, and — because that breaker is fail-CLOSED — silently dropped the
 * push). Fail-closed: oracle outage → empty list.
 */
export async function filterToNotifiableCommunityMembers(
  communityId: string,
  userIds: string[],
  field: "chatEnabled" | "streamEnabled" | "announcementEnabled"
): Promise<string[]> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return [];

  const { userIds: notifiableIds } =
    await communityClient.getCommunityNotifiableMemberIds({
      communityId,
      field,
    });
  const notifiable = new Set(notifiableIds);
  return unique.filter((id) => notifiable.has(id));
}

/**
 * True when `recipientId` wants pushes of `field` from `communityId` — the
 * recipient's own per-community notification-preference toggle. Also requires
 * ACTIVE membership (community-service oracle). Fail-closed on oracle outage.
 */
export async function isCommunityNotificationEnabled(
  recipientId: string,
  communityId: string,
  field: "chatEnabled" | "streamEnabled" | "announcementEnabled"
): Promise<boolean> {
  return (
    await communityClient.checkCommunityNotificationPref({
      communityId,
      userId: recipientId,
      field,
    })
  ).enabled;
}
