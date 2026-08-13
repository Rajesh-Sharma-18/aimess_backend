/**
 * Community notification-preference oracle — used by the
 * `checkCommunityNotificationPref` gRPC handler (notifications-service push gate)
 * and by the caller-facing mute fields on community list / detail reads.
 *
 * Storage model (`CommunityMuteSetting`, one row per user+community):
 *   - `streamEnabled` / `chatEnabled` / `announcementEnabled` are the ONLY
 *     source of truth for whether a notification kind is delivered. Absent row
 *     ⇒ all three implicitly true.
 *   - `mutedUntil` is a TIMED mute only: a future timestamp snoozes every kind
 *     until it lapses. `null` means "no timed mute" — NOT "muted forever".
 *   - A full/indefinite mute is stored as all three toggles false, so the mute
 *     badge and the toggles can never disagree and re-enabling a category
 *     always resumes delivery.
 *
 * Contract:
 *   - Non-ACTIVE members (LEFT / BANNED / PENDING / no row) → enabled=false.
 *     Former members must never receive FCM or in-app pushes for that community.
 *   - ACTIVE member with no mute-setting row → enabled=true (implicit defaults).
 *   - ACTIVE member with an unlapsed timed mute → enabled=false for every field.
 *   - Otherwise → the requested field's boolean.
 */
import { CommunityMemberStatus } from "../generated/prisma/index.js";
import { communityRepository } from "../repositories/community.repository.js";

export type CommunityNotificationPrefField =
  | "chatEnabled"
  | "streamEnabled"
  | "announcementEnabled";

export type MuteRowLike = {
  mutedUntil: Date | null;
  streamEnabled: boolean;
  chatEnabled: boolean;
  announcementEnabled: boolean;
};

/**
 * True while a TIMED mute ("mute for 8 hours") is still running. A row whose
 * `mutedUntil` has passed is a lapsed temp-mute — lazily treated as expired
 * rather than muted (no sweeper garbage-collects these). `mutedUntil === null`
 * is NOT a mute: a row with no timed mute is just a preferences row.
 */
export function isTimedMuteActive(
  row: { mutedUntil: Date | null } | null | undefined
): boolean {
  return !!row?.mutedUntil && row.mutedUntil > new Date();
}

/**
 * The single derivation of "this community shows the mute badge": a running
 * timed mute, or every category toggle off. Never stored — always computed, so
 * the badge and the three switches are incapable of drifting apart.
 */
export function isCommunityMuted(
  row: Partial<MuteRowLike> | null | undefined
): boolean {
  if (!row) return false;
  if (isTimedMuteActive({ mutedUntil: row.mutedUntil ?? null })) return true;
  return (
    row.streamEnabled === false &&
    row.chatEnabled === false &&
    row.announcementEnabled === false
  );
}

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
  // A running timed mute snoozes every kind. Once it lapses (or when there was
  // never one) the per-field toggle decides — so flipping a switch back on
  // resumes delivery immediately, with no lingering global flag to clear.
  if (isTimedMuteActive(row)) return false;
  return row ? row[field] : true;
}
