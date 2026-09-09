/**
 * A peer the viewer already chats with stays findable by name, whatever their
 * `whoCanFindMe` says.
 *
 * The "Chats" bucket is accepted friends only, so a DM with a NON-friend
 * reaches search through `other` — which applies `discoverableWhere`. A peer
 * who had set `NO_ONE` therefore vanished from search while their conversation
 * sat in the inbox: exactly the two-doors-disagree bug the block carve-out
 * (`hiddenWithoutRoom`) already fixed, one gate over.
 *
 * The carve-out covers the ROW only — presence and the friend-request action
 * keep their own scopes — and blocks keep priority.
 */
const findMany = jest.fn().mockResolvedValue([]);
/** The exact-`@handle` head. Answers nothing here — these cases search a NAME. */
const findFirst = jest.fn().mockResolvedValue(null);

jest.mock("../../src/config/prisma.js", () => ({
  prisma: { userProfile: { findMany, findFirst } },
}));
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    resolveViewerGraph: jest.fn(async () => ({
      friendIds: [],
      friendOfFriendIds: [],
    })),
    hasMutualFriend: jest.fn(async () => false),
    findAllBlocks: jest.fn(async () => []),
    findAllForUser: jest.fn(async () => []),
  },
}));
jest.mock("../../src/services/avatar.service.js", () => ({
  avatarService: { resolveViewUrlForClient: jest.fn(async () => null) },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { messagingGrpcClient } from "../../src/grpc/messaging.client.js";
import { discoverableWhere } from "../../src/lib/privacy-scope.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

const friendRepo = friendshipRepository as unknown as Record<string, jest.Mock>;
const grpc = messagingGrpcClient as unknown as Record<string, jest.Mock>;

const auth = () => bearer(makeAccessToken());

const PEER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** Blocks are one-way: BLOCKER blocked TEST_USER_ID. */
const BLOCKER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROOM = "prv_shared";
const GRAPH = { friendIds: [], friendOfFriendIds: [] };

/**
 * A row that hides from search and refuses requests and presence. `whoCanFindMe`
 * is enforced by the QUERY, never by the mapper — it is carried here to say what
 * this row is, not because the service reads it.
 */
const hiddenProfile = (userId: string) => ({
  userId,
  username: "janedoe",
  firstName: "Jane",
  lastName: "Doe",
  avatarUrl: null,
  isOnline: true,
  privacySettings: {
    whoCanFindMe: "NO_ONE",
    whoCanSeeOnlineStatus: "FRIENDS",
    whoCanSendFriendRequests: "FRIENDS",
  },
});

const searchWhere = () => findMany.mock.calls[0]![0].where;
/** One search token and no cursor, so the discovery clause is the last AND. */
const discoveryClause = () => searchWhere().AND.at(-1);

const search = () =>
  request(app).get("/api/v1/users/search?q=jane").set(auth());

beforeEach(() => {
  findMany.mockResolvedValue([]);
  friendRepo.findAllBlocks.mockResolvedValue([]);
  friendRepo.findAllForUser.mockResolvedValue([]);
  friendRepo.resolveViewerGraph.mockResolvedValue(GRAPH);
  friendRepo.hasMutualFriend.mockResolvedValue(false);
  grpc.listPrivateRoomPeers.mockResolvedValue([]);
  grpc.listActiveGroups.mockResolvedValue([]);
  grpc.listOtherGroups.mockResolvedValue([]);
});

describe("GET /api/v1/users/search?q= — whoCanFindMe vs. an existing DM", () => {
  it("exempts a private-room peer from the discovery gate", async () => {
    grpc.listPrivateRoomPeers.mockResolvedValue([
      { peerUserId: PEER, roomId: ROOM },
    ]);
    findMany.mockResolvedValue([hiddenProfile(PEER)]);

    const res = await search();

    expect(res.status).toBe(200);
    // The gate is the `where`: with the peer ORed in, a `NO_ONE` row matches.
    expect(discoveryClause()).toEqual({
      OR: [discoverableWhere(GRAPH), { userId: { in: [PEER] } }],
    });
    const row = res.body.data.other[0];
    expect(row.userId).toBe(PEER);
    expect(row.roomId).toBe(ROOM);
    // A room makes the ROW findable — never the actions, never the presence.
    expect(row.canSendRequest).toBe(false);
    expect(row.isOnline).toBe(false);
  });

  it("leaves the gate closed for a peer with no conversation", async () => {
    await search();

    // No exemption clause at all, so the same `NO_ONE` row cannot match.
    expect(discoveryClause()).toEqual(discoverableWhere(GRAPH));
  });

  it("keeps a blocker with no conversation excluded and unexempted", async () => {
    friendRepo.findAllBlocks.mockResolvedValue([
      { blockerId: BLOCKER, blockedId: TEST_USER_ID },
    ]);

    await search();

    expect(searchWhere().userId.notIn).toContain(BLOCKER);
    expect(discoveryClause()).toEqual(discoverableWhere(GRAPH));
  });

  it("leaves a blocker with a conversation on today's flags", async () => {
    friendRepo.findAllBlocks.mockResolvedValue([
      { blockerId: BLOCKER, blockedId: TEST_USER_ID },
    ]);
    grpc.listPrivateRoomPeers.mockResolvedValue([
      { peerUserId: BLOCKER, roomId: ROOM },
    ]);
    findMany.mockResolvedValue([hiddenProfile(BLOCKER)]);

    const res = await search();

    expect(searchWhere().userId.notIn).not.toContain(BLOCKER);
    const row = res.body.data.other[0];
    expect(row.isBlockedByPeer).toBe(true);
    expect(row.isBlockedByMe).toBe(false);
    expect(row.isOnline).toBe(false);
    expect(row.canSendRequest).toBe(false);
  });
});
