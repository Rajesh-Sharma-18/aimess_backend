/**
 * Private-chat PAIR STATE — the one place that decides what a (viewer, peer)
 * pair resolves to, for every entry point that can open a DM.
 *
 * Before this existed each surface derived its own answer from whatever slice
 * of the truth it happened to hold. The conversation list opened a room because
 * it had a roomId; user search opened a "Send Request" card because it had a
 * friendship status and nothing else. Blocking unfriends, so a blocked pair
 * with years of history reported `NONE` on the friendship axis and the search
 * entry point offered to send a friend request into a conversation that was
 * sitting right there. Same pair, two screens, decided by which door you came
 * through.
 *
 * So the decision is made once, server-side, from ALL the axes at once, and
 * every door renders the result. The axes:
 *
 *   availability — the peer is deleted or platform-banned
 *   block        — either direction, tracked separately (a mutual block is
 *                  both, and "I blocked them" is a different screen from
 *                  "they blocked me")
 *   conversation — a room, and whether two people ever actually talked in it
 *   friendship   — ACCEPTED / PENDING / none
 *
 * PRECEDENCE (explicit, in this order — the first that matches names the state):
 *
 *   1. peer unavailable      — nothing else is worth reporting about a account
 *                              that is gone
 *   2. blocked, either way   — the strongest live restriction; it outranks the
 *                              conversation because it decides what the screen
 *                              may DO, while `conversationId`/`hasHistory`
 *                              below still say what the screen SHOWS
 *   3. existing conversation — history wins over relationship: a pair that has
 *                              talked opens as that conversation, never as a
 *                              fresh contact card
 *   4. pending request       — a request is outstanding in some direction
 *   5. no relationship       — and only here may a client offer "Send Request"
 *
 * `state` never suppresses the other fields: a BLOCKED_BY_ME pair still carries
 * its `conversationId` and `hasHistory`, because the blocker's screen is the
 * conversation plus a banner, not a different screen. `state` answers "which
 * treatment", the rest answer "what content".
 *
 * `canSendMessage` mirrors `PrivateMessageService.assertPeerInteractionAllowed`
 * exactly — banned, then blocked (either way), then friends. If the two ever
 * drift, a client renders an open composer for a write the API refuses, which
 * is the whole class of bug this module exists to end.
 */

export type PrivatePairState =
  | "UNAVAILABLE"
  | "BLOCKED_BY_ME"
  | "BLOCKED_BY_PEER"
  | "CONVERSATION"
  | "REQUEST_PENDING"
  | "NO_RELATIONSHIP";

/**
 * Why the composer is closed, or null when it is open. Machine-readable so the
 * client picks its own copy — and deliberately distinct per cause: "they
 * blocked you" must not render the same sentence as "you are not friends", or
 * a declined request and a block become indistinguishable to the user.
 *
 * The codes match the errors the write path throws (`CHAT_PEER_BANNED`,
 * `CHAT_BLOCKED`, `CHAT_FRIENDSHIP_REQUIRED`) one-for-one.
 */
export type PrivatePairRestriction =
  | "PEER_UNAVAILABLE"
  | "BLOCKED_BY_ME"
  | "BLOCKED_BY_PEER"
  | "NOT_FRIENDS";

export type PrivatePairStateInfo = {
  state: PrivatePairState;
  /** The room, when one exists — carried in EVERY state, restrictions included. */
  conversationId: string | null;
  /** Two people actually talked here (non-SYSTEM rows exist). */
  hasHistory: boolean;
  /** The viewer blocked the peer — the viewer can undo this. */
  blockedByMe: boolean;
  /** The peer blocked the viewer — the viewer cannot undo this. */
  blockedByPeer: boolean;
  /** Mirrors the server write gate exactly. */
  canSendMessage: boolean;
  /** Server-decided add-friend eligibility (privacy scope + block/friend/pending). */
  canSendRequest: boolean;
  restriction: PrivatePairRestriction | null;
};

export type PairStateInput = {
  /** Peer account is deleted or platform-banned. */
  peerUnavailable: boolean;
  blockedByMe: boolean;
  blockedByPeer: boolean;
  conversationId: string | null;
  hasHistory: boolean;
  isFriend: boolean;
  isPending: boolean;
  /** `ChatFriendshipInfo.canSendRequest` — already resolved by user-service. */
  canSendRequest: boolean;
};

export function resolvePairState(
  input: PairStateInput
): PrivatePairStateInfo {
  const {
    peerUnavailable,
    blockedByMe,
    blockedByPeer,
    conversationId,
    hasHistory,
    isFriend,
    isPending,
  } = input;

  // A room with no human message is not a conversation. Friend-accept mints an
  // empty room eagerly, so without this an unfriended pair that never spoke
  // would open a blank transcript instead of the contact card they expect.
  // Friends are the exception: their empty room IS their chat.
  const hasConversation = conversationId !== null && (hasHistory || isFriend);

  const restriction: PrivatePairRestriction | null = peerUnavailable
    ? "PEER_UNAVAILABLE"
    : blockedByMe
      ? "BLOCKED_BY_ME"
      : blockedByPeer
        ? "BLOCKED_BY_PEER"
        : isFriend
          ? null
          : "NOT_FRIENDS";

  const state: PrivatePairState = peerUnavailable
    ? "UNAVAILABLE"
    : // Mutual block reports BLOCKED_BY_ME: of the two, only the viewer's own
      // block is actionable, so that is the one worth naming. `blockedByPeer`
      // stays true alongside it, so a client that cares can still tell.
      blockedByMe
      ? "BLOCKED_BY_ME"
      : blockedByPeer
        ? "BLOCKED_BY_PEER"
        : hasConversation
          ? "CONVERSATION"
          : isPending
            ? "REQUEST_PENDING"
            : "NO_RELATIONSHIP";

  return {
    state,
    conversationId,
    hasHistory,
    blockedByMe,
    blockedByPeer,
    canSendMessage: restriction === null,
    // Eligibility to send a friend request, NOT permission to render the
    // "Send Request" SCREEN — `state` alone decides that, and it never returns
    // NO_RELATIONSHIP for a pair that has a conversation. Keeping the two
    // separate is what lets an unfriended pair with history open their chat AND
    // still be offered "Add Friend" from its header: messaging needs an
    // ACCEPTED friendship, so stripping the action from every pair with history
    // would strand them with a chat they can never write in again.
    // Already false under a block in either direction — user-service resolves
    // that in `canSendFriendRequest`, the same gate `sendRequest` enforces.
    canSendRequest: input.canSendRequest,
    restriction,
  };
}
