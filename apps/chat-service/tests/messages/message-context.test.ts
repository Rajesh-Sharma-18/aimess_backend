/**
 * Integration tests — unified cross-conversation-type message navigation API.
 * Route (apps/chat-service/src/api/routes/message-context.routes.ts, mounted at /api/chat/messages):
 *   GET /:messageId/context?conversationType=PRIVATE|GROUP|COMMUNITY&roomId=<roomId>
 *
 * One endpoint serving every "locate + scroll to a message" use case: reply,
 * pinned message, search result, shared-message/notification deep link — the
 * caller only ever needs the (conversationType, roomId, messageId) triple.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const BASE = "/api/chat/messages";

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("GET /:messageId/context — PRIVATE dispatch", () => {
  const ROOM = "prv_room_1";

  it("POSITIVE: isAvailable true with seq + compound-cursor anchor", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer"],
    });
    mocks.privateMessageRepo.findMessageMeta.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      isDeleted: false,
      deletedFor: {},
      sequenceNumber: 42,
      createdAt: new Date(1000),
    });

    const res = await request(app)
      .get(`${BASE}/m1/context?conversationType=PRIVATE&roomId=${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      messageId: "m1",
      roomId: ROOM,
      conversationType: "PRIVATE",
      isAvailable: true,
      anchor: {
        sequenceNumber: 42,
        beforeCursor: "1000_m1",
        afterCursor: "1000_m1",
      },
    });
  });

  it("NEGATIVE: 200 isAvailable:false when the message doesn't exist", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer"],
    });
    mocks.privateMessageRepo.findMessageMeta.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/missing/context?conversationType=PRIVATE&roomId=${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      isAvailable: false,
      error: { code: "MESSAGE_NOT_FOUND" },
    });
  });

  it("SECURITY: IDOR — 403 when the caller isn't a participant of the room", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: ["a", "b"],
    });

    const res = await request(app)
      .get(`${BASE}/m1/context?conversationType=PRIVATE&roomId=${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.privateMessageRepo.findMessageMeta).not.toHaveBeenCalled();
  });
});

describe("GET /:messageId/context — GROUP dispatch", () => {
  const ROOM = "grp_room_1";

  it("POSITIVE: isAvailable true with seq + compound-cursor anchor", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "g1",
      roomId: ROOM,
      isDeleted: false,
      deletedForUserIds: [],
      sequenceNumber: 7,
      createdAt: new Date(2000),
    });

    const res = await request(app)
      .get(`${BASE}/g1/context?conversationType=GROUP&roomId=${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      messageId: "g1",
      roomId: ROOM,
      conversationType: "GROUP",
      isAvailable: true,
      anchor: {
        sequenceNumber: 7,
        beforeCursor: "2000_g1",
        afterCursor: "2000_g1",
      },
    });
  });

  it("NEGATIVE: 200 isAvailable:false — cross-room IDOR (message belongs to a different room)", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "g1",
      roomId: "other_room",
      isDeleted: false,
      deletedForUserIds: [],
      sequenceNumber: 1,
      createdAt: new Date(1),
    });

    const res = await request(app)
      .get(`${BASE}/g1/context?conversationType=GROUP&roomId=${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.isAvailable).toBe(false);
  });

  it("SECURITY: 403 when the caller isn't an active member of the group", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/g1/context?conversationType=GROUP&roomId=${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.groupMessageRepo.findById).not.toHaveBeenCalled();
  });
});

describe("GET /:messageId/context — COMMUNITY dispatch", () => {
  const ROOM = "comm_room_1";

  it("POSITIVE: isAvailable true with a compound-cursor anchor (no sequenceNumber)", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "c1",
      roomId: ROOM,
      deletedForAll: false,
      createdAt: new Date(3000),
    });

    const res = await request(app)
      .get(`${BASE}/c1/context?conversationType=COMMUNITY&roomId=${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      messageId: "c1",
      roomId: ROOM,
      conversationType: "COMMUNITY",
      isAvailable: true,
      anchor: { beforeCursor: "3000_c1", afterCursor: "3000_c1" },
    });
    expect(res.body.data.anchor.sequenceNumber).toBeUndefined();
  });

  it("NEGATIVE: 200 isAvailable:false when the message was deleted for everyone", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "c1",
      roomId: ROOM,
      deletedForAll: true,
      createdAt: new Date(1),
    });

    const res = await request(app)
      .get(`${BASE}/c1/context?conversationType=COMMUNITY&roomId=${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.isAvailable).toBe(false);
  });

  it("SECURITY: 403 when the caller isn't a member of a private community", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/c1/context?conversationType=COMMUNITY&roomId=${ROOM}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.generalRoomMessageRepo.findById).not.toHaveBeenCalled();
  });
});

describe("GET /:messageId/context — validation & auth", () => {
  it("NEGATIVE: 400 for an invalid conversationType enum", async () => {
    const res = await request(app)
      .get(`${BASE}/m1/context?conversationType=BOGUS&roomId=room1`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 400 when roomId is missing", async () => {
    const res = await request(app)
      .get(`${BASE}/m1/context?conversationType=PRIVATE`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get(
      `${BASE}/m1/context?conversationType=PRIVATE&roomId=room1`
    );
    expect(res.status).toBe(401);
  });
});
