/**
 * Community notification-preference oracle — used by the
 * `checkCommunityNotificationPref` gRPC handler (notifications-service push gate).
 *
 * Contract:
 *   - Non-ACTIVE members (LEFT / BANNED / PENDING / no row) → enabled=false.
 *     Former members must never receive FCM or in-app pushes for that community.
 *   - ACTIVE member with no mute-setting row → enabled=true (implicit defaults).
 *   - ACTIVE member with a row → the requested field's boolean.
 */
import { CommunityMemberStatus } from "../generated/prisma/index.js";
import { communityRepository } from "../repositories/community.repository.js";

export type CommunityNotificationPrefField =
  | "chatEnabled"
  | "streamEnabled"
  | "announcementEnabled";

export async function resolveCommunityNotificationPrefEnabled(
  communityId: string,
  userId: string,
  field: CommunityNotificationPrefField
): Promise<boolean> {
  const membership = await communityRepository.findMembership(
    communityId,
    userId
  );
  if (!membership || membership.status !== CommunityMemberStatus.ACTIVE) {
    return false;
  }

  const row = await communityRepository.findMuteByUserAndCommunity(
    userId,
    communityId
  );
  return row ? row[field] : true;
}
