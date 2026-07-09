jest.mock("../../src/repositories/recent-user-search.repository.js", () => ({
  recentUserSearchRepository: {
    findByUserId: jest.fn(async () => []),
    upsert: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUserIds: jest.fn(async () => []),
    findUsersInList: jest.fn(async () => []),
    countUsersInList: jest.fn(async () => 0),
    findUsersNotInList: jest.fn(async () => []),
    countUsersNotInList: jest.fn(async () => 0),
  },
}));
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    findAllBlocks: jest.fn(async () => []),
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
  pRepo.findByUserIds.mockResolvedValue([]);
  pRepo.findUsersInList.mockResolvedValue([]);
  pRepo.findUsersNotInList.mockResolvedValue([]);
  friendRepo.findAllBlocks.mockResolvedValue([]);
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
    await request(app)
      .post("/api/v1/users/search/recent")
      .set(auth())
      .send({
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
  it("returns empty recent/chat/other with no data", async () => {
    const res = await request(app).get("/api/v1/users/search").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ recent: [], chat: [], other: [] });
  });

  it("returns a Recent USER entry with roomId resolved dynamically", async () => {
    recentRepo.findByUserId.mockResolvedValue([recentUserRow()]);
    pRepo.findByUserIds.mockResolvedValue([profile(PEER_ID)]);
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

  it("excludes a blocked user from Recent even if it was viewed before", async () => {
    recentRepo.findByUserId.mockResolvedValue([recentUserRow()]);
    pRepo.findByUserIds.mockResolvedValue([profile(PEER_ID)]);
    friendRepo.findAllBlocks.mockResolvedValue([
      { blockerId: TEST_USER_ID, blockedId: PEER_ID },
    ]);

    const res = await request(app).get("/api/v1/users/search").set(auth());

    expect(res.body.data.recent).toEqual([]);
  });

  it("puts users with an existing room into Chat, and groups actively joined into Chat", async () => {
    grpc.listPrivateRoomPeers.mockResolvedValue([
      { peerUserId: PEER_ID, roomId: "room_abc" },
    ]);
    pRepo.findUsersInList.mockResolvedValue([profile(PEER_ID)]);
    grpc.listActiveGroups.mockResolvedValue([
      groupSummary({ isActiveMember: true }),
    ]);

    const res = await request(app).get("/api/v1/users/search").set(auth());

    expect(res.body.data.chat).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "USER",
          userId: PEER_ID,
          roomId: "room_abc",
        }),
        expect.objectContaining({
          type: "GROUP",
          roomId: GROUP_ID,
          isActiveMember: true,
        }),
      ])
    );
  });

  it("puts users without a room into Other, and non-member groups into Other", async () => {
    pRepo.findUsersNotInList.mockResolvedValue([profile(OTHER_ID)]);
    grpc.listOtherGroups.mockResolvedValue([groupSummary()]);

    const res = await request(app).get("/api/v1/users/search").set(auth());

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

  it("excludes users that already have a room from the Other user query", async () => {
    grpc.listPrivateRoomPeers.mockResolvedValue([
      { peerUserId: PEER_ID, roomId: "room_abc" },
    ]);

    await request(app).get("/api/v1/users/search").set(auth());

    const excludeArg = pRepo.findUsersNotInList.mock.calls[0][0];
    expect(excludeArg).toEqual(expect.arrayContaining([TEST_USER_ID, PEER_ID]));
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
      expect.any(Number)
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
});
