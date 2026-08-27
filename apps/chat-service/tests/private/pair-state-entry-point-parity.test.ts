/**
 * Entry-point parity for opening a DM.
 *
 * The bug: user A blocks user B in a chat that has history. Opening from the
 * chat list showed the conversation. Opening the SAME pair from search or
 * recent searches showed a "Send Request" button instead — because a block
 * unfriends, and the search path decided the screen from the friendship axis
 * alone.
 *
 * The two doors into `GET /chat/private/rooms/:id` are the two shapes of that
 * id: a roomId (`prv_…`, what the conversation list holds) and a peer userId
 * (what search, recent, a profile, a deep link and a notification hold). Both
 * resolve through the same builder, so both must report the same `pairState`
 * for the same pair. Every case below asserts that equality, not just the
 * individual verdict — a regression that breaks only one door is the whole
 * class of bug this file exists to catch.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const PEER = "peer-1";
const ROOM = "prv_1";

type Relationship = {
  status: "FRIEND" | "PENDING" | "NONE" | "BLOCKED";
  direction?: "OUTGOING" | "INCOMING" | null;
  blockedByPeer?: boolean;
  canSendRequest?: boolean;
};

/** A pair with an existing room; `hasHistory` decides whether anyone spoke. */
function pairWithRoom(rel: Relationship, opts: { hasHistory: boolean }) {
  const room = {
    roomId: ROOM,
    participants: [TEST_USER_ID, PEER],
    mutedBy: {},
    unreadCountByUser: {},
    lastMessage: null,
    lastMessageAt: new Date(1000),
    createdAt: new Date(500),
    updatedAt: new Date(1500),
    // > 0 means something was written; hasHumanMessage below says whether any
    // of it was a person rather than a SYSTEM row.
    lastSequence: opts.hasHistory ? 4 : 0,
  };
  mocks.privateRoomRepo.findByRoomId.mockResolvedValue(room);
  mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue(room);
  mocks.privateMessageRepo.hasHumanMessage.mockResolvedValue(opts.hasHistory);
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(
    new Map([[PEER, { displayName: "Peer One", memberId: "peer1" }]])
  );
  mocks.friendshipGrpcClient.checkFriendships.mockResolvedValue(
    new Map([
      [
        PEER,
        {
          status: rel.status,
          direction: rel.direction ?? null,
          blockedByPeer: rel.blockedByPeer ?? false,
          canSendRequest: rel.canSendRequest ?? false,
        },
      ],
    ])
  );
}

/** Same pair, no room at all. */
function pairWithoutRoom(rel: Relationship) {
  mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue(null);
  mocks.userServiceClient.checkFriendship.mockResolvedValue(
    rel.status === "FRIEND"
  );
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(
    new Map([[PEER, { displayName: "Peer One", memberId: "peer1" }]])
  );
  mocks.friendshipGrpcClient.checkFriendships.mockResolvedValue(
    new Map([
      [
        PEER,
        {
          status: rel.status,
          direction: rel.direction ?? null,
          blockedByPeer: rel.blockedByPeer ?? false,
          canSendRequest: rel.canSendRequest ?? false,
        },
      ],
    ])
  );
}

const openBy = (id: string) =>
  request(app)
    .get(`/api/chat/private/rooms/${id}`)
    .set(bearer(makeAccessToken()));

