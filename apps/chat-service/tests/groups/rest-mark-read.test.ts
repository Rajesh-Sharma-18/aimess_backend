/**
 * Integration tests — group REST mark-read (the orchestrator fallback).
 * Route (apps/chat-service/src/api/routes/group-message.routes.ts):
 *   POST /rooms/:roomId/read (read → ChatMessageOrchestrator.markReadDirect)
 *
 * Regression coverage for the consolidation of group's explicit mark-read onto
 * the SAME guarded, forward-only `advanceReadPointer` path getConversation's
 * implicit mark-read already used — the old `GroupMemberRepository#markRead`
 * had no optimistic-id guard, no forward-only check, and hard-zeroed unread.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_1";

beforeEach(() => {
  ({ app, mocks } = buildApp());
});

describe("POST /groups/rooms/:roomId/read (mark-read → orchestrator)", () => {
  it("POSITIVE: advances the pointer via advanceReadPointer, emits message:read + read_sync", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: ROOM,
      userId: TEST_USER_ID,
      status: "ACTIVE",
    });
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "507f1f77bcf86cd799439011",
      roomId: ROOM,
      sequenceNumber: 9,
      createdAt: new Date(1000),
    });
    mocks.groupMessageRepo.countUnreadAfter.mockResolvedValue(0);
    mocks.groupMemberRepo.advanceReadPointer.mockResolvedValue({
      roomId: ROOM,
      userId: TEST_USER_ID,
      lastReadMessageId: "507f1f77bcf86cd799439011",
      unreadCount: 0,
    });

    const res = await request(app)
      .post(`/api/chat/groups/rooms/${ROOM}/read`)
      .set(bearer(makeAccessToken()))
      .send({ upToMessageId: "507f1f77bcf86cd799439011" });

    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.readToSeq).toBe(9);

    expect(mocks.groupMemberRepo.advanceReadPointer).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      "507f1f77bcf86cd799439011",
      new Date(1000),
      0,
      // Read receipts on, so the exposable pointer advances with the read one.
      true
    );
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `conv:${ROOM}`,
      expect.stringContaining("message:read")
    );
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `user:${TEST_USER_ID}`,
      expect.stringContaining("read_sync")
    );
  });

  it("NEGATIVE: a STALE read reports the PERSISTED watermark, never the requested target", async () => {
    // The repo is forward-only: it refuses the older target and hands back the
    // untouched row. Reporting the request's own seq here would broadcast a
    // read_to_seq REGRESSION the database never made — the sender's blue tick
    // would drop back to grey and the reader's other devices would re-inflate
    // their badge, until a refresh re-read the (still correct) DB.
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: ROOM,
      userId: TEST_USER_ID,
      status: "ACTIVE",
    });
    mocks.groupMessageRepo.findById.mockImplementation((id: string) =>
      Promise.resolve(
        id === "507f1f77bcf86cd799439011"
          ? {
              id: "507f1f77bcf86cd799439011",
              roomId: ROOM,
              sequenceNumber: 3,
              createdAt: new Date(1000),
            }
          : {
              id: "507f1f77bcf86cd799439099",
              roomId: ROOM,
              sequenceNumber: 42,
              createdAt: new Date(9000),
            }
      )
    );
    mocks.groupMessageRepo.countUnreadAfter.mockResolvedValue(7);
    // Refused: pointer already at seq 42, unread already 0.
    mocks.groupMemberRepo.advanceReadPointer.mockResolvedValue({
      roomId: ROOM,
      userId: TEST_USER_ID,
      lastReadMessageId: "507f1f77bcf86cd799439099",
      unreadCount: 0,
    });

    const res = await request(app)
      .post(`/api/chat/groups/rooms/${ROOM}/read`)
      .set(bearer(makeAccessToken()))
      .send({ upToMessageId: "507f1f77bcf86cd799439011" });

    expect(res.status).toBe(200);
    expect(res.body.data.readToSeq).toBe(42);
    const readSync = mocks.redis.publish.mock.calls.find(
      (c: unknown[]) =>
        c[0] === `user:${TEST_USER_ID}` && String(c[1]).includes("read_sync")
    );
    expect(readSync).toBeDefined();
    const synced = JSON.parse(String(readSync?.[1])).data as {
      read_to_seq: number;
      unreadCount: number;
    };
    expect(synced.read_to_seq).toBe(42);
    // …and the reader's own badge stays at the persisted 0, not the 7 the
    // stale request's boundary would have implied.
    expect(synced.unreadCount).toBe(0);
  });

  it("NEGATIVE: an optimistic client id ('tmp-…') no-ops instead of throwing a malformed-ObjectId error", async () => {
    const res = await request(app)
      .post(`/api/chat/groups/rooms/${ROOM}/read`)
      .set(bearer(makeAccessToken()))
      .send({ upToMessageId: "tmp-1784266677955-0" });

    expect(res.status).toBe(200);
    expect(res.body.data.readToSeq).toBe(0);
    expect(mocks.groupMessageRepo.findById).not.toHaveBeenCalled();
    expect(mocks.groupMemberRepo.advanceReadPointer).not.toHaveBeenCalled();
  });

  it("POSITIVE: a client UUID resolves to its server message in this room", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: ROOM,
      userId: TEST_USER_ID,
      status: "ACTIVE",
    });
    const msg = {
      id: "507f1f77bcf86cd799439011",
      roomId: ROOM,
      sequenceNumber: 9,
      createdAt: new Date(1000),
    };
    mocks.groupMessageRepo.findByClientMessageId.mockImplementation(
      (roomId: string, cid: string) =>
        Promise.resolve(
          roomId === ROOM && cid === "4D74A9D7-EB8B-445A-8F29-C7AEB1E025BD"
            ? msg
            : null
        )
    );
    mocks.groupMessageRepo.countUnreadAfter.mockResolvedValue(0);
    mocks.groupMemberRepo.advanceReadPointer.mockResolvedValue({
      lastReadMessageId: msg.id,
      unreadCount: 0,
    });

    const res = await request(app)
      .post(`/api/chat/groups/rooms/${ROOM}/read`)
      .set(bearer(makeAccessToken()))
      .send({ upToMessageId: "4d74a9d7-eb8b-445a-8f29-c7aeb1e025bd" });

    expect(res.status).toBe(200);
    expect(res.body.data.readToSeq).toBe(9);
    expect(mocks.groupMemberRepo.advanceReadPointer).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      msg.id,
      msg.createdAt,
      0,
      true
    );
  });

  it("NEGATIVE: an unknown target reports the member's REAL pointer + unread, never a fake success", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: ROOM,
      userId: TEST_USER_ID,
      status: "ACTIVE",
      lastReadMessageId: "507f1f77bcf86cd799439011",
      unreadCount: 1,
    });
    mocks.groupMessageRepo.findById.mockImplementation((id: string) =>
      Promise.resolve(
        id === "507f1f77bcf86cd799439011"
          ? { id, roomId: ROOM, sequenceNumber: 5, createdAt: new Date(1000) }
          : null
      )
    );
    mocks.groupMessageRepo.findByClientMessageId.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/chat/groups/rooms/${ROOM}/read`)
      .set(bearer(makeAccessToken()))
      .send({ upToMessageId: "507f1f77bcf86cd7994390ff" });

    expect(res.status).toBe(200);
    expect(res.body.data.readToSeq).toBe(5);
    expect(mocks.groupMemberRepo.advanceReadPointer).not.toHaveBeenCalled();
    const readSync = mocks.redis.publish.mock.calls.find(
      (c: unknown[]) =>
        c[0] === `user:${TEST_USER_ID}` && String(c[1]).includes("read_sync")
    );
    expect(JSON.parse(String(readSync?.[1])).data.unreadCount).toBe(1);
  });

  it("NEGATIVE: 400 when upToMessageId is missing", async () => {
    const res = await request(app)
      .post(`/api/chat/groups/rooms/${ROOM}/read`)
      .set(bearer(makeAccessToken()))
      .send({});

    expect(res.status).toBe(400);
    expect(mocks.groupMemberRepo.advanceReadPointer).not.toHaveBeenCalled();
  });
});
