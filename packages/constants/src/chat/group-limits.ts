/**
 * Hard ceiling on ACTIVE members of a group chat, enforced server-side on every
 * path that adds a member (invite-link self-join, admin direct add, batch add).
 *
 * `GroupRoom.memberLimit` stays a per-room column so a group may be made
 * SMALLER, but it can never raise the roof: every capacity decision goes through
 * {@link effectiveGroupMemberLimit}, so a legacy row storing 5000 still stops at
 * 256.
 */
export const MAX_GROUP_MEMBERS = 256;

/** The limit actually enforced for a room — its own limit, clamped to the cap. */
export function effectiveGroupMemberLimit(
  memberLimit?: number | null
): number {
  if (!memberLimit || memberLimit <= 0) return MAX_GROUP_MEMBERS;
  return Math.min(memberLimit, MAX_GROUP_MEMBERS);
}
