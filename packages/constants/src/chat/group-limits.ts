/**
 * Hard ceiling on ACTIVE members of a group chat, enforced server-side on every
 * path that adds a member (invite-link self-join, admin direct add, batch add).
 *
 * Spec (AIMESS-237): every group holds exactly 256 — no per-group limit. The
 * legacy `GroupRoom.memberLimit` column is written as 256 and ignored on read;
 * every capacity decision goes through {@link effectiveGroupMemberLimit}.
 */
export const MAX_GROUP_MEMBERS = 256;

/** The limit enforced for a room — always the cap; a stored legacy value (50, 5000) is ignored. */
export function effectiveGroupMemberLimit(_memberLimit?: number | null): number {
  return MAX_GROUP_MEMBERS;
}
