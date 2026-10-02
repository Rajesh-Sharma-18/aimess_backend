/**
 * `relationshipStatus` on the inbox — "no relationship" vs "lookup failed".
 *
 * Reported: a viewer whose ACCEPTED friend showed `relationshipStatus: "NONE"`
 * on `GET /chat/inbox` while name/avatar rendered fine. The same page held a
 * corrupt PRIVATE room whose stored "peer" is a group room id (`grp_…`) or a
 * community ObjectId. The friendship batch went to user-service with that id
 * in it; `requesterId`/`addresseeId` are Postgres `uuid`, so the WHOLE batch
 * failed with INTERNAL. chat-service swallowed that into an empty map, and every
 * peer on the page — the real friend included — fell through to NONE.
 *
 * `postgresLikeFire` below is that upstream: it answers like user-service for
 * a clean batch and fails the way Postgres does the moment any id is not a
 * uuid. The real `lookupFriendships` (the client's body) runs in front of it.
 */
import * as grpc from "@grpc/grpc-js";
import request from "supertest";
import { makeBreaker } from "@aimess/grpc-utils";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { fetchUsersBatch } from "../../src/lib/user-service-client.js";
import { lookupFriendships } from "../../src/lib/friendship-lookup.js";
import type { CheckFriendshipsResult } from "../../src/grpc/user-snapshot.client.js";

const usersBatch = fetchUsersBatch as jest.Mock;

const FRIEND = "d3f98fba-a6a8-4b1e-a8c7-ab75e494b6a8";
const FRIEND_2 = "22222222-2222-4222-8222-222222222222";
const INCOMING = "33333333-3333-4333-8333-333333333333";
const OUTGOING = "44444444-4444-4444-8444-444444444444";
const STRANGER = "55555555-5555-4555-8555-555555555555";
const GROUP_ID = "grp_pdIiPX3BpLo5WUA5";
const COMMUNITY_ID = "6a7bf9214d6c5b8b86a11aa8";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What user-service holds for the caller. Anyone else: no row ⇒ NONE. */
const RELATIONSHIPS: Record<string, Partial<CheckFriendshipsResult["relationships"][number]>> = {
  [FRIEND]: { status: "FRIEND", friendshipId: "86aabd9c-5e64-4ba6-84fa-83f40d27d448" },
  [FRIEND_2]: { status: "FRIEND", friendshipId: "f2" },
  [INCOMING]: {
    status: "PENDING",
    direction: "INCOMING",
    friendshipId: "p-in",
    requesterId: INCOMING,
    canAccept: true,
    canReject: true,
  },
  [OUTGOING]: {
    status: "PENDING",
    direction: "OUTGOING",
    friendshipId: "p-out",
    requesterId: TEST_USER_ID,
    canCancel: true,
  },
};

function grpcError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

/** user-service's checkFriendships, including how Postgres fails on a non-uuid. */
const postgresLikeFire = jest.fn(
  async (args: { callerId: string; candidateIds: string[] }) => {
    if (![args.callerId, ...args.candidateIds].every((id) => UUID.test(id))) {
      throw grpcError(
        grpc.status.INTERNAL,
        'invalid input syntax for type uuid: "grp_pdIiPX3BpLo5WUA5"'
      );
    }
    return {
      friendIds: args.candidateIds.filter(
        (id) => RELATIONSHIPS[id]?.status === "FRIEND"
      ),
      relationships: args.candidateIds.map((userId) => ({
        userId,
        status: "NONE",
        direction: "",
        canSendRequest: true,
        ...RELATIONSHIPS[userId],
      })),
    } as CheckFriendshipsResult;
  }
);

beforeEach(() => postgresLikeFire.mockClear());

