/**
 * Integration tests — group messages.
 * Routes (apps/chat-service/src/api/routes/group-message.routes.ts, mounted at /api/chat/groups):
 *   GET    /:roomId/messages/search
 *   GET    /:roomId/messages
 *   GET    /:roomId/conversation
 *   GET    /:roomId/media
 *   POST   /messages/delete            (Zod body)
 *   PATCH  /messages/:messageId        (edit; Zod body)
 *   GET    /:roomId/pins
 *   POST   /:roomId/messages/:messageId/pin
 *   DELETE /:roomId/messages/:messageId/pin
 *   POST   /:roomId/messages/:messageId/forward   (Zod body)
 *   GET    /:roomId/messages/:messageId/reactions
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_1";
const BASE = "/api/chat/groups";

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("GET /:roomId/messages (timeline, membership-gated)", () => {
  it("POSITIVE: an active member gets a message page", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [
        {
          id: "g1",
          senderId: "u",
          content: { text: "hi" },
          createdAt: new Date(1),
        },
      ],
      hasMore: false,
    });
    mocks.groupMessageRepo.countTimeline.mockResolvedValue(1);

    const res = await request(app)
      .get(`${BASE}/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
    // Canonical kind field: contentType present, internal messageType stripped.
    expect(res.body.data.data[0].contentType).toBe("TEXT");
    expect(res.body.data.data[0].messageType).toBeUndefined();
  });

  // Resolve-on-read: the denormalized senderAvatar key AND attachment objectKeys
  // must surface as full download URLs (mock → https://media.test/<bucket>/<key>).
  it("MEDIA: resolves senderAvatar + content.files object keys in history", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [
        {
          id: "g1",
          senderId: "u",
          senderAvatar: "avatars/u/a.png",
          messageType: "IMAGE",
          content: {
            text: "",
            files: [{ objectKey: "group-chat-uploads/grp/clip.mp4" }],
          },
          createdAt: new Date(1),
        },
      ],
      hasMore: false,
    });
    mocks.groupMessageRepo.countTimeline.mockResolvedValue(1);

    const res = await request(app)
      .get(`${BASE}/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const row = res.body.data.data[0];
    expect(row.senderAvatar).toBe(
      "https://media.test/aimess-avatars/avatars/u/a.png"
    );
    expect(row.content.files[0].url).toBe(
      "https://media.test/aimess-chat-test/group-chat-uploads/grp/clip.mp4"
    );
  });

  // AUDIT H2 — group history must be gated on active membership (IDOR).
  it("SECURITY: IDOR — 403 reading the timeline of a group you're not in", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.groupMessageRepo.findByRoomIdTimeline).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 400 when both before_ts and after_ts are sent", async () => {
    const res = await request(app)
      .get(`${BASE}/${ROOM}/messages?before_ts=1&after_ts=2`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 400 when both before_seq and after_seq are sent", async () => {
    const res = await request(app)
      .get(`${BASE}/${ROOM}/messages?before_seq=1&after_seq=2`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get(`${BASE}/${ROOM}/messages`);
    expect(res.status).toBe(401);
  });
});

describe("GET /:roomId/messages/search (membership-gated)", () => {
  it("POSITIVE: an active member can search", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMessageRepo.searchByText.mockResolvedValue([
      {
        id: "g1",
        senderId: "u",
        content: { text: "hello" },
        createdAt: new Date(1),
      },
    ]);
    mocks.groupMessageRepo.countSearchResults.mockResolvedValue(1);

    const res = await request(app)
      .get(`${BASE}/${ROOM}/messages/search?q=hello`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
    expect(res.body.data.data[0].contentType).toBe("TEXT");
    expect(res.body.data.data[0].messageType).toBeUndefined();
  });

  // AUDIT H2 — search must be gated on active membership (IDOR).
  it("SECURITY: IDOR — 403 searching a group you're not a member of", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/${ROOM}/messages/search?q=hello`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.groupMessageRepo.searchByText).not.toHaveBeenCalled();
  });
});

describe("GET /:roomId/conversation (membership-gated)", () => {
  it("POSITIVE: active member gets the offset page", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMessageRepo.listConversationMessages.mockResolvedValue([
      { id: "g1", senderId: "u", content: {}, createdAt: new Date(5) },
    ]);
    mocks.groupMessageRepo.countConversation.mockResolvedValue(1);
    mocks.groupMessageRepo.countUnreadAfter.mockResolvedValue(0);

    const res = await request(app)
      .get(`${BASE}/${ROOM}/conversation?pageNumber=1`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
    expect(res.body.data.data[0].contentType).toBe("TEXT");
    expect(res.body.data.data[0].messageType).toBeUndefined();
  });

  it("SECURITY: 403 when the caller is not an active member", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/${ROOM}/conversation`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
  });

  it("NEGATIVE: 400 when pageNumber is below 1", async () => {
    const res = await request(app)
      .get(`${BASE}/${ROOM}/conversation?pageNumber=0`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });
});

describe("GET /:roomId/media (membership-gated)", () => {
  it("POSITIVE: active member gets media", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMessageRepo.listMedia.mockResolvedValue([
      { id: "g1", messageType: "IMAGE", content: {}, createdAt: new Date(1) },
    ]);

    const res = await request(app)
      .get(`${BASE}/${ROOM}/media?type=IMAGE`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    // messageType "IMAGE" on the row must surface as contentType, not messageType.
    expect(res.body.data.items[0].contentType).toBe("IMAGE");
    expect(res.body.data.items[0].messageType).toBeUndefined();
  });

  it("SECURITY: 400 when the caller is not a member", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/${ROOM}/media`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
  });
});

describe("POST /messages/delete", () => {
  // Validator requires messageId/roomId min length 4.
  const MSG = "gmsg1";

  it("POSITIVE: deletes own message and publishes a tombstone", async () => {
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: MSG,
      senderId: TEST_USER_ID,
      roomId: ROOM,
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMessageRepo.deleteForEveryone.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sequenceNumber: 4,
    });

    const res = await request(app)
      .post(`${BASE}/messages/delete`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: MSG, roomId: ROOM });

    expect(res.status).toBe(200);
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `conv:${ROOM}`,
      expect.stringContaining("message:delete")
    );
  });

  it("SECURITY: 400 when a plain MEMBER deletes another user's message", async () => {
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: MSG,
      senderId: "someone-else",
      roomId: ROOM,
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });

    const res = await request(app)
      .post(`${BASE}/messages/delete`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: MSG, roomId: ROOM });

    expect(res.status).toBe(400);
    expect(mocks.groupMessageRepo.deleteForEveryone).not.toHaveBeenCalled();
  });

  it("POSITIVE: an ADMIN can delete another member's message", async () => {
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: MSG,
      senderId: "someone-else",
      roomId: ROOM,
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMessageRepo.deleteForEveryone.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
    });

    const res = await request(app)
      .post(`${BASE}/messages/delete`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: MSG, roomId: ROOM });

    expect(res.status).toBe(200);
  });

  it("NEGATIVE: 404 when the message does not exist", async () => {
    mocks.groupMessageRepo.findById.mockResolvedValue(null);

    const res = await request(app)
      .post(`${BASE}/messages/delete`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: "ghost", roomId: ROOM });

    expect(res.status).toBe(404);
  });

  it("NEGATIVE: 400 when messageId is missing from body", async () => {
    const res = await request(app)
      .post(`${BASE}/messages/delete`)
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /messages/:messageId (edit)", () => {
  it("POSITIVE: edit own TEXT message within window", async () => {
    const now = Date.now();
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "g1",
      roomId: ROOM,
      senderId: TEST_USER_ID,
      messageType: "TEXT",
      isDeleted: false,
      createdAt: new Date(now - 1000),
    });
    // Room-bind guard: caller is an active member of the message's room.
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMessageRepo.editMessage.mockResolvedValue({
      id: "g1",
      roomId: ROOM,
      senderId: TEST_USER_ID,
      messageType: "TEXT",
      content: { text: "edited" },
      createdAt: new Date(now - 1000),
    });

    const res = await request(app)
      .patch(`${BASE}/messages/g1`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "edited" } });

    expect(res.status).toBe(200);
  });

  it("SECURITY: 400 editing a non-TEXT message", async () => {
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "g1",
      roomId: ROOM,
      senderId: TEST_USER_ID,
      messageType: "IMAGE",
      isDeleted: false,
      createdAt: new Date(),
    });
    // Member guard passes, so the TEXT-only check is what rejects with 400.
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });

    const res = await request(app)
      .patch(`${BASE}/messages/g1`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "x" } });

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 400 with empty edit text", async () => {
    const res = await request(app)
      .patch(`${BASE}/messages/g1`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "" } });

    expect(res.status).toBe(400);
  });
});

describe("pins + forward + reactions", () => {
  it("POSITIVE: pin a group message returns 201 + pin:updated broadcast", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({ roomId: ROOM });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMessagePinRepo.countPinsByRoom.mockResolvedValue(0);
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "g1",
      roomId: ROOM,
      senderId: "u",
      content: { text: "pin" },
      createdAt: new Date(1),
    });
    mocks.groupMessagePinRepo.createPin.mockResolvedValue({
      id: "pin1",
      pinnedAt: new Date(2),
    });
    mocks.groupRoomRepo.incPinnedCount.mockResolvedValue({ pinnedCount: 1 });

    const res = await request(app)
      .post(`${BASE}/${ROOM}/messages/g1/pin`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(201);
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `conv:${ROOM}`,
      expect.stringContaining("pin:updated")
    );
  });

  it("POSITIVE: lists pins (resolves snapshot avatar + attachment keys)", async () => {
    mocks.groupMessagePinRepo.findPinsByRoom.mockResolvedValue([
      {
        id: "p1",
        pinnedAt: new Date(1),
        senderAvatar: "avatars/u/a.png",
        contentPinned: {
          text: "hi",
          files: [{ objectKey: "group-chat-uploads/grp/doc.pdf" }],
        },
      },
    ]);
    mocks.groupMessagePinRepo.countPinsByRoom.mockResolvedValue(1);

    const res = await request(app)
      .get(`${BASE}/${ROOM}/pins`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
    // Resolve-on-read: raw object keys → download URLs on the pin-list boundary.
    expect(res.body.data.data[0].senderAvatar).toBe(
      "https://media.test/aimess-avatars/avatars/u/a.png"
    );
    expect(res.body.data.data[0].contentPinned.files[0].url).toBe(
      "https://media.test/aimess-chat-test/group-chat-uploads/grp/doc.pdf"
    );
  });

  it("POSITIVE: forward to a target room emits message:new", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "src",
      roomId: ROOM,
      isDeleted: false,
      messageType: "TEXT",
      content: { text: "fwd" },
      createdAt: new Date(1),
    });
    mocks.groupMessageRepo.createForwardedMessage.mockResolvedValue({
      id: "fwd1",
      messageType: "TEXT",
      content: { text: "fwd" },
      createdAt: new Date(2),
    });

    const res = await request(app)
      .post(`${BASE}/${ROOM}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: "grp_target" });

    expect(res.status).toBe(201);
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      "conv:grp_target",
      expect.stringContaining("message:new")
    );
  });

  it("SECURITY: 403 forwarding into a room the caller isn't a member of", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post(`${BASE}/${ROOM}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: "grp_target" });

    expect(res.status).toBe(403);
  });

  it("NEGATIVE: 400 when targetRoomId is too short on forward", async () => {
    const res = await request(app)
      .post(`${BASE}/${ROOM}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: "ab" });

    expect(res.status).toBe(400);
  });

  it("POSITIVE: get reactions returns grouped result", async () => {
    mocks.groupMessageRepo.getReactions.mockResolvedValue({
      "🔥": ["u1", "u2"],
    });

    const res = await request(app)
      .get(`${BASE}/${ROOM}/messages/g1/reactions`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.reactions["🔥"].count).toBe(2);
  });

  it("NEGATIVE: 404 reactions for a missing message", async () => {
    mocks.groupMessageRepo.getReactions.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/${ROOM}/messages/g1/reactions`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });
});
