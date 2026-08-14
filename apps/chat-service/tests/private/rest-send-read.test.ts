/**
 * Integration tests — private REST send + mark-read (the orchestrator fallback).
 * Routes (apps/chat-service/src/api/routes/private-message.routes.ts):
 *   POST /rooms/:roomId/messages        (send  → ChatMessageOrchestrator.sendDirect)
 *   POST /rooms/:roomId/read            (read  → ChatMessageOrchestrator.markReadDirect)
 *
 * These exercise the REAL controller → orchestrator → PrivateMessageService path
 * with mock repos (the app-factory harness), so routing, Zod validation, the
 * friendship gate, idempotency marking, and the Redis fan-out all run for real.
 *
 * Idempotency note: a replay is detected via the `isIdempotentReplay` Symbol the
 * service stamps when `findByClientMessageId` returns a pre-existing row — NOT a
 * stale createdAt. The 200/idempotent test drives that by making the repo's
 * findByClientMessageId return an existing row, then asserts NO new insert and NO
 * duplicate `message:new` broadcast.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "prv_room_1";
const PEER = "peer_user_1";

beforeEach(() => {
  ({ app, mocks } = buildApp());
  // resolveSenderIdentity → userSnapshotService → cacheRepo.getUserSnapshots
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("POST /rooms/:roomId/messages (send → orchestrator)", () => {
  it("POSITIVE: 201 on a fresh insert, idempotent:false, broadcasts message:new once", async () => {
    mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
    mocks.privateMessageRepo.findByClientMessageId.mockResolvedValue(null);
    mocks.privateRoomRepo.allocateSequence.mockResolvedValue(5);
    mocks.privateMessageRepo.createMessage.mockResolvedValue({
      id: "msg_new_1",
      messageType: "TEXT",
      content: { text: "hello" },
      sequenceNumber: 5,
      createdAt: new Date(1000),
    });

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({
        receiverId: PEER,
        content: { text: "hello" },
        messageType: "TEXT",
        clientMessageId: "cmid-fresh-1",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe("msg_new_1");
    expect(res.body.data.idempotent).toBe(false);
    // Canonical wire shape: contentType UPPER, serverTs present, no createdAt.
    expect(res.body.data.contentType).toBe("TEXT");
    expect(res.body.data.serverTs).toBe(1000);
    expect(res.body.data.createdAt).toBeUndefined();

    expect(mocks.privateMessageRepo.createMessage).toHaveBeenCalledTimes(1);
    const newBroadcasts = mocks.redis.publish.mock.calls.filter(
      (c: unknown[]) =>
        c[0] === `conv:${ROOM}` &&
        typeof c[1] === "string" &&
        (c[1] as string).includes("message:new")
    );
    expect(newBroadcasts).toHaveLength(1);
  });

  it("IDEMPOTENT: 200 + idempotent:true on a clientMessageId replay; no insert, no duplicate message:new", async () => {
    mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
    // Pre-existing row for the same clientMessageId → the REAL service marks it
    // via markIdempotentReplay → the orchestrator suppresses every live effect.
    mocks.privateMessageRepo.findByClientMessageId.mockResolvedValue({
      id: "msg_existing_1",
      messageType: "TEXT",
      content: { text: "hello" },
      sequenceNumber: 5,
      createdAt: new Date(1000),
    });

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({
        receiverId: PEER,
        content: { text: "hello" },
        messageType: "TEXT",
        clientMessageId: "cmid-replay-1",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe("msg_existing_1");
    expect(res.body.data.idempotent).toBe(true);

    // Replay must NOT insert a new row …
    expect(mocks.privateMessageRepo.createMessage).not.toHaveBeenCalled();
    // … and must NOT re-broadcast the bubble.
    const newBroadcasts = mocks.redis.publish.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[1] === "string" && (c[1] as string).includes("message:new")
    );
    expect(newBroadcasts).toHaveLength(0);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages`)
      .send({ receiverId: PEER, content: { text: "hi" }, messageType: "TEXT" });
    expect(res.status).toBe(401);
  });

  it("NEGATIVE: 400 on an invalid messageType enum", async () => {
    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({
        receiverId: PEER,
        content: { text: "hi" },
        messageType: "NONSENSE",
      });
    expect(res.status).toBe(400);
    expect(mocks.privateMessageRepo.createMessage).not.toHaveBeenCalled();
  });

  it("SECURITY: 403 when the sender and receiver are not friends", async () => {
    mocks.userServiceClient.checkFriendship.mockResolvedValue(false);
    mocks.privateMessageRepo.findByClientMessageId.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({ receiverId: PEER, content: { text: "hi" }, messageType: "TEXT" });

    expect(res.status).toBe(403);
    expect(mocks.privateMessageRepo.createMessage).not.toHaveBeenCalled();
  });
});

describe("POST /rooms/:roomId/read (mark-read → orchestrator)", () => {
  it("POSITIVE: 200 and emits both message:read (conv) and read_sync (reader)", async () => {
    // getMessageSequence → messageRepo.findById → sequenceNumber high-water mark.
    // `roomId` is required: the read target is bound to the room before the
    // watermark advances, so a target that names no room is rejected as a
    // no-op (readToSeq 0, nothing written, nothing published).
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "msg_hw_1",
      roomId: ROOM,
      sequenceNumber: 9,
    });
    mocks.privateRoomRepo.markReadUpTo.mockResolvedValue({
      participants: [TEST_USER_ID, PEER],
      unreadCountByUser: { [TEST_USER_ID]: 0 },
      lastMessageId: "msg_hw_1",
    });

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/read`)
      .set(bearer(makeAccessToken()))
      .send({ upToMessageId: "msg_hw_1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.readToSeq).toBe(9);

    // Advances the reader's pointer via the room repo.
    expect(mocks.privateRoomRepo.markReadUpTo).toHaveBeenCalled();
    // message:read receipt to the conversation (the peer).
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `conv:${ROOM}`,
      expect.stringContaining("message:read")
    );
    // read_sync to the reader's OWN other devices (user:<readerId>).
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `user:${TEST_USER_ID}`,
      expect.stringContaining("read_sync")
    );
  });

  it("NEGATIVE: 400 when upToMessageId is missing", async () => {
    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/read`)
      .set(bearer(makeAccessToken()))
      .send({});

    expect(res.status).toBe(400);
    expect(mocks.privateRoomRepo.markReadUpTo).not.toHaveBeenCalled();
  });
});