// ---------------------------------------------------------------------------
// The lookup itself (body of userGrpcClient.checkFriendships)
// ---------------------------------------------------------------------------
describe("lookupFriendships — malformed ids never reach user-service", () => {
  it("valid peers only: every relationship resolves", async () => {
    const map = await lookupFriendships(postgresLikeFire, TEST_USER_ID, [
      FRIEND,
      INCOMING,
      OUTGOING,
      STRANGER,
    ]);

    expect(map?.get(FRIEND)?.status).toBe("FRIEND");
    expect(map?.get(INCOMING)).toMatchObject({
      status: "PENDING",
      direction: "INCOMING",
      canAccept: true,
      canReject: true,
      canCancel: false,
    });
    expect(map?.get(OUTGOING)).toMatchObject({
      status: "PENDING",
      direction: "OUTGOING",
      canCancel: true,
      canAccept: false,
    });
    expect(map?.get(STRANGER)?.status).toBe("NONE");
  });

  it.each([
    ["a group room id", GROUP_ID],
    ["a community ObjectId", COMMUNITY_ID],
  ])("friend + %s: the bad id is not sent, the friend is FRIEND", async (_l, bad) => {
    const map = await lookupFriendships(postgresLikeFire, TEST_USER_ID, [
      FRIEND,
      bad,
    ]);

    expect(postgresLikeFire).toHaveBeenCalledWith({
      callerId: TEST_USER_ID,
      candidateIds: [FRIEND],
    });
    expect(map?.get(FRIEND)?.status).toBe("FRIEND");
    expect(map?.has(bad)).toBe(false);
  });

  it("several valid + several malformed (+ duplicates): one clean, de-duplicated batch", async () => {
    const map = await lookupFriendships(postgresLikeFire, TEST_USER_ID, [
      FRIEND,
      GROUP_ID,
      FRIEND_2,
      COMMUNITY_ID,
      "undefined",
      "",
      FRIEND,
      INCOMING,
    ]);

    expect(postgresLikeFire).toHaveBeenCalledTimes(1);
    expect(postgresLikeFire.mock.calls[0]![0].candidateIds).toEqual([
      FRIEND,
      FRIEND_2,
      INCOMING,
    ]);
    expect(map?.get(FRIEND)?.status).toBe("FRIEND");
    expect(map?.get(FRIEND_2)?.status).toBe("FRIEND");
    expect(map?.get(INCOMING)?.status).toBe("PENDING");
  });

  it("all malformed: no RPC at all, and an ANSWERED empty map (not a failure)", async () => {
    const map = await lookupFriendships(postgresLikeFire, TEST_USER_ID, [
      GROUP_ID,
      COMMUNITY_ID,
    ]);

    expect(postgresLikeFire).not.toHaveBeenCalled();
    expect(map).toEqual(new Map());
  });

  it("a malformed CALLER id is never sent either", async () => {
    await expect(
      lookupFriendships(postgresLikeFire, GROUP_ID, [FRIEND])
    ).resolves.toEqual(new Map());
    expect(postgresLikeFire).not.toHaveBeenCalled();
  });

  it("a genuine failure is null — never an empty map that reads as NONE", async () => {
    const down = jest.fn(async () => {
      throw grpcError(grpc.status.UNAVAILABLE, "connect ECONNREFUSED");
    });

    await expect(
      lookupFriendships(down, TEST_USER_ID, [FRIEND])
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
describe("checkFriendships breaker — corrupt rooms cannot trip it", () => {
  it("a page with malformed peers, requested over and over, never opens the breaker", async () => {
    const breaker = makeBreaker("test.checkFriendships.malformed", postgresLikeFire);
    const fire = (a: { callerId: string; candidateIds: string[] }) =>
      breaker.fire(a);

    for (let i = 0; i < 30; i += 1) {
      const map = await lookupFriendships(fire, TEST_USER_ID, [
        FRIEND,
        GROUP_ID,
        COMMUNITY_ID,
      ]);
      expect(map?.get(FRIEND)?.status).toBe("FRIEND");
    }
    expect(breaker.opened).toBe(false);
    expect(breaker.stats.failures).toBe(0);
    // A clean user right after is unaffected.
    const clean = await lookupFriendships(fire, TEST_USER_ID, [FRIEND_2]);
    expect(clean?.get(FRIEND_2)?.status).toBe("FRIEND");
  });

  it("a genuine user-service outage still opens it, and lookups report failure (null)", async () => {
    const breaker = makeBreaker("test.checkFriendships.outage", async () => {
      throw grpcError(grpc.status.UNAVAILABLE, "connect ECONNREFUSED");
    });
    const fire = (a: { callerId: string; candidateIds: string[] }) =>
      breaker.fire(a) as Promise<CheckFriendshipsResult>;

    for (let i = 0; i < 10; i += 1) {
      await expect(
        lookupFriendships(fire, TEST_USER_ID, [FRIEND])
      ).resolves.toBeNull();
    }
    expect(breaker.opened).toBe(true);
    breaker.shutdown();
  });
});

// ---------------------------------------------------------------------------
// GET /chat/inbox end to end
// ---------------------------------------------------------------------------
let app: import("express").Express;
let mocks: BuiltMocks;

function privateRoom(roomId: string, peer: string, at: number) {
  return {
    roomId,
    participants: [TEST_USER_ID, peer].sort(),
    lastMessageAt: new Date(at),
    lastMessage: null,
    unreadCountByUser: { [TEST_USER_ID]: 0 },
    mutedBy: {},
    pinnedCount: 0,
  };
}

function pageOf(rooms: ReturnType<typeof privateRoom>[]) {
  mocks.privateRoomRepo.getInboxConversations.mockResolvedValue(rooms);
  mocks.privateRoomRepo.countConversations.mockResolvedValue(rooms.length);
}

async function inboxByRoom() {
  const res = await request(app)
    .get("/api/chat/inbox")
    .set(bearer(makeAccessToken()));
  return {
    res,
    byRoom: Object.fromEntries(
      ((res.body.data?.data ?? []) as {
        roomId: string;
        relationshipStatus: string;
        isFriend: boolean;
        relationship: Record<string, unknown>;
        requesterId: string | null;
      }[]).map((r) => [r.roomId, r])
    ),
  };
}

describe("GET /chat/inbox — relationshipStatus", () => {
  beforeEach(() => {
    ({ app, mocks } = buildApp());
    mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
    mocks.groupMemberRepo.getInboxMemberships.mockResolvedValue([]);
    mocks.groupRoomRepo.getInboxGroups.mockResolvedValue([]);
    mocks.groupRoomRepo.countUserGroups.mockResolvedValue(0);
    // Identity resolves for every real user id (the 535cd0d0 path).
    usersBatch.mockImplementation(async (ids: string[]) =>
      ids.map((userId) => ({
        userId,
        displayName: `User ${userId.slice(0, 4)}`,
        username: "u",
        avatar: "",
        isOnline: false,
        isDeleted: false,
      }))
    );
    // The REAL lookup in front of a Postgres-faithful user-service.
    mocks.friendshipGrpcClient.checkFriendships.mockImplementation(
      (callerId: string, ids: string[]) =>
        lookupFriendships(postgresLikeFire, callerId, ids)
    );
  });

  it("REGRESSION: friend + a corrupt grp_ room on the same page → the friend is FRIEND", async () => {
    pageOf([
      privateRoom("prv_friend", FRIEND, 3000),
      privateRoom("prv_z7VDs7izbESRAZV-", GROUP_ID, 2000),
    ]);

    const { res, byRoom } = await inboxByRoom();

    expect(res.status).toBe(200);
    expect(byRoom.prv_friend).toMatchObject({
      isFriend: true,
      relationshipStatus: "FRIEND",
      relationship: expect.objectContaining({ status: "FRIEND" }),
    });
    // A group id has no relationship — NONE, with no add-friend action.
    expect(byRoom["prv_z7VDs7izbESRAZV-"]).toMatchObject({
      relationshipStatus: "NONE",
      relationship: expect.objectContaining({ canSendRequest: false }),
    });
    for (const [args] of postgresLikeFire.mock.calls) {
      expect(args.candidateIds).not.toContain(GROUP_ID);
    }
  });

  it("friend + a corrupt community-ObjectId room → the friend is FRIEND", async () => {
    pageOf([
      privateRoom("prv_friend", FRIEND, 3000),
      privateRoom("prv_comm", COMMUNITY_ID, 2000),
    ]);

    const { res, byRoom } = await inboxByRoom();

    expect(res.status).toBe(200);
    expect(byRoom.prv_friend.relationshipStatus).toBe("FRIEND");
  });

  it("several valid peers + several malformed rooms → each valid peer resolves on its own", async () => {
    pageOf([
      privateRoom("prv_f1", FRIEND, 9000),
      privateRoom("prv_bad1", GROUP_ID, 8000),
      privateRoom("prv_f2", FRIEND_2, 7000),
      privateRoom("prv_bad2", COMMUNITY_ID, 6000),
      privateRoom("prv_in", INCOMING, 5000),
      privateRoom("prv_out", OUTGOING, 4000),
      privateRoom("prv_none", STRANGER, 3000),
    ]);

    const { res, byRoom } = await inboxByRoom();

    expect(res.status).toBe(200);
    expect(byRoom.prv_f1.relationshipStatus).toBe("FRIEND");
    expect(byRoom.prv_f2.relationshipStatus).toBe("FRIEND");
    // Pending INCOMING: the viewer can accept/reject, requester is the peer.
    expect(byRoom.prv_in).toMatchObject({
      relationshipStatus: "PENDING",
      requesterId: INCOMING,
      relationship: expect.objectContaining({
        direction: "INCOMING",
        canAccept: true,
        canReject: true,
        canCancel: false,
      }),
    });
    // Pending OUTGOING: the viewer can only cancel.
    expect(byRoom.prv_out).toMatchObject({
      relationshipStatus: "PENDING",
      requesterId: TEST_USER_ID,
      relationship: expect.objectContaining({
        direction: "OUTGOING",
        canCancel: true,
        canAccept: false,
      }),
    });
    // A successful lookup with no record is a genuine NONE.
    expect(byRoom.prv_none).toMatchObject({
      isFriend: false,
      relationshipStatus: "NONE",
    });
  });

  it("every peer on the page malformed → no friendship RPC, inbox still 200", async () => {
    pageOf([
      privateRoom("prv_bad1", GROUP_ID, 2000),
      privateRoom("prv_bad2", COMMUNITY_ID, 1000),
    ]);

    const { res, byRoom } = await inboxByRoom();

    expect(res.status).toBe(200);
    expect(postgresLikeFire).not.toHaveBeenCalled();
    expect(byRoom.prv_bad1.relationshipStatus).toBe("NONE");
  });

  it("the friendship RPC genuinely fails → retryable 503, never a fake NONE", async () => {
    pageOf([privateRoom("prv_friend", FRIEND, 3000)]);
    mocks.friendshipGrpcClient.checkFriendships.mockResolvedValue(null);

    const { res } = await inboxByRoom();

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: "CHAT_RELATIONSHIP_UNAVAILABLE",
      retryable: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('"relationshipStatus"');
  });

  it("the same failure on room details (GET /rooms/:roomId) is a 503 too", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      ...privateRoom("prv_friend", FRIEND, 3000),
      createdAt: new Date(500),
      updatedAt: new Date(1500),
    });
    mocks.friendshipGrpcClient.checkFriendships.mockResolvedValue(null);

    const res = await request(app)
      .get("/api/chat/private/rooms/prv_friend")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("CHAT_RELATIONSHIP_UNAVAILABLE");
  });
});
