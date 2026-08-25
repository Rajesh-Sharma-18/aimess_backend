/**
 * Invitation-link lifetime — shared by BOTH invite mechanisms so a group link
 * and a community link expire on exactly the same clock:
 *  • chat-service    `GroupInviteLink.expiresAt`
 *  • community-service `CommunityInviteLink.expiresAt`
 *
 * Product rule: every invitation link expires 1 hour after it is created, and
 * expiry is enforced server-side on preview AND on join/redeem.
 */
export const INVITE_LINK_TTL_MS = 60 * 60 * 1000;

/** Expiry instant for a link minted at `createdAt` (defaults to now). */
export function inviteLinkExpiresAt(createdAt: Date = new Date()): Date {
  return new Date(createdAt.getTime() + INVITE_LINK_TTL_MS);
}

/**
 * Clamp a caller-supplied expiry to the 1-hour ceiling. A shorter custom expiry
 * is honoured; a longer one (or none at all) collapses to `now + 1h`, so no code
 * path can mint a link that outlives the rule.
 */
export function clampInviteLinkExpiry(
  requested?: Date | string | null,
  now: Date = new Date()
): Date {
  const ceiling = inviteLinkExpiresAt(now);
  if (!requested) return ceiling;
  const asked = requested instanceof Date ? requested : new Date(requested);
  if (Number.isNaN(asked.getTime())) return ceiling;
  return asked.getTime() < ceiling.getTime() ? asked : ceiling;
}

/** Single expiry predicate for both services (expiry is inclusive: `<= now`). */
export function isInviteLinkExpired(
  expiresAt: Date | string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!expiresAt) return false;
  const at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return !Number.isNaN(at.getTime()) && at.getTime() <= now;
}
