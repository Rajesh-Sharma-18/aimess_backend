/**
 * NotificationEligibilityService — the central CommunityNotificationPolicy gate.
 *
 * ALL future community-action notification flows (mentions, replies, reactions,
 * and the current chat-message fan-out) MUST pass through this gate so a
 * moderator-muted member never generates community notifications. Today the only
 * call site is the chat-message consumer; mention/reply/reaction notifications
 * are not produced yet, so wiring them here now would be dead code — add those
 * call sites when those notification flows are introduced.
 *
 * Fail-open by construction: `communityClient.checkCommunityMute` resolves to
 * `{ isMuted: false }` on ANY transport error, so an oracle outage never
 * suppresses a notification.
 */
import { communityClient } from "../grpc/community.client.js";

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
 * True when `recipientId` wants pushes of `field` from `communityId` — the
 * recipient's own per-community notification-preference toggle (distinct
 * from `isCommunityActorMuted`, which gates on the *sender's* moderation
 * mute). Fail-open: an oracle outage resolves to "enabled" so a preference
 * check outage never suppresses a notification.
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
