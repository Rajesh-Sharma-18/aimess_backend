/**
 * Integration tests — private messages.
 * Routes (apps/chat-service/src/api/routes/private-message.routes.ts):
 *   GET    /rooms/:roomId/messages/search
 *   GET    /rooms/:roomId/messages
 *   GET    /rooms/:roomId/media
 *   PATCH  /messages/:messageId            (edit)
 *   POST   /messages/:messageId/report
 *   DELETE /messages/:messageId            (?type=forMe|forEveryone)
 *   GET    /rooms/:roomId/pins
 *   POST   /rooms/:roomId/messages/:messageId/pin
 *   DELETE /rooms/:roomId/messages/:messageId/pin
 *   POST   /rooms/:roomId/messages/:messageId/forward
 *   GET    /rooms/:roomId/messages/:messageId/reactions
 *
 * `roomId`/`messageId` use min length 5/4 in the validators where present.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "prv_room_1";

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("GET /rooms/:roomId/messages (timeline)", () => {
  it("POSITIVE: returns the newest page with epoch-ms serialized dates", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer"],
      deletedFor: {},
    });
    mocks.privateMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [
        {
          id: "m1",
          senderId: "peer",
          content: { text: "hi" },
          createdAt: new Date(1000),
        },
      ],
      hasMore: false,
    });
    mocks.privateMessageRepo.countTimeline.mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.data).toHaveLength(1);
    // Canonical kind field: contentType present (UPPER), internal messageType stripped.
    expect(res.body.data.data[0].contentType).toBe("TEXT");
    expect(res.body.data.data[0].messageType).toBeUndefined();
  });

  // AUDIT H2 — message timeline must be gated on participation (IDOR on history).
  it("SECURITY: IDOR — 403 reading the timeline of a room you're not in", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: ["a", "b"],
    });

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(
      mocks.privateMessageRepo.findByRoomIdTimeline
    ).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 404 when the room does not exist", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(null);
    mocks.privateMessageRepo.countByRoom.mockResolvedValue(0);

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });

  it("NEGATIVE: 400 when both before_ts and after_ts are sent", async () => {
    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/messages?before_ts=1&after_ts=2`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get(
      `/api/chat/private/rooms/${ROOM}/messages`
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /rooms/:roomId/messages/search", () => {
  it("POSITIVE: returns matches for a query string", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer"],
    });
    mocks.privateMessageRepo.searchByText.mockResolvedValue([
      {
        id: "m1",
        senderId: "peer",
        content: { text: "hello world" },
        createdAt: new Date(1),
      },
    ]);
    mocks.privateMessageRepo.countSearchResults.mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/messages/search?q=hello`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
    expect(res.body.data.data[0].contentType).toBe("TEXT");
    expect(res.body.data.data[0].messageType).toBeUndefined();
  });

  // Regression: `page` was parsed but never converted to a DB skip, so page 2
  // silently returned the exact same window as page 1 and any match beyond
  // the first `limit` results was unreachable.
  it("REGRESSION: page 2 requests a distinct offset window, not page 1 again", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer"],
    });
    mocks.privateMessageRepo.searchByText.mockResolvedValue([]);
    mocks.privateMessageRepo.countSearchResults.mockResolvedValue(0);

    await request(app)
      .get(
        `/api/chat/private/rooms/${ROOM}/messages/search?q=hello&page=2&limit=10`
      )
      .set(bearer(makeAccessToken()));

    expect(mocks.privateMessageRepo.searchByText).toHaveBeenCalledWith(
      ROOM,
      "hello",
      10,
      expect.any(String),
      10
    );
  });

  it("REGRESSION: countSearchResults is scoped to the requesting user (deleted-for-me parity)", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer"],
    });
    mocks.privateMessageRepo.searchByText.mockResolvedValue([]);
    mocks.privateMessageRepo.countSearchResults.mockResolvedValue(0);

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/messages/search?q=hello`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.privateMessageRepo.countSearchResults).toHaveBeenCalledWith(
      ROOM,
      "hello",
      expect.any(String)
    );
  });

  // AUDIT H2 — search must be gated on participation (IDOR on history).
  it("SECURITY: IDOR — 403 searching a room you're not a participant of", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: ["a", "b"],
    });

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/messages/search?q=hello`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.privateMessageRepo.searchByText).not.toHaveBeenCalled();
  });

  it("EDGE: empty query short-circuits to an empty list (no repo search)", async () => {
    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/messages/search?q=`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toEqual([]);
    expect(mocks.privateMessageRepo.searchByText).not.toHaveBeenCalled();
  });
});

describe("GET /rooms/:roomId/media", () => {
  it("POSITIVE: lists media for a participant", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer"],
    });
    mocks.privateMessageRepo.listMedia.mockResolvedValue([
      {
        id: "m1",
        senderId: "peer",
        messageType: "IMAGE",
        content: {},
        createdAt: new Date(1),
      },
    ]);

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/media?type=IMAGE`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    // messageType "IMAGE" on the row must surface as contentType, not messageType.
    expect(res.body.data.items[0].contentType).toBe("IMAGE");
    expect(res.body.data.items[0].messageType).toBeUndefined();
  });

  it("SECURITY: IDOR — 403 when the caller is not a participant", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: ["a", "b"],
    });

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/media`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.privateMessageRepo.listMedia).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 400 for an invalid media type enum", async () => {
    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/media?type=BOGUS`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /messages/:messageId", () => {
  it("POSITIVE: delete-for-me returns 200 and publishes a tombstone", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "msg_1",
      roomId: ROOM,
      isDeleted: false,
      deletedFor: {},
    });
    // Room-bind guard: the message's room exists and the caller is a participant.
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer"],
    });
    mocks.privateMessageRepo.deleteForMe.mockResolvedValue({
      id: "msg_1",
      roomId: ROOM,
      sequenceNumber: 3,
    });

    const res = await request(app)
      .delete(`/api/chat/private/messages/msg_1?type=forMe`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `conv:${ROOM}`,
      expect.stringContaining("message:delete")
    );
  });

  it("SECURITY: forEveryone on someone else's message → 400 (own-only guard)", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "msg_1",
      roomId: ROOM,
      isDeleted: false,
      senderId: "not-me",
      deletedFor: {},
    });
    // Caller IS a participant of the message's room, so the room-bind guard passes
    // and the own-only sender check is the one that rejects with 400 (not a 404).
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "not-me"],
    });

    const res = await request(app)
      .delete(`/api/chat/private/messages/msg_1?type=forEveryone`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
    expect(mocks.privateMessageRepo.deleteForEveryone).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 404 when the message does not exist", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/chat/private/messages/msg_x?type=forMe`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });

  it("NEGATIVE: 400 for an invalid delete type", async () => {
    const res = await request(app)
      .delete(`/api/chat/private/messages/msg_1?type=poof`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });
});

describe("PATCH /messages/:messageId (edit)", () => {
  it("POSITIVE: edits own TEXT message within the window", async () => {
    const now = Date.now();
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "msg_1",
      roomId: ROOM,
      senderId: TEST_USER_ID,
      messageType: "TEXT",
      isDeleted: false,
      createdAt: new Date(now - 1000),
    });
    // Room-bind guard: caller is a participant of the message's room.
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer"],
    });
    mocks.privateMessageRepo.editMessage.mockResolvedValue({
      id: "msg_1",
      roomId: ROOM,
      senderId: TEST_USER_ID,
      messageType: "TEXT",
      content: { text: "edited" },
      createdAt: new Date(now - 1000),
      editedAt: new Date(now),
    });

    const res = await request(app)
      .patch(`/api/chat/private/messages/msg_1`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "edited" } });

    expect(res.status).toBe(200);
    expect(mocks.privateMessageRepo.editMessage).toHaveBeenCalled();
  });

  it("SECURITY: 400 editing another user's message (own-only)", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "msg_1",
      roomId: ROOM,
      senderId: "not-me",
      messageType: "TEXT",
      isDeleted: false,
      createdAt: new Date(),
    });
    // Caller IS a participant (room-bind passes), so the own-only sender check is
    // what rejects with 400 — not the room-bind 404.
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "not-me"],
    });

    const res = await request(app)
      .patch(`/api/chat/private/messages/msg_1`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "hacked" } });

    expect(res.status).toBe(400);
    expect(mocks.privateMessageRepo.editMessage).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 400 with empty edit text (min length 1)", async () => {
    const res = await request(app)
      .patch(`/api/chat/private/messages/msg_1`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "" } });

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 404 when the message is gone", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/chat/private/messages/msg_1`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "x" } });

    expect(res.status).toBe(404);
  });
});

describe("POST /messages/:messageId/report", () => {
  it("POSITIVE: reports another user's message", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "msg_1",
      roomId: ROOM,
      senderId: "peer",
    });
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer"],
    });
    mocks.privateMessageReportRepo.create.mockResolvedValue({
      id: "rep_1",
      reason: "SPAM",
    });

    const res = await request(app)
      .post(`/api/chat/private/messages/msg_1/report`)
      .set(bearer(makeAccessToken()))
      .send({ reason: "SPAM", description: "junk" });

    expect(res.status).toBe(201);
    expect(mocks.privateMessageReportRepo.create).toHaveBeenCalled();
  });

  it("SECURITY: 400 reporting your OWN message", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "msg_1",
      roomId: ROOM,
      senderId: TEST_USER_ID,
    });
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer"],
    });

    const res = await request(app)
      .post(`/api/chat/private/messages/msg_1/report`)
      .set(bearer(makeAccessToken()))
      .send({ reason: "SPAM" });

    expect(res.status).toBe(400);
  });

  it("SECURITY: 403 reporting in a room you are not part of", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "msg_1",
      roomId: ROOM,
      senderId: "peer",
    });
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: ["a", "b"],
    });

    const res = await request(app)
      .post(`/api/chat/private/messages/msg_1/report`)
      .set(bearer(makeAccessToken()))
      .send({ reason: "SPAM" });

    expect(res.status).toBe(403);
  });

  it("NEGATIVE: 400 for an invalid report reason enum", async () => {
    const res = await request(app)
      .post(`/api/chat/private/messages/msg_1/report`)
      .set(bearer(makeAccessToken()))
      .send({ reason: "NOT_A_REASON" });

    expect(res.status).toBe(400);
  });
});

describe("pins: GET list + POST pin + DELETE unpin", () => {
  it("POSITIVE: lists pins for a room", async () => {
    mocks.privateMessagePinRepo.findPinsByRoom.mockResolvedValue([
      { id: "pin1", messageId: "m1", pinnedAt: new Date(1) },
    ]);
    mocks.privateMessagePinRepo.countPinsByRoom.mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/pins`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  it("POSITIVE: pin a message returns 201 and publishes pin:updated", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({ roomId: ROOM });
    mocks.privateMessagePinRepo.countPinsByRoom.mockResolvedValue(0);
    mocks.privateMessageRepo.findMessageMeta.mockResolvedValue({
      id: "m1",
      senderId: "peer",
      content: { text: "pin me" },
      createdAt: new Date(1),
    });
    mocks.privateMessagePinRepo.createPin.mockResolvedValue({
      id: "pin1",
      pinnedAt: new Date(2),
    });
    mocks.privateRoomRepo.incPinnedCount.mockResolvedValue({ pinnedCount: 1 });

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(201);
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `conv:${ROOM}`,
      expect.stringContaining("pin:updated")
    );
  });

  it("NEGATIVE: 404 pinning in a non-existent room", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });

  it("SECURITY: unpin in a room you're not in → 400 (not-participant guard)", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: ["a", "b"],
    });

    const res = await request(app)
      .delete(`/api/chat/private/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
  });
});

describe("POST /rooms/:roomId/messages/:messageId/forward", () => {
  it("POSITIVE: forwards a message to another room and emits message:new", async () => {
    mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "src",
      roomId: ROOM,
      isDeleted: false,
      messageType: "TEXT",
      content: { text: "fwd" },
      createdAt: new Date(10),
    });
    // Source-room bind: caller is a participant of the SOURCE room (path :roomId)
    // and the source message belongs to it.
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer"],
    });
    mocks.privateMessageRepo.createForwardedMessage.mockResolvedValue({
      id: "fwd1",
      messageType: "TEXT",
      content: { text: "fwd" },
      createdAt: new Date(20),
    });

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: "prv_target_room", receiverId: "peer-2" });

    expect(res.status).toBe(201);
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      "conv:prv_target_room",
      expect.stringContaining("message:new")
    );
  });

  it("NEGATIVE/SECURITY: 403 when not friends with the target receiver", async () => {
    mocks.userServiceClient.checkFriendship.mockResolvedValue(false);

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: "prv_target_room", receiverId: "peer-2" });

    expect(res.status).toBe(403);
  });

  it("NEGATIVE: 400 when targetRoomId is missing", async () => {
    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ receiverId: "peer-2" });

    expect(res.status).toBe(400);
  });
});

describe("GET /rooms/:roomId/messages/:messageId/reactions", () => {
  it("POSITIVE: returns grouped reactions with selfReacted", async () => {
    mocks.privateMessageRepo.getReactions.mockResolvedValue({
      "👍": [TEST_USER_ID, "peer"],
    });

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/messages/m1/reactions`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.reactions["👍"].count).toBe(2);
    expect(res.body.data.reactions["👍"].selfReacted).toBe(true);
  });

  it("NEGATIVE: 404 when the message has no reactions record (missing)", async () => {
    mocks.privateMessageRepo.getReactions.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/messages/m1/reactions`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });
});
