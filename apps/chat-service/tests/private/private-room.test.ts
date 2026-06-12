/**
 * Integration tests — private rooms (1:1 conversations).
 * Routes (apps/chat-service/src/api/routes/private-message.routes.ts):
 *   GET    /api/chat/private/conversations
 *   POST   /api/chat/private/rooms/:peerId          (get-or-create; friendship-gated)
 *   DELETE /api/chat/private/rooms/:roomId          (delete-for-me)
 *   POST   /api/chat/private/rooms/:roomId/mute
 *   POST   /api/chat/private/rooms/:roomId/unmute
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
    mocks.privateRoomRepo.getConversationList.mockResolvedValue([
      {
        roomId: "prv_1",
        participants: [TEST_USER_ID, "peer-1"],
        lastMessageAt: new Date(1000),
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
    expect(res.body.data.data[0].peer.id).toBe("peer-1");
  });

  it("EDGE: empty conversation list → 200 with empty data", async () => {
    mocks.privateRoomRepo.getConversationList.mockResolvedValue([]);
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
