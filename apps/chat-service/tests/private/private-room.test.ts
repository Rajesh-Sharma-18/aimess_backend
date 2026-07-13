/**
 * Integration tests — private rooms (1:1 conversations).
 * Routes (apps/chat-service/src/api/routes/private-message.routes.ts):
 *   GET    /api/chat/private/conversations
 *   POST   /api/chat/private/rooms/:peerId          (get-or-create; friendship-gated)
 *   DELETE /api/chat/private/rooms/:roomId          (delete-for-me)
 *   POST   /api/chat/private/rooms/:roomId/mute
 *   POST   /api/chat/private/rooms/:roomId/unmute
 *   PATCH  /api/chat/private/rooms/:roomId/archive
 *   PATCH  /api/chat/private/rooms/:roomId/unarchive
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
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
  // Most room reads enrich peers from the snapshot cache; default to empty.
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("GET /api/chat/private/conversations", () => {
  it("POSITIVE: returns enriched, paginated conversations for the caller", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      {
        roomId: "prv_1",
        participants: [TEST_USER_ID, "peer-1"],
        lastMessageAt: new Date(1000),
        lastMessage: null,
        unreadCountByUser: { [TEST_USER_ID]: 3 },
        mutedBy: {},
        pinnedCount: 0,
      },
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(1);

    const res = await request(app)
      .get("/api/chat/private/conversations")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.data).toHaveLength(1);
    expect(res.body.data.data[0].peerId).toBe("peer-1");
    // Community-style additive fields.
    expect(res.body.data.data[0].unreadMessageCount).toBe(3);
    expect(typeof res.body.data.data[0].lastActivityAt).toBe("number");
    expect(res.body.data.data[0].lastActivity).toMatchObject({
      type: "message",
    });
    expect(res.body.data.data[0].avatar).toBeDefined();
    // Peer fields are flattened onto the item — no nested `peer` object.
    expect(res.body.data.data[0].peer).toBeUndefined();
    // No top-level pagination duplicates — only nested under `pagination`.
    expect(res.body.data.hasMore).toBeUndefined();
    expect(res.body.data.nextCursor).toBeUndefined();
  });

  it("EDGE: empty conversation list → 200 with empty data", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(0);

    const res = await request(app)
      .get("/api/chat/private/conversations")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toEqual([]);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get("/api/chat/private/conversations");
    expect(res.status).toBe(401);
  });

  it("PAGINATION: hasMore is exact (over-fetch by limit+1), matching community's listMine contract", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      roomId: `prv_${i}`,
      participants: [TEST_USER_ID, `peer-${i}`],
      lastMessageAt: new Date(3000 - i),
      lastMessage: null,
      unreadCountByUser: {},
      mutedBy: {},
      pinnedCount: 0,
    }));
    // limit=2 → service over-fetches 3; repo returns all 3 → hasMore must be true.
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue(rows);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(3);

    const res = await request(app)
      .get("/api/chat/private/conversations?limit=2")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(2);
    expect(res.body.data.pagination.hasMore).toBe(true);
    expect(res.body.data.pagination.nextCursor).toBe(
      String(new Date(2999).getTime())
    );
    expect(mocks.privateRoomRepo.getInboxConversations).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3, direction: "before" })
    );
  });

  it("PAGINATION: before_ts is honored as the cursor boundary", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(0);

    await request(app)
      .get("/api/chat/private/conversations?before_ts=1717000000000")
      .set(bearer(makeAccessToken()));

    expect(mocks.privateRoomRepo.getInboxConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "before",
        ts: new Date(1717000000000),
      })
    );
  });
});

describe("POST /api/chat/private/rooms/:peerId (get-or-create)", () => {
  it("POSITIVE: returns the existing room when one already exists", async () => {
    mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue({
      roomId: "prv_existing",
      participants: [TEST_USER_ID, "peer-1"],
    });

    const res = await request(app)
      .post("/api/chat/private/rooms/peer-1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.roomId).toBe("prv_existing");
    // Friendship check is skipped for an existing room.
    expect(mocks.userServiceClient.checkFriendship).not.toHaveBeenCalled();
  });

  it("POSITIVE: creates a new room when friends and none exists", async () => {
    mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue(null);
    mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
    mocks.privateRoomRepo.create.mockResolvedValue({
      roomId: "prv_new",
      participants: [TEST_USER_ID, "peer-1"],
    });

    const res = await request(app)
      .post("/api/chat/private/rooms/peer-1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.roomId).toBe("prv_new");
    expect(mocks.privateRoomRepo.create).toHaveBeenCalled();
  });

  it("NEGATIVE/SECURITY: 403 when the two users are not friends", async () => {
    mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue(null);
    mocks.userServiceClient.checkFriendship.mockResolvedValue(false);

    const res = await request(app)
      .post("/api/chat/private/rooms/peer-1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(mocks.privateRoomRepo.create).not.toHaveBeenCalled();
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).post("/api/chat/private/rooms/peer-1");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/chat/private/rooms/:peerId (room details)", () => {
  it("POSITIVE: returns community-aligned room details with isOffline derived from presence", async () => {
    mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue({
      roomId: "prv_1",
      participants: [TEST_USER_ID, "peer-1"],
      mutedBy: {},
      unreadCountByUser: { [TEST_USER_ID]: 2 },
      lastMessage: null,
      lastMessageAt: new Date(1000),
      createdAt: new Date(500),
      updatedAt: new Date(1500),
    });
    mocks.cacheRepo.getUserSnapshots.mockResolvedValue(
      new Map([
        [
          "peer-1",
          {
            displayName: "Peer One",
            memberId: "peer1",
            isDeletedUser: false,
            isOnline: true,
          },
        ],
      ])
    );

    const res = await request(app)
      .get("/api/chat/private/rooms/peer-1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe("prv_1");
    expect(res.body.data.roomId).toBe("prv_1");
    expect(res.body.data.peerId).toBe("peer-1");
    expect(res.body.data.user).toMatchObject({
      id: "peer-1",
      displayName: "Peer One",
      memberId: "peer1",
      isDeletedUser: false,
    });
    expect(res.body.data.avatar).toBeDefined();
    expect(res.body.data.isOnline).toBe(true);
    expect(res.body.data.isOffline).toBe(false);
    expect(res.body.data.isMuted).toBe(false);
    expect(res.body.data.muteUntil).toBeNull();
    expect(res.body.data.unreadMessageCount).toBe(2);
    expect(typeof res.body.data.createdAt).toBe("number");
    expect(typeof res.body.data.updatedAt).toBe("number");
  });

  it("POSITIVE: isOffline is true when the peer is offline", async () => {
    mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue({
      roomId: "prv_1",
      participants: [TEST_USER_ID, "peer-1"],
      mutedBy: {},
      unreadCountByUser: {},
      lastMessage: null,
      lastMessageAt: new Date(1000),
      createdAt: new Date(500),
      updatedAt: new Date(1500),
    });
    mocks.cacheRepo.getUserSnapshots.mockResolvedValue(
      new Map([
        [
          "peer-1",
          {
            displayName: "Peer One",
            memberId: "peer1",
            isDeletedUser: false,
            isOnline: false,
          },
        ],
      ])
    );

    const res = await request(app)
      .get("/api/chat/private/rooms/peer-1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.isOnline).toBe(false);
    expect(res.body.data.isOffline).toBe(true);
  });

  it("NEGATIVE/SECURITY: 403 when the two users are not friends and no room exists yet", async () => {
    mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue(null);
    mocks.userServiceClient.checkFriendship.mockResolvedValue(false);

    const res = await request(app)
      .get("/api/chat/private/rooms/peer-1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get("/api/chat/private/rooms/peer-1");
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/chat/private/rooms/:roomId (delete-for-me)", () => {
  it("POSITIVE: soft-deletes the room for the caller", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: "prv_1",
      participants: [TEST_USER_ID, "peer-1"],
    });
    mocks.privateRoomRepo.setDeletedFor.mockResolvedValue(undefined);

    const res = await request(app)
      .delete("/api/chat/private/rooms/prv_1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mocks.privateRoomRepo.setDeletedFor).toHaveBeenCalledWith(
      "prv_1",
      TEST_USER_ID
    );
  });

  it("NEGATIVE: 404 when the room does not exist", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(null);

    const res = await request(app)
      .delete("/api/chat/private/rooms/ghost")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });

  it("SECURITY: IDOR — 404 when the caller is not a participant", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: "prv_1",
      participants: ["other-a", "other-b"],
    });

    const res = await request(app)
      .delete("/api/chat/private/rooms/prv_1")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
    expect(mocks.privateRoomRepo.setDeletedFor).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat/private/rooms/:roomId/mute + /unmute", () => {
  it("POSITIVE: mutes with a valid ISO datetime", async () => {
    const room = { roomId: "prv_1", participants: [TEST_USER_ID, "peer-1"] };
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(room);
    mocks.privateRoomRepo.setMuted.mockResolvedValue({ ...room, muted: true });

    const res = await request(app)
      .post("/api/chat/private/rooms/prv_1/mute")
      .set(bearer(makeAccessToken()))
      .send({ muteUntil: "2030-01-01T00:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(mocks.privateRoomRepo.setMuted).toHaveBeenCalled();
  });

  it("POSITIVE: mute with null muteUntil (mute indefinitely) is accepted", async () => {
    const room = { roomId: "prv_1", participants: [TEST_USER_ID, "peer-1"] };
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(room);
    mocks.privateRoomRepo.setMuted.mockResolvedValue(room);

    const res = await request(app)
      .post("/api/chat/private/rooms/prv_1/mute")
      .set(bearer(makeAccessToken()))
      .send({ muteUntil: null });

    expect(res.status).toBe(200);
  });

  it("NEGATIVE: 400 when muteUntil is not a valid datetime string", async () => {
    const res = await request(app)
      .post("/api/chat/private/rooms/prv_1/mute")
      .set(bearer(makeAccessToken()))
      .send({ muteUntil: "not-a-date" });

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 404 muting a room the caller is not in", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: "prv_1",
      participants: ["a", "b"],
    });

    const res = await request(app)
      .post("/api/chat/private/rooms/prv_1/mute")
      .set(bearer(makeAccessToken()))
      .send({ muteUntil: null });

    expect(res.status).toBe(404);
  });

  it("POSITIVE: unmute returns 200", async () => {
    const room = { roomId: "prv_1", participants: [TEST_USER_ID, "peer-1"] };
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(room);
    mocks.privateRoomRepo.setUnmuted.mockResolvedValue(room);

    const res = await request(app)
      .post("/api/chat/private/rooms/prv_1/unmute")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.privateRoomRepo.setUnmuted).toHaveBeenCalledWith(
      "prv_1",
      TEST_USER_ID
    );
  });

  it("SECURITY: 401 with a forged token on unmute", async () => {
    const res = await request(app)
      .post("/api/chat/private/rooms/prv_1/unmute")
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/chat/private/rooms/:roomId/archive + /unarchive", () => {
  it("POSITIVE: archives the conversation for a participant", async () => {
    const room = { roomId: "prv_1", participants: [TEST_USER_ID, "peer-1"] };
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(room);
    mocks.privateRoomRepo.setArchived.mockResolvedValue({
      ...room,
      archivedBy: {
        [TEST_USER_ID]: { archivedAt: "2030-01-01T00:00:00.000Z" },
      },
    });

    const res = await request(app)
      .patch("/api/chat/private/rooms/prv_1/archive")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mocks.privateRoomRepo.setArchived).toHaveBeenCalledWith(
      "prv_1",
      TEST_USER_ID
    );
    // Emits conv:archived to the caller's own user channel.
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `user:${TEST_USER_ID}`,
      expect.stringContaining("conv:archived")
    );
  });

  it("NEGATIVE: 404 archiving a room that does not exist", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(null);

    const res = await request(app)
      .patch("/api/chat/private/rooms/ghost/archive")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
    expect(mocks.privateRoomRepo.setArchived).not.toHaveBeenCalled();
  });

  it("SECURITY: IDOR — 404 archiving a room the caller is not a participant of", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: "prv_1",
      participants: ["other-a", "other-b"],
    });

    const res = await request(app)
      .patch("/api/chat/private/rooms/prv_1/archive")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
    expect(mocks.privateRoomRepo.setArchived).not.toHaveBeenCalled();
  });

  it("POSITIVE: unarchive returns 200 and clears the caller's archive flag", async () => {
    const room = { roomId: "prv_1", participants: [TEST_USER_ID, "peer-1"] };
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(room);
    mocks.privateRoomRepo.setUnarchived.mockResolvedValue(room);

    const res = await request(app)
      .patch("/api/chat/private/rooms/prv_1/unarchive")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.privateRoomRepo.setUnarchived).toHaveBeenCalledWith(
      "prv_1",
      TEST_USER_ID
    );
  });

  it("SECURITY: IDOR — 404 unarchiving a room the caller is not a participant of", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: "prv_1",
      participants: ["other-a", "other-b"],
    });

    const res = await request(app)
      .patch("/api/chat/private/rooms/prv_1/unarchive")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
    expect(mocks.privateRoomRepo.setUnarchived).not.toHaveBeenCalled();
  });

  it("SECURITY: 401 with a forged token on archive", async () => {
    const res = await request(app)
      .patch("/api/chat/private/rooms/prv_1/archive")
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
  });
});