/** Open the pair through BOTH doors and assert they agree. */
async function bothDoors() {
  const [byRoomId, byPeerId] = await Promise.all([openBy(ROOM), openBy(PEER)]);
  expect(byRoomId.status).toBe(200);
  expect(byPeerId.status).toBe(200);
  expect(byPeerId.body.data.pairState).toEqual(byRoomId.body.data.pairState);
  return byRoomId.body.data.pairState;
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("A. the reported bug — a blocked pair with history", () => {
  it("A1/A2/A3: the BLOCKED user gets the conversation from every door, never Send Request", async () => {
    // B's view of A: the block unfriended them, so the friendship axis alone
    // says NONE — which is exactly what used to produce the Send Request card.
    pairWithRoom(
      { status: "NONE", blockedByPeer: true, canSendRequest: false },
      { hasHistory: true }
    );

    const state = await bothDoors();
    expect(state.state).toBe("BLOCKED_BY_PEER");
    expect(state.conversationId).toBe(ROOM);
    expect(state.hasHistory).toBe(true);
    expect(state.canSendMessage).toBe(false);
    expect(state.canSendRequest).toBe(false);
    // Copy for the blocked party must differ from a declined request.
    expect(state.restriction).toBe("BLOCKED_BY_PEER");
  });

  it("A4: the BLOCKER gets the conversation + an undoable block from every door", async () => {
    pairWithRoom(
      { status: "BLOCKED", canSendRequest: false },
      { hasHistory: true }
    );

    const state = await bothDoors();
    expect(state.state).toBe("BLOCKED_BY_ME");
    expect(state.blockedByMe).toBe(true);
    expect(state.conversationId).toBe(ROOM);
    expect(state.hasHistory).toBe(true);
    expect(state.canSendMessage).toBe(false);
    expect(state.restriction).toBe("BLOCKED_BY_ME");
  });

  it("A5: after unblock, every door opens the normal chat again — no residue", async () => {
    pairWithRoom(
      { status: "FRIEND", canSendRequest: false },
      { hasHistory: true }
    );

    const state = await bothDoors();
    expect(state.state).toBe("CONVERSATION");
    expect(state.blockedByMe).toBe(false);
    expect(state.blockedByPeer).toBe(false);
    expect(state.canSendMessage).toBe(true);
    expect(state.restriction).toBeNull();
  });

  it("C7: a mutual block stays consistent across doors", async () => {
    pairWithRoom(
      { status: "BLOCKED", blockedByPeer: true, canSendRequest: false },
      { hasHistory: true }
    );

    const state = await bothDoors();
    expect(state.state).toBe("BLOCKED_BY_ME");
    expect(state.blockedByMe).toBe(true);
    expect(state.blockedByPeer).toBe(true);
    expect(state.canSendMessage).toBe(false);
  });
});

describe("B. entry-point parity across the remaining relationship states", () => {
  it("D6: a request that was just accepted opens the chat, not the request state", async () => {
    pairWithRoom({ status: "FRIEND" }, { hasHistory: true });
    expect((await bothDoors()).state).toBe("CONVERSATION");
  });

  it("unfriended with history: the conversation, composer shut, way back offered", async () => {
    pairWithRoom(
      { status: "NONE", canSendRequest: true },
      { hasHistory: true }
    );

    const state = await bothDoors();
    expect(state.state).toBe("CONVERSATION");
    expect(state.canSendMessage).toBe(false);
    expect(state.restriction).toBe("NOT_FRIENDS");
    expect(state.canSendRequest).toBe(true);
  });

  it("a pending request with no history is the request state, not a conversation", async () => {
    pairWithRoom(
      { status: "PENDING", direction: "OUTGOING" },
      { hasHistory: false }
    );
    expect((await bothDoors()).state).toBe("REQUEST_PENDING");
  });

  it("a pending request WITH history opens the conversation", async () => {
    pairWithRoom(
      { status: "PENDING", direction: "INCOMING" },
      { hasHistory: true }
    );
    expect((await bothDoors()).state).toBe("CONVERSATION");
  });

  it("D4: a deactivated peer outranks the conversation on every door", async () => {
    pairWithRoom({ status: "NONE" }, { hasHistory: true });
    mocks.cacheRepo.getUserSnapshots.mockResolvedValue(
      new Map([
        [PEER, { displayName: "Peer One", memberId: "peer1", isDeletedUser: true }],
      ])
    );

    const state = await bothDoors();
    expect(state.state).toBe("UNAVAILABLE");
    expect(state.restriction).toBe("PEER_UNAVAILABLE");
    expect(state.canSendMessage).toBe(false);
  });
});

describe("D. pairs with no conversation", () => {
  it("D1: blocked with NO prior conversation — a real state, never Send Request", async () => {
    pairWithoutRoom({
      status: "NONE",
      blockedByPeer: true,
      canSendRequest: false,
    });

    const res = await openBy(PEER);
    expect(res.status).toBe(200);
    expect(res.body.data.roomId).toBeNull();
    expect(res.body.data.pairState).toMatchObject({
      state: "BLOCKED_BY_PEER",
      conversationId: null,
      hasHistory: false,
      canSendMessage: false,
      canSendRequest: false,
    });
    expect(mocks.privateRoomRepo.create).not.toHaveBeenCalled();
  });

  it("D1 (blocker side): no conversation, block still outranks", async () => {
    pairWithoutRoom({ status: "BLOCKED", canSendRequest: false });

    const res = await openBy(PEER);
    expect(res.body.data.pairState.state).toBe("BLOCKED_BY_ME");
    expect(mocks.privateRoomRepo.create).not.toHaveBeenCalled();
  });

  it("strangers: the ONE state that may render Send Request", async () => {
    pairWithoutRoom({ status: "NONE", canSendRequest: true });

    const res = await openBy(PEER);
    expect(res.body.data.pairState).toMatchObject({
      state: "NO_RELATIONSHIP",
      canSendRequest: true,
    });
  });

  it("an empty room left by an unfriend is not a conversation to re-open", async () => {
    pairWithRoom(
      { status: "NONE", canSendRequest: true },
      { hasHistory: false }
    );
    expect((await bothDoors()).state).toBe("NO_RELATIONSHIP");
  });

  it("a friend with an empty room opens their chat", async () => {
    pairWithRoom({ status: "FRIEND" }, { hasHistory: false });
    expect((await bothDoors()).state).toBe("CONVERSATION");
  });
});
