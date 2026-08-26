jest.mock("../../src/repositories/recent-user-search.repository.js", () => ({
  recentUserSearchRepository: {
    findByUserId: jest.fn(async () => []),
    upsert: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUserIds: jest.fn(async () => []),
    findDiscoverableByUserIds: jest.fn(async () => []),
    findUsersInList: jest.fn(async () => []),
    countUsersInList: jest.fn(async () => 0),
    findUsersNotInList: jest.fn(async () => []),
    countUsersNotInList: jest.fn(async () => 0),
  },
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
  avatarService: {
    resolveViewUrlForClient: jest.fn(async () => null),
  },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { recentUserSearchRepository } from "../../src/repositories/recent-user-search.repository.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { messagingGrpcClient } from "../../src/grpc/messaging.client.js";
import {
  TEST_USER_ID,
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
} from "../helpers/auth.js";

const recentRepo = recentUserSearchRepository as unknown as Record<
  string,
  jest.Mock
>;
const pRepo = userProfileRepository as unknown as Record<string, jest.Mock>;
const friendRepo = friendshipRepository as unknown as Record<string, jest.Mock>;
const grpc = messagingGrpcClient as unknown as Record<string, jest.Mock>;

const auth = () => bearer(makeAccessToken());

const PEER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GROUP_ID = "room_group123";

function profile(userId: string, overrides = {}) {
  return {
    userId,
    username: "janedoe",
    firstName: "Jane",
    lastName: "Doe",
    avatarUrl: null,
    isOnline: false,
    ...overrides,
  };
}

function groupSummary(overrides = {}) {
  return {
    roomId: GROUP_ID,
    name: "Test Group",
    avatar: "",
    description: "",
    memberCount: 3,
    isActiveMember: false,
    lastMessageAt: 0,
    createdAt: 0,
    ...overrides,
  };
}

function recentUserRow(overrides = {}) {
  return {
    id: "row-1",
    userId: TEST_USER_ID,
    targetType: "USER",
    targetId: PEER_ID,
    lastViewedAt: new Date("2026-07-09T10:00:00Z"),
    createdAt: new Date("2026-07-09T10:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  recentRepo.findByUserId.mockResolvedValue([]);
  recentRepo.upsert.mockResolvedValue(undefined);
  pRepo.findDiscoverableByUserIds.mockResolvedValue([]);
  pRepo.findUsersInList.mockResolvedValue([]);
  pRepo.findUsersNotInList.mockResolvedValue([]);
  friendRepo.findAllBlocks.mockResolvedValue([]);
  friendRepo.findAllForUser.mockResolvedValue([]);
  // `clearAllMocks` clears calls, NOT implementations — without an explicit
  // reset a `mockResolvedValue` set by one test leaks into every later one.
  friendRepo.resolveViewerGraph.mockResolvedValue({
    friendIds: [],
    friendOfFriendIds: [],
  });
  friendRepo.hasMutualFriend.mockResolvedValue(false);
  grpc.resolvePrivateRooms.mockResolvedValue([]);
  grpc.listPrivateRoomPeers.mockResolvedValue([]);
  grpc.listActiveGroups.mockResolvedValue([]);
  grpc.listOtherGroups.mockResolvedValue([]);
  grpc.getGroupsByIds.mockResolvedValue([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/users/search/recent
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/users/search/recent", () => {
  it("upserts a USER target", async () => {
    const res = await request(app)
      .post("/api/v1/users/search/recent")
      .set(auth())
      .send({ targetType: "USER", targetId: PEER_ID });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(recentRepo.upsert).toHaveBeenCalledWith({
      userId: TEST_USER_ID,
      targetType: "USER",
      targetId: PEER_ID,
    });
  });

  it("upserts a GROUP target", async () => {
    const res = await request(app)
      .post("/api/v1/users/search/recent")
      .set(auth())
      .send({ targetType: "GROUP", targetId: GROUP_ID });

    expect(res.status).toBe(201);
    expect(recentRepo.upsert).toHaveBeenCalledWith({
      userId: TEST_USER_ID,
      targetType: "GROUP",
      targetId: GROUP_ID,
    });
  });

  it("never persists a roomId — only targetType/targetId reach the repository", async () => {
    await request(app).post("/api/v1/users/search/recent").set(auth()).send({
      targetType: "USER",
      targetId: PEER_ID,
      roomId: "room_should_be_ignored",
    });

    const call = recentRepo.upsert.mock.calls[0][0];
    expect(call).not.toHaveProperty("roomId");
  });

  it("returns 400 for an invalid targetType", async () => {
    const res = await request(app)
      .post("/api/v1/users/search/recent")
      .set(auth())
      .send({ targetType: "COMMUNITY", targetId: PEER_ID });

    expect(res.status).toBe(400);
  });

  it("returns 400 when targetId is missing", async () => {
    const res = await request(app)
      .post("/api/v1/users/search/recent")
      .set(auth())
      .send({ targetType: "USER" });

    expect(res.status).toBe(400);
  });

  it("returns 401 without token", async () => {
    const res = await request(app)
      .post("/api/v1/users/search/recent")
      .send({ targetType: "USER", targetId: PEER_ID });
    expect(res.status).toBe(401);
  });

  it("returns 401 with expired token", async () => {
    const res = await request(app)
      .post("/api/v1/users/search/recent")
      .set(bearer(makeExpiredAccessToken()))
      .send({ targetType: "USER", targetId: PEER_ID });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/users/search
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/users/search", () => {
  it("returns only `recent` when q is empty", async () => {
    const res = await request(app).get("/api/v1/users/search").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ recent: [] });
  });

  it("returns only `recent` when q is whitespace-only", async () => {
    const res = await request(app)
      .get("/api/v1/users/search")
      .query({ q: "   " })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ recent: [] });
  });

  it("returns only `chat`/`other` (no `recent`) when q has a value", async () => {
    const res = await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ chat: [], other: [] });
  });

  it("returns a Recent USER entry with roomId resolved dynamically", async () => {
    recentRepo.findByUserId.mockResolvedValue([recentUserRow()]);
    pRepo.findDiscoverableByUserIds.mockResolvedValue([profile(PEER_ID)]);
    grpc.resolvePrivateRooms.mockResolvedValue([
      { peerUserId: PEER_ID, roomId: "room_abc" },
    ]);

    const res = await request(app).get("/api/v1/users/search").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.recent).toHaveLength(1);
    expect(res.body.data.recent[0]).toMatchObject({
      type: "USER",
      userId: PEER_ID,
      roomId: "room_abc",
    });
  });

  it("returns a Recent GROUP entry resolved via chat-service", async () => {
    recentRepo.findByUserId.mockResolvedValue([
      recentUserRow({
        id: "row-2",
        targetType: "GROUP",
        targetId: GROUP_ID,
      }),
    ]);
    grpc.getGroupsByIds.mockResolvedValue([groupSummary()]);

    const res = await request(app).get("/api/v1/users/search").set(auth());

    expect(res.body.data.recent).toHaveLength(1);
    expect(res.body.data.recent[0]).toMatchObject({
      type: "GROUP",
      roomId: GROUP_ID,
    });
  });

  it("drops a Recent GROUP entry that no longer exists", async () => {
    recentRepo.findByUserId.mockResolvedValue([
      recentUserRow({
        id: "row-2",
        targetType: "GROUP",
        targetId: GROUP_ID,
      }),
    ]);
    grpc.getGroupsByIds.mockResolvedValue([]); // group deleted/disbanded

    const res = await request(app).get("/api/v1/users/search").set(auth());

    expect(res.body.data.recent).toEqual([]);
  });

  it("excludes a user who BLOCKED the viewer from Recent even if it was viewed before", async () => {
    recentRepo.findByUserId.mockResolvedValue([recentUserRow()]);
    pRepo.findDiscoverableByUserIds.mockResolvedValue([profile(PEER_ID)]);
    friendRepo.findAllBlocks.mockResolvedValue([
      { blockerId: PEER_ID, blockedId: TEST_USER_ID },
    ]);

    const res = await request(app).get("/api/v1/users/search").set(auth());

    expect(res.body.data.recent).toEqual([]);
  });

  it("keeps a user the VIEWER blocked in Recent, flagged isBlockedByMe (one-way)", async () => {
    recentRepo.findByUserId.mockResolvedValue([recentUserRow()]);
    pRepo.findDiscoverableByUserIds.mockResolvedValue([profile(PEER_ID)]);
    friendRepo.findAllBlocks.mockResolvedValue([
      { blockerId: TEST_USER_ID, blockedId: PEER_ID },
    ]);

    const res = await request(app).get("/api/v1/users/search").set(auth());

    expect(res.body.data.recent).toHaveLength(1);
    expect(res.body.data.recent[0]).toMatchObject({
      userId: PEER_ID,
      isBlockedByMe: true,
    });
  });

  it("puts an accepted friend with an existing room into Chat, and groups actively joined into Chat", async () => {
    grpc.listPrivateRoomPeers.mockResolvedValue([
      { peerUserId: PEER_ID, roomId: "room_abc" },
    ]);
    friendRepo.findAllForUser.mockResolvedValue([
      {
        id: "fr-1",
        requesterId: TEST_USER_ID,
        addresseeId: PEER_ID,
        status: "ACCEPTED",
      },
    ]);
    pRepo.findUsersInList.mockResolvedValue([profile(PEER_ID)]);
    grpc.listActiveGroups.mockResolvedValue([
      groupSummary({ isActiveMember: true }),
    ]);

    const res = await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    expect(res.body.data.chat).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "USER",
          userId: PEER_ID,
          roomId: "room_abc",
          isFriend: true,
        }),
        expect.objectContaining({
          type: "GROUP",
          roomId: GROUP_ID,
          isActiveMember: true,
        }),
      ])
    );
  });

  it("puts an accepted friend without a room into Chat (isFriend, not roomId, drives Chat)", async () => {
    friendRepo.findAllForUser.mockResolvedValue([
      {
        id: "fr-1",
        requesterId: TEST_USER_ID,
        addresseeId: PEER_ID,
        status: "ACCEPTED",
      },
    ]);
    pRepo.findUsersInList.mockResolvedValue([profile(PEER_ID)]);

    const res = await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    expect(res.body.data.chat).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "USER",
          userId: PEER_ID,
          roomId: null,
          isFriend: true,
        }),
      ])
    );
  });

  it("puts a non-friend with an existing room into Other, carrying the roomId (unfriended peer)", async () => {
    grpc.listPrivateRoomPeers.mockResolvedValue([
      { peerUserId: PEER_ID, roomId: "room_abc" },
    ]);
    pRepo.findUsersNotInList.mockResolvedValue([profile(PEER_ID)]);

    const res = await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    expect(res.body.data.other).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "USER",
          userId: PEER_ID,
          roomId: "room_abc",
          isFriend: false,
        }),
      ])
    );
    expect(res.body.data.chat).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: PEER_ID })])
    );
  });

  it("puts a non-friend without a room into Other, and non-member groups into Other", async () => {
    pRepo.findUsersNotInList.mockResolvedValue([profile(OTHER_ID)]);
    grpc.listOtherGroups.mockResolvedValue([groupSummary()]);

    const res = await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    expect(res.body.data.other).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "USER",
          userId: OTHER_ID,
          roomId: null,
        }),
        expect.objectContaining({
          type: "GROUP",
          roomId: GROUP_ID,
          isActiveMember: false,
        }),
      ])
    );
  });

  it("puts a pending (outgoing) request with a room into Other, not Chat", async () => {
    grpc.listPrivateRoomPeers.mockResolvedValue([
      { peerUserId: PEER_ID, roomId: "room_abc" },
    ]);
    friendRepo.findAllForUser.mockResolvedValue([
      {
        id: "fr-2",
        requesterId: TEST_USER_ID,
        addresseeId: PEER_ID,
        status: "PENDING",
      },
    ]);
    pRepo.findUsersNotInList.mockResolvedValue([profile(PEER_ID)]);

    const res = await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    expect(res.body.data.other).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: PEER_ID,
          roomId: "room_abc",
          isFriend: false,
          relationshipStatus: "PENDING",
        }),
      ])
    );
    expect(res.body.data.chat).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: PEER_ID })])
    );
  });

  it("puts a rejected friend request with a room into Other, not Chat", async () => {
    grpc.listPrivateRoomPeers.mockResolvedValue([
      { peerUserId: PEER_ID, roomId: "room_abc" },
    ]);
    friendRepo.findAllForUser.mockResolvedValue([
      {
        id: "fr-3",
        requesterId: PEER_ID,
        addresseeId: TEST_USER_ID,
        status: "REJECTED",
      },
    ]);
    pRepo.findUsersNotInList.mockResolvedValue([profile(PEER_ID)]);

    const res = await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    expect(res.body.data.other).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: PEER_ID,
          roomId: "room_abc",
          isFriend: false,
          relationshipStatus: "NONE",
        }),
      ])
    );
    expect(res.body.data.chat).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: PEER_ID })])
    );
  });

  it("marks a friend without a room as isFriend in Other (independent of roomId)", async () => {
    pRepo.findUsersNotInList.mockResolvedValue([profile(OTHER_ID)]);
    friendRepo.findAllForUser.mockResolvedValue([
      {
        id: "fr-1",
        requesterId: TEST_USER_ID,
        addresseeId: OTHER_ID,
        status: "ACCEPTED",
      },
    ]);

    const res = await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    expect(res.body.data.other[0]).toMatchObject({
      userId: OTHER_ID,
      roomId: null,
      isFriend: true,
      relationshipStatus: "FRIEND",
      friendshipId: "fr-1",
    });
  });

  it("labels a stranger as isFriend:false / NONE", async () => {
    pRepo.findUsersNotInList.mockResolvedValue([profile(OTHER_ID)]);

    const res = await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    expect(res.body.data.other[0]).toMatchObject({
      userId: OTHER_ID,
      roomId: null,
      isFriend: false,
      relationshipStatus: "NONE",
      friendshipId: null,
    });
  });

  it("reflects a pending outgoing request as PENDING with requesterId=self", async () => {
    pRepo.findUsersNotInList.mockResolvedValue([profile(OTHER_ID)]);
    friendRepo.findAllForUser.mockResolvedValue([
      {
        id: "fr-2",
        requesterId: TEST_USER_ID,
        addresseeId: OTHER_ID,
        status: "PENDING",
      },
    ]);

    const res = await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    expect(res.body.data.other[0]).toMatchObject({
      isFriend: false,
      relationshipStatus: "PENDING",
      friendshipId: "fr-2",
      requesterId: TEST_USER_ID,
    });
  });

  it("excludes accepted friends (not room peers) from the Other user query", async () => {
    friendRepo.findAllForUser.mockResolvedValue([
      {
        id: "fr-1",
        requesterId: TEST_USER_ID,
        addresseeId: PEER_ID,
        status: "ACCEPTED",
      },
    ]);

    await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    const excludeArg = pRepo.findUsersNotInList.mock.calls[0][0];
    expect(excludeArg).toEqual(expect.arrayContaining([TEST_USER_ID, PEER_ID]));
  });

  it("does NOT exclude a non-friend room peer from the Other user query", async () => {
    grpc.listPrivateRoomPeers.mockResolvedValue([
      { peerUserId: PEER_ID, roomId: "room_abc" },
    ]);

    await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    const excludeArg = pRepo.findUsersNotInList.mock.calls[0][0];
    expect(excludeArg).not.toEqual(expect.arrayContaining([PEER_ID]));
  });

  it("passes q through to every section's search", async () => {
    await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    expect(pRepo.findUsersNotInList).toHaveBeenCalledWith(
      expect.any(Array),
      "jane",
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ friendIds: expect.any(Array) })
    );
    expect(grpc.listOtherGroups).toHaveBeenCalledWith(
      TEST_USER_ID,
      "jane",
      expect.any(Array),
      expect.any(Number)
    );
  });

  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/v1/users/search");
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // `whoCanSendFriendRequests` — the row stays discoverable, the ACTION does
  // not. Decided by `canSendFriendRequest` (see
  // tests/friendship/friend-request-eligibility.test.ts for the full matrix);
  // this pins that user search actually carries the answer.
  // -------------------------------------------------------------------------
  const withRequestScope = (scope: string) =>
    profile(OTHER_ID, {
      privacySettings: {
        whoCanViewProfile: "EVERYONE",
        whoCanSeeOnlineStatus: "EVERYONE",
        whoCanSendFriendRequests: scope,
      },
    });

  const searchOther = async () => {
    const res = await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());
    return res.body.data.other[0];
  };

  it("EVERYONE → the stranger row offers the add action", async () => {
    pRepo.findUsersNotInList.mockResolvedValue([withRequestScope("EVERYONE")]);

    const row = await searchOther();

    expect(row).toMatchObject({
      userId: OTHER_ID,
      relationshipStatus: "NONE",
      canSendRequest: true,
    });
    expect(row.relationship.canSendRequest).toBe(true);
  });

  it("NO_ONE → the row is still returned, without the add action", async () => {
    pRepo.findUsersNotInList.mockResolvedValue([withRequestScope("NO_ONE")]);

    const row = await searchOther();

    // Still discoverable — `whoCanFindMe` governs that, not this scope.
    expect(row.userId).toBe(OTHER_ID);
    expect(row.username).toBe("janedoe");
    expect(row.canSendRequest).toBe(false);
    expect(row.relationship.canSendRequest).toBe(false);
  });

  it("FRIENDS → a stranger gets no add action", async () => {
    pRepo.findUsersNotInList.mockResolvedValue([withRequestScope("FRIENDS")]);

    expect((await searchOther()).canSendRequest).toBe(false);
  });

  it("FRIENDS_OF_FRIENDS → admits a viewer sharing a mutual friend", async () => {
    pRepo.findUsersNotInList.mockResolvedValue([
      withRequestScope("FRIENDS_OF_FRIENDS"),
    ]);
    // The one-hop set the search already resolves for `whoCanFindMe` is reused
    // here — no second traversal, no per-row query.
    friendRepo.resolveViewerGraph.mockResolvedValue({
      friendIds: [],
      friendOfFriendIds: [OTHER_ID],
    });

    expect((await searchOther()).canSendRequest).toBe(true);
  });

  it("FRIENDS_OF_FRIENDS → refuses a viewer with no mutual friend", async () => {
    pRepo.findUsersNotInList.mockResolvedValue([
      withRequestScope("FRIENDS_OF_FRIENDS"),
    ]);

    expect((await searchOther()).canSendRequest).toBe(false);
  });

  it("never leaks the target's raw privacy scope in a search row", async () => {
    pRepo.findUsersNotInList.mockResolvedValue([withRequestScope("NO_ONE")]);

    const res = await request(app)
      .get("/api/v1/users/search")
      .query({ q: "jane" })
      .set(auth());

    expect(JSON.stringify(res.body)).not.toContain("whoCanSendFriendRequests");
    expect(JSON.stringify(res.body)).not.toContain("NO_ONE");
  });
});
