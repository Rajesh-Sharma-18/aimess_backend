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
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [
        {
          id: "m1",
          roomId: ROOM,
          sentBy: "u",
          message: "hi",
          messageType: "text",
          createdAt: new Date(1),
        },
      ],
      hasMore: false,
    });
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(1);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
    expect(res.body.data.data[0].contentType).toBe("TEXT");
  });

  it("POSITIVE: messages are returned in ascending (oldest→newest) order", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    // Repository returns the page newest-first (DESC) as the DB would for a
    // before-direction keyset page. The service must reverse this before responding.
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [
        {
          id: "m3",
          roomId: ROOM,
          sentBy: "u",
          message: "newest",
          messageType: "text",
          createdAt: new Date(3000),
          deletedBy: [],
        },
        {
          id: "m2",
          roomId: ROOM,
          sentBy: "u",
          message: "middle",
          messageType: "text",
          createdAt: new Date(2000),
          deletedBy: [],
        },
        {
          id: "m1",
          roomId: ROOM,
          sentBy: "u",
          message: "oldest",
          messageType: "text",
          createdAt: new Date(1000),
          deletedBy: [],
        },
      ],
      hasMore: false,
    });
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(3);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const items = res.body.data.data as Array<{ id: string }>;
    expect(items).toHaveLength(3);
    // Ascending: oldest (m1) first, newest (m3) last.
    expect(items[0].id).toBe("m1");
    expect(items[1].id).toBe("m2");
    expect(items[2].id).toBe("m3");
  });

  it("POSITIVE: nextCursor points to the oldest item (pagination boundary for next older page)", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    // Repo returns the page (limit=2) newest-first plus an exact hasMore flag.
    // The DB now computes hasMore via over-fetch, so the service no longer slices.
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [
        {
          id: "m3",
          roomId: ROOM,
          sentBy: "u",
          message: "newest",
          messageType: "text",
          createdAt: new Date(3000),
          deletedBy: [],
        },
        {
          id: "m2",
          roomId: ROOM,
          sentBy: "u",
          message: "second",
          messageType: "text",
          createdAt: new Date(2000),
          deletedBy: [],
        },
      ],
      hasMore: true,
    });
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(10);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages?limit=2`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const body = res.body.data as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor: string;
    };
    // Page returns [m2, m3] in ASC order.
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe("m2");
    expect(body.data[1].id).toBe("m3");
    expect(body.hasMore).toBe(true);
    // nextCursor is a COMPOUND keyset "<oldest-in-page ms>_<id>" — fed back as
    // before_ts. The _id tiebreaker keeps same-millisecond messages reachable.
    expect(body.nextCursor).toBe("2000_m2");
  });

  it("POSITIVE: a compound before_ts ('<ms>_<id>') is parsed into the (ts, boundaryId) keyset", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [],
      hasMore: false,
    });
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(0);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);

    const boundaryId = "a".repeat(24);
    const res = await request(app)
      .get(
        `${BASE}/rooms/${ROOM}/messages?before_ts=2000_${boundaryId}&limit=5`
      )
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const call =
      mocks.generalRoomMessageRepo.findByRoomIdTimeline.mock.calls[0][0];
    expect(call.boundaryId).toBe(boundaryId);
    expect(call.ts.getTime()).toBe(2000);
    expect(call.inclusive).toBe(false); // a cursor page is exclusive
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
    expect(res.body.data.data[0].isEdited).toBe(false);
  });

  it("POSITIVE: after_ts sync sets isEdited:true for messages with editedAt set", async () => {
    const editedTs = 2000;
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findUpdatedAtSince.mockResolvedValue({
      messages: [
        {
          id: "m2",
          roomId: ROOM,
          sentBy: "u",
          message: "hi edited",
          messageType: "text",
          deletedForAll: false,
          createdAt: new Date(1000),
          updatedAt: new Date(editedTs),
          editedAt: new Date(editedTs),
        },
      ],
      hasMore: false,
    });

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages?after_ts=500`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data[0].isEdited).toBe(true);
    expect(res.body.data.data[0].editedAt).toBe(editedTs);
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
    // Room-bind guard: caller is an active member of the message's room.
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      role: "member",
      status: "active",
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
    // Room-bind guard: caller is an active member of the message's room.
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      role: "member",
      status: "active",
    });
    mocks.generalRoomMessageRepo.editMessage.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      messageType: "text",
      message: "edited",
      createdAt: new Date(now - 1000),
      editedAt: new Date(now),
    });

    const res = await request(app)
      .patch(`${BASE}/messages/m1`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: "comm-1", content: { text: "edited" } });

    expect(res.status).toBe(200);
    expect(res.body.data.isEdited).toBe(true);
    expect(res.body.data.editedAt).toBeGreaterThan(0);
    // After the cross-channel fix: broadcast goes to the message's OWN room
    // (result.roomId), NOT the body-supplied communityId ("comm-1").
    const publishCall = mocks.redis.publish.mock.calls.find(
      ([, payload]: [string, string]) => {
        try {
          return JSON.parse(payload).event === "community:message:edited";
        } catch {
          return false;
        }
      }
    );
    expect(publishCall).toBeDefined();
    const broadcastPayload = JSON.parse(publishCall[1]);
    expect(broadcastPayload.data.isEdited).toBe(true);
    expect(broadcastPayload.data.editedAt).toBeGreaterThan(0);
  });

  it("SECURITY: 400 editing another user's message", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      sentBy: "not-me",
      messageType: "text",
      deletedForAll: false,
      createdAt: new Date(),
    });
    // Member guard passes (caller is active in the message's room), so the
    // own-only sender check is what rejects with 400 — not the room-bind 404.
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      role: "member",
      status: "active",
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
