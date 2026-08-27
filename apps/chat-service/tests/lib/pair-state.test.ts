/**
 * The pair verdict every entry point into a DM renders from.
 *
 * The failure this guards: the conversation list opened a room because it held
 * a roomId, while user search offered "Send Request" because it held a
 * friendship status and nothing else. Blocking unfriends, so a blocked pair
 * with years of history reported NONE on the friendship axis and search offered
 * to befriend a conversation that was sitting right there. Same pair, two
 * screens, decided by which door you came through.
 *
 * Every row below is one cell of the entry-point × relationship-state matrix.
 * If this file and the endpoint that calls it ever disagree, the doors diverge
 * again.
 */
import { resolvePairState, type PairStateInput } from "../../src/lib/pair-state.js";

/** A pair with nothing between them — override one axis per case. */
const base: PairStateInput = {
  peerUnavailable: false,
  blockedByMe: false,
  blockedByPeer: false,
  conversationId: null,
  hasHistory: false,
  isFriend: false,
  isPending: false,
  canSendRequest: true,
};

const withConversation: Partial<PairStateInput> = {
  conversationId: "prv_1",
  hasHistory: true,
};

const resolve = (over: Partial<PairStateInput>) =>
  resolvePairState({ ...base, ...over });

describe("resolvePairState — precedence", () => {
  it("an unavailable peer outranks everything else, block and history included", () => {
    const r = resolve({
      ...withConversation,
      peerUnavailable: true,
      blockedByMe: true,
      isFriend: true,
    });
    expect(r.state).toBe("UNAVAILABLE");
    expect(r.restriction).toBe("PEER_UNAVAILABLE");
    expect(r.canSendMessage).toBe(false);
  });

  it("a block outranks the conversation — but never hides it", () => {
    const mine = resolve({ ...withConversation, blockedByMe: true });
    expect(mine.state).toBe("BLOCKED_BY_ME");
    // The blocker's screen is the conversation PLUS a banner, not a different
    // screen: the room and its history stay on the response.
    expect(mine.conversationId).toBe("prv_1");
    expect(mine.hasHistory).toBe(true);
    expect(mine.canSendMessage).toBe(false);

    const theirs = resolve({ ...withConversation, blockedByPeer: true });
    expect(theirs.state).toBe("BLOCKED_BY_PEER");
    expect(theirs.conversationId).toBe("prv_1");
    expect(theirs.hasHistory).toBe(true);
    expect(theirs.canSendMessage).toBe(false);
  });

  it("names the two block directions apart — only one of them is undoable", () => {
    expect(resolve({ blockedByMe: true }).restriction).toBe("BLOCKED_BY_ME");
    expect(resolve({ blockedByPeer: true }).restriction).toBe("BLOCKED_BY_PEER");
  });

  it("a mutual block reports BLOCKED_BY_ME, the actionable half, and still admits the other", () => {
    const r = resolve({ blockedByMe: true, blockedByPeer: true });
    expect(r.state).toBe("BLOCKED_BY_ME");
    expect(r.blockedByMe).toBe(true);
    expect(r.blockedByPeer).toBe(true);
  });

  it("history beats relationship: an unfriended pair that talked still opens as the conversation", () => {
    const r = resolve({ ...withConversation, isFriend: false });
    expect(r.state).toBe("CONVERSATION");
    // ...but the composer is shut, because messaging needs a friendship.
    expect(r.canSendMessage).toBe(false);
    expect(r.restriction).toBe("NOT_FRIENDS");
    // ...and the way back is still offered, or the pair is stranded with a chat
    // they can never write in again.
    expect(r.canSendRequest).toBe(true);
  });

  it("a friend's empty room IS their conversation", () => {
    const r = resolve({ conversationId: "prv_1", hasHistory: false, isFriend: true });
    expect(r.state).toBe("CONVERSATION");
    expect(r.canSendMessage).toBe(true);
    expect(r.restriction).toBeNull();
  });

  it("an empty room left behind by an unfriend is NOT a conversation", () => {
    // Friend-accept mints a room eagerly. Nobody spoke, then they unfriended —
    // opening a blank transcript instead of the contact card would be wrong.
    const r = resolve({ conversationId: "prv_1", hasHistory: false });
    expect(r.state).toBe("NO_RELATIONSHIP");
  });

  it("a pending request only shows through once no conversation claims the screen", () => {
    expect(resolve({ isPending: true }).state).toBe("REQUEST_PENDING");
    expect(resolve({ ...withConversation, isPending: true }).state).toBe(
      "CONVERSATION"
    );
  });

  it("NO_RELATIONSHIP — the ONLY state that may render Send Request", () => {
    const r = resolve({});
    expect(r.state).toBe("NO_RELATIONSHIP");
    expect(r.canSendRequest).toBe(true);
  });
});

describe("resolvePairState — canSendMessage mirrors the write gate", () => {
  // assertPeerInteractionAllowed refuses in this order: banned, blocked either
  // way, not friends. Anything this flag allows that the gate refuses is an
  // open composer over an API that says no.
  it.each([
    ["unavailable peer", { peerUnavailable: true, isFriend: true }],
    ["viewer blocked them", { blockedByMe: true, isFriend: true }],
    ["they blocked viewer", { blockedByPeer: true, isFriend: true }],
    ["not friends", {}],
  ])("refuses: %s", (_label, over) => {
    expect(resolve(over as Partial<PairStateInput>).canSendMessage).toBe(false);
  });

  it("allows only an available, unblocked, friend pair", () => {
    expect(resolve({ isFriend: true }).canSendMessage).toBe(true);
  });
});

describe("resolvePairState — Send Request is never offered under a block", () => {
  // user-service resolves `canSendRequest` with the same gate `sendRequest`
  // enforces, so a blocked pair arrives here already false. This pins the
  // contract: no state may resurrect the action.
  it.each([
    ["viewer blocked them", { blockedByMe: true }],
    ["they blocked viewer", { blockedByPeer: true }],
    ["mutual", { blockedByMe: true, blockedByPeer: true }],
  ])("%s → no Send Request state, no Send Request flag", (_label, over) => {
    const r = resolve({ ...over, canSendRequest: false } as Partial<PairStateInput>);
    expect(r.state).not.toBe("NO_RELATIONSHIP");
    expect(r.canSendRequest).toBe(false);
  });
});
