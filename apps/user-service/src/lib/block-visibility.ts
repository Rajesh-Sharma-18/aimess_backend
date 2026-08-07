/**
 * Block visibility policy — the ONE place the direction of a block is turned
 * into "who disappears from this viewer's results".
 *
 * A block is ONE-WAY, matching WhatsApp/Telegram: it removes the BLOCKER from
 * the BLOCKED user's world, not the other way round.
 *
 *   A blocks B  →  B can no longer find A anywhere.
 *                  A still finds B — A has to be able to see, revisit and
 *                  eventually unblock the relationship they created.
 *
 * So the set a search must subtract is the viewer's INCOMING blocks (people who
 * blocked the viewer), never the outgoing ones. Deriving both sets in one place
 * keeps every discovery surface on the same rule — the previous per-service
 * `b.blockerId === viewerId ? b.blockedId : b.blockerId` collapsed the two
 * directions into one set and hid each blocked user from their own blocker.
 *
 * A mutual block (A blocks B AND B blocks A) lands in both sets: each side is
 * hidden from the other by the other's block, which is the correct outcome and
 * needs no special case.
 */

export type BlockRow = { blockerId: string; blockedId: string };

export type BlockVisibility = {
  /**
   * Users who blocked the viewer. MUST be excluded from every search, listing
   * and picker — to this viewer they do not exist.
   */
  hiddenIds: Set<string>;
  /**
   * Users the viewer blocked. Deliberately still visible: the blocker manages
   * (and undoes) their own block. Carried so rows can be labelled `isBlockedByMe`
   * instead of offering a friend-request action the API would reject.
   */
  blockedByMe: Set<string>;
};

/** Splits `findAllBlocks(viewerId)` rows by direction. */
export function splitBlocks(
  viewerId: string,
  blocks: readonly BlockRow[]
): BlockVisibility {
  const hiddenIds = new Set<string>();
  const blockedByMe = new Set<string>();
  for (const b of blocks) {
    if (b.blockedId === viewerId) hiddenIds.add(b.blockerId);
    if (b.blockerId === viewerId) blockedByMe.add(b.blockedId);
  }
  return { hiddenIds, blockedByMe };
}
