/**
 * Integration tests — unified inbox.
 * Route: GET /api/chat/inbox  (authenticate + per-user rate-limit + Zod query)
 *
 * The inbox merges private rooms + group chats in-memory. We drive both sides
 * through their repositories and assert the merged/sorted/paginated envelope.
 */
import request from "supertest";

import {
  buildApp,
  mockGroupMemberships,
  type BuiltMocks,
} from "../helpers/app-factory.js";
import {
  bearer,
  makeAccessToken,
  makeForgedAccessToken,
  TEST_USER_ID,
} from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

beforeEach(() => {
  ({ app, mocks } = buildApp());
});

const BASE = "/api/chat/inbox";

/** Default the group side to empty so private-only tests are isolated. */
function emptyGroupSide(): void {
  mockGroupMemberships(mocks, []);
  mocks.groupMemberRepo.getActiveRoomIds.mockResolvedValue([]);
  mocks.groupRoomRepo.countUserGroups.mockResolvedValue(0);
}

describe("GET /api/chat/inbox", () => {
  it("POSITIVE: returns merged private+group items, newest-first by lastMessageAt", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      {
        roomId: "prv_1",
        participants: [TEST_USER_ID, "peer-1"],
        lastMessageAt: new Date(2000),
        lastMessageId: "m2",
        unreadCountByUser: { [TEST_USER_ID]: 3 },
        mutedBy: {},
        pinnedCount: 0,
      },
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(1);

    mockGroupMemberships(mocks, [
      {
        roomId: "grp_1",
        role: "MEMBER",
        unreadCount: 1,
        notificationSettings: {},
      },
    ]);
    mocks.groupMemberRepo.getActiveRoomIds.mockResolvedValue(["grp_1"]);
    mocks.groupRoomRepo.getInboxGroups.mockResolvedValue([
      {
        roomId: "grp_1",
        name: "Devs",
        avatar: "",
        description: "",
        memberCount: 5,
        lastMessageAt: new Date(3000),
        lastMessageId: "g9",
        pinnedCount: 0,
      },
    ]);
    mocks.groupRoomRepo.countUserGroups.mockResolvedValue(1);
    mocks.groupRoomRepo.findLastMessageAtForRooms.mockResolvedValue([
      { roomId: "grp_1", lastMessageAt: new Date(3000) },
    ]);

    // user snapshot fan-out resolves from cache (empty) → placeholder peer.
    mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());

    const res = await request(app).get(BASE).set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const items = res.body.data.data;
    expect(items).toHaveLength(2);
    // Group (ts 3000) sorts before private (ts 2000) in default "before".
    expect(items[0].type).toBe("GROUP");
    expect(items[0].roomId).toBe("grp_1");
    expect(items[1].type).toBe("PRIVATE");
    expect(items[1].unreadCount).toBe(3);
    expect(res.body.data.pagination.totalData).toBe(2);
  });

  it("MEDIA: resolves the group avatar object key on the inbox item", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(0);
    mockGroupMemberships(mocks, [
      {
        roomId: "grp_1",
        role: "MEMBER",
        unreadCount: 0,
        notificationSettings: {},
      },
    ]);
    mocks.groupMemberRepo.getActiveRoomIds.mockResolvedValue(["grp_1"]);
    mocks.groupRoomRepo.getInboxGroups.mockResolvedValue([
      {
        roomId: "grp_1",
        name: "Devs",
        avatar: "group-avatars/grp_1/logo.png",
        lastMessageAt: new Date(3000),
        lastMessageId: "g9",
        pinnedCount: 0,
      },
    ]);
    mocks.groupRoomRepo.countUserGroups.mockResolvedValue(1);
    mocks.groupRoomRepo.findLastMessageAtForRooms.mockResolvedValue([
      { roomId: "grp_1", lastMessageAt: new Date(3000) },
    ]);
    mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());

    const res = await request(app).get(BASE).set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const group = res.body.data.data.find(
      (i: { type: string }) => i.type === "GROUP"
    );
    expect(group.avatar).toBe(
      "https://media.test/aimess-avatars/group-avatars/grp_1/logo.png"
    );
  });

  it("EDGE: both sides empty → 200 with empty list", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(0);
    emptyGroupSide();

    const res = await request(app).get(BASE).set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toEqual([]);
    expect(res.body.data.pagination.totalData).toBe(0);
  });

  it("EDGE: after_ts switches direction to oldest-first", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(0);
    emptyGroupSide();

    await request(app)
      .get(`${BASE}?after_ts=1000&limit=10`)
      .set(bearer(makeAccessToken()));

    expect(mocks.privateRoomRepo.getInboxConversations).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "after", limit: 11 })
    );
  });

  it("NEGATIVE: 400 when both before_ts and after_ts are supplied", async () => {
    const res = await request(app)
      .get(`${BASE}?before_ts=1000&after_ts=2000`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("NEGATIVE: 400 when limit exceeds the max (100)", async () => {
    const res = await request(app)
      .get(`${BASE}?limit=500`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 400 for a non-numeric before_ts", async () => {
    const res = await request(app)
      .get(`${BASE}?before_ts=abc`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get(BASE);
    expect(res.status).toBe(401);
  });

  it("SECURITY: 401 for a forged token", async () => {
    const res = await request(app)
      .get(BASE)
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
  });
});
