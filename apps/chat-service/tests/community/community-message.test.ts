/**
 * Integration tests — community messages.
 * Routes (apps/chat-service/src/api/routes/community.routes.ts, mounted at /api/chat/community):
 *   GET    /rooms/:roomId/sync               (Zod: since_ts required)
 *   POST   /rooms/:roomId/messages/:messageId/pin   (Zod body; role-gated)
 *   DELETE /rooms/:roomId/messages/:messageId/pin   (Zod body: messageId)
 *   GET    /rooms/:roomId/messages/search
 *   GET    /rooms/:roomId/messages
 *   GET    /rooms/:roomId/conversation       (membership-gated)
 *   GET    /rooms/:roomId/media              (membership-gated)
 *   DELETE /messages/:messageId              (?type=forMe|forEveryone)
 *   PATCH  /messages/:messageId              (Zod body: communityId + content.text)
 *   POST   /messages/:messageId/react        (Zod body: communityId + emoji)
 *   GET    /rooms/:roomId/pins
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "room-1";
const BASE = "/api/chat/community";

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("GET /rooms/:roomId/messages (timeline + history)", () => {
  it("POSITIVE: returns the latest page (UPPER contentType wire shape)", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockResolvedValue([
      {
        id: "m1",
        roomId: ROOM,
        sentBy: "u",
        message: "hi",
        messageType: "text",
        createdAt: new Date(1),
      },
    ]);
    mocks.generalRoomMessageRepo.countByRoom.mockResolvedValue(1);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
    expect(res.body.data.data[0].contentType).toBe("TEXT");
  });

  // AUDIT H2 — the before_ts/latest history list must be gated on membership.
  it("SECURITY: IDOR — 403 reading history (latest/before_ts) as a non-member", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(
      mocks.generalRoomMessageRepo.findByRoomIdTimeline
    ).not.toHaveBeenCalled();
  });

  it("POSITIVE: after_ts triggers incremental sync mode", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findUpdatedAtSince.mockResolvedValue({
      messages: [
        {
          id: "m1",
          roomId: ROOM,
          sentBy: "u",
          message: "hi",
          messageType: "text",
          deletedForAll: false,
          createdAt: new Date(1000),
          updatedAt: new Date(1000),
          editedAt: null,
        },
      ],
      hasMore: false,
    });

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages?after_ts=500`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data[0].syncEventType).toBe("new");
  });

  it("SECURITY: 403 incremental-sync for a non-member", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages?after_ts=500`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
  });

  it("NEGATIVE: 400 when both before_ts and after_ts are provided", async () => {
    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages?before_ts=1&after_ts=2`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get(`${BASE}/rooms/${ROOM}/messages`);
    expect(res.status).toBe(401);
  });
});

describe("GET /rooms/:roomId/messages/search (membership-gated)", () => {
  it("POSITIVE: an active member can search", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.searchByText.mockResolvedValue([
      {
        id: "m1",
        roomId: ROOM,
        sentBy: "u",
        message: "hello",
        messageType: "text",
        createdAt: new Date(1),
      },
    ]);
    mocks.generalRoomMessageRepo.countSearchResults.mockResolvedValue(1);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages/search?q=hello`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  // AUDIT H2 — community search must be gated on active membership (IDOR).
  it("SECURITY: IDOR — 403 searching a community you're not a member of", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages/search?q=hello`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.generalRoomMessageRepo.searchByText).not.toHaveBeenCalled();
  });
});

describe("GET /rooms/:roomId/sync", () => {
  it("POSITIVE: returns messages since the cursor for an active member", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findUpdatedAtSince.mockResolvedValue({
      messages: [
        {
          id: "m1",
          roomId: ROOM,
          sentBy: "u",
          message: "x",
          messageType: "text",
          deletedForAll: false,
          createdAt: new Date(1),
          updatedAt: new Date(1),
          editedAt: null,
        },
      ],
      hasMore: false,
    });

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/sync?since_ts=1`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  it("NEGATIVE: 400 when since_ts is missing (required)", async () => {
    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/sync`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });

  it("SECURITY: 403 for a non-member", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/sync?since_ts=1`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
  });
});

describe("GET /rooms/:roomId/conversation (membership-gated)", () => {
  it("POSITIVE: active member gets the page", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.listConversationMessages.mockResolvedValue([
      {
        id: "m1",
        roomId: ROOM,
        sentBy: "u",
        message: "x",
        messageType: "text",
        createdAt: new Date(5),
      },
    ]);
    mocks.generalRoomMessageRepo.countConversation.mockResolvedValue(1);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/conversation`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  it("SECURITY: 403 for a non-member", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/conversation`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
  });

  it("SECURITY: 403 for a banned (non-active) member", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "banned",
    });

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/conversation`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
  });
});

describe("GET /rooms/:roomId/media (membership-gated)", () => {
  it("POSITIVE: active member lists media", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.listMedia.mockResolvedValue([
      {
        id: "m1",
        roomId: ROOM,
        sentBy: "u",
        messageType: "image",
        createdAt: new Date(1),
      },
    ]);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/media?type=IMAGE`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });

  it("SECURITY: 403 for a non-member", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/media`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
  });
});

describe("DELETE /messages/:messageId", () => {
  it("POSITIVE: forEveryone on own message + broadcasts deletion", async () => {
    mocks.generalRoomMessageRepo.findById
      .mockResolvedValueOnce({ id: "m1", sentBy: TEST_USER_ID, roomId: ROOM })
      .mockResolvedValue({
        id: "m1",
        roomId: ROOM,
        messageType: "text",
        deletedForAll: true,
      });
    mocks.generalRoomMessageRepo.deleteForAll.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      messageType: "text",
    });

    const res = await request(app)
      .delete(`${BASE}/messages/m1?type=forEveryone`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `community:${ROOM}`,
      expect.stringContaining("community:message:deleted")
    );
  });

  it("SECURITY: 400 forEveryone on another user's message without a mod role", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      sentBy: "someone-else",
      roomId: ROOM,
    });
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      role: "member",
      status: "active",
    });

    const res = await request(app)
      .delete(`${BASE}/messages/m1?type=forEveryone`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
    expect(mocks.generalRoomMessageRepo.deleteForAll).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 404 when the message is missing", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue(null);

    const res = await request(app)
      .delete(`${BASE}/messages/ghost?type=forMe`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });
});

describe("PATCH /messages/:messageId (edit)", () => {
  it("POSITIVE: edit own text message and broadcast", async () => {
    const now = Date.now();
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      messageType: "text",
      deletedForAll: false,
      createdAt: new Date(now - 1000),
    });
    mocks.generalRoomMessageRepo.editMessage.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      messageType: "text",
      message: "edited",
      createdAt: new Date(now - 1000),
    });

    const res = await request(app)
      .patch(`${BASE}/messages/m1`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: "comm-1", content: { text: "edited" } });

    expect(res.status).toBe(200);
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      "community:comm-1",
      expect.stringContaining("community:message:edited")
    );
  });

  it("SECURITY: 400 editing another user's message", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      sentBy: "not-me",
      messageType: "text",
      deletedForAll: false,
      createdAt: new Date(),
    });

    const res = await request(app)
      .patch(`${BASE}/messages/m1`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: "comm-1", content: { text: "hax" } });

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 400 when communityId is missing from body", async () => {
    const res = await request(app)
      .patch(`${BASE}/messages/m1`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "edited" } });

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 400 when content.text is empty", async () => {
    const res = await request(app)
      .patch(`${BASE}/messages/m1`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: "comm-1", content: { text: "" } });

    expect(res.status).toBe(400);
  });
});

describe("POST /messages/:messageId/react", () => {
  it("POSITIVE: toggles a reaction for an active member", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      deletedForAll: false,
      reactions: {},
    });
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "member",
    });

    const res = await request(app)
      .post(`${BASE}/messages/m1/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: "comm-1", emoji: "👍" });

    expect(res.status).toBe(200);
    expect(mocks.generalRoomMessageRepo.updateById).toHaveBeenCalled();
  });

  it("SECURITY: 403 reacting as a non-member", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      deletedForAll: false,
      reactions: {},
    });
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post(`${BASE}/messages/m1/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: "comm-1", emoji: "👍" });

    expect(res.status).toBe(403);
  });

  it("NEGATIVE: 400 when emoji is missing", async () => {
    const res = await request(app)
      .post(`${BASE}/messages/m1/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: "comm-1" });

    expect(res.status).toBe(400);
  });
});

describe("pins: POST pin + DELETE unpin + GET list", () => {
  it("POSITIVE: a moderator pins a message and broadcasts", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "moderator",
    });
    mocks.communityMessagePinRepo.countPinsByRoom.mockResolvedValue(0);
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      message: "pin",
      createdAt: new Date(1),
    });
    mocks.communityMessagePinRepo.createPin.mockResolvedValue({
      id: "pin1",
      pinnedAt: new Date(2),
    });
    mocks.generalRoomRepo.incPinnedCount.mockResolvedValue({ pinnedCount: 1 });

    const res = await request(app)
      .post(`${BASE}/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: "m1", communityId: "comm-1" });

    expect(res.status).toBe(200);
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      "community:comm-1",
      expect.stringContaining("community:message:pinned")
    );
  });

  it("SECURITY: 403 when a plain member tries to pin", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "member",
    });

    const res = await request(app)
      .post(`${BASE}/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: "m1", communityId: "comm-1" });

    expect(res.status).toBe(403);
  });

  it("NEGATIVE: 404 pinning when not a member of the room", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post(`${BASE}/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: "m1", communityId: "comm-1" });

    expect(res.status).toBe(404);
  });

  it("POSITIVE: lists pins for a room", async () => {
    mocks.communityMessagePinRepo.findPinsByRoom.mockResolvedValue([
      { id: "pin1", pinnedAt: new Date(1) },
    ]);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/pins`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });

  it("NEGATIVE: 400 unpin missing required body messageId", async () => {
    // DELETE /rooms/:roomId/messages/:messageId/pin validates body messageId.
    const res = await request(app)
      .delete(`${BASE}/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()))
      .send({});

    expect(res.status).toBe(400);
  });
});
