/**
 * Invitation-link lifetime — shared by BOTH invite mechanisms so a group link
 * and a community link live on exactly the same clock:
 *  • chat-service      `GroupInviteLink.expiresAt`
 *  • community-service `CommunityInviteLink.expiresAt`
 *
 * Product rule: an invitation link does NOT expire on its own. It stays usable
 * until an authorized admin revokes it (or its `maxUses` is spent). A caller may
 * still ask for an expiry when minting one — that is honoured verbatim — but no
 * code path stamps one on a link that was minted without it.
 *
 * This replaces the earlier blanket 1-hour TTL, which killed links nobody had
 * revoked: a card shared in chat went dead an hour later even though the join
 * request, the approval and the membership behind it were all still live.
 */

/**
 * Normalize a caller-supplied expiry: a real date is kept, anything absent or
 * unparseable means "never expires". No ceiling is applied.
 */
export function clampInviteLinkExpiry(
  requested?: Date | string | null
): Date | null {
  if (!requested) return null;
  const asked = requested instanceof Date ? requested : new Date(requested);
  return Number.isNaN(asked.getTime()) ? null : asked;
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
