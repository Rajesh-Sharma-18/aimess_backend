/**
 * Integration tests — bulk (multi-select) conversation operations.
 * Routes (apps/chat-service/src/api/routes/conversation-bulk.routes.ts):
 *   POST /api/chat/conversations/leave/bulk
 *   POST /api/chat/conversations/mute/bulk
 *   POST /api/chat/conversations/read/bulk
 *
 * These are the chat counterparts of community-service's
 * /communities/{leave,mute,read}/bulk. The property under test throughout is
 * that a bulk call routes each roomId to the SAME single-conversation code
 * path the one-off REST route uses — so the side effects a lone call produces
 * (system message, roster fan-out, read receipt, read_sync, mute event) all
 * still fire, and a mixed PRIVATE + GROUP selection is dispatched by room-id
 * prefix with no `type` from the client.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const PRIVATE_ROOM = "prv_room_1";
const PRIVATE_ROOM_2 = "prv_room_2";
const GROUP_ROOM = "grp_room_1";
const MSG_ID = "507f1f77bcf86cd799439011";

const auth = () => bearer(makeAccessToken());

beforeEach(() => {
  ({ app, mocks } = buildApp());
});

/** Every JSON payload published on a given Redis channel, parsed. */
function publishedOn(channel: string): Array<{ event: string; data: any }> {
  return mocks.redis.publish.mock.calls
    .filter((call: unknown[]) => call[0] === channel)
    .map((call: unknown[]) => JSON.parse(call[1] as string));
}

describe("POST /conversations/leave/bulk", () => {
  it("POSITIVE: mixed selection — private rows delete-for-me, group rows leave for real", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: PRIVATE_ROOM,
      participants: [TEST_USER_ID, "peer_1"],
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: GROUP_ROOM,
      userId: TEST_USER_ID,
      status: "ACTIVE",
      role: "MEMBER",
    });
    // Remaining roster the group:member:removed fan-out is addressed to.
    mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
      { userId: "member_2" },
    ]);

    const res = await request(app)
      .post("/api/chat/conversations/leave/bulk")
      .set(auth())
      .send({ roomIds: [PRIVATE_ROOM, GROUP_ROOM] });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      { roomId: PRIVATE_ROOM, type: "PRIVATE", status: "DELETED" },
      { roomId: GROUP_ROOM, type: "GROUP", status: "LEFT" },
    ]);
    expect(res.body.data.summary).toEqual({
      requested: 2,
      succeeded: 2,
      failed: 0,
    });

    // Private → the same delete-for-me write + conv:deleted the one-off route makes.
    expect(mocks.privateRoomRepo.setDeletedFor).toHaveBeenCalledWith(
      PRIVATE_ROOM,
      TEST_USER_ID
    );
    // Group → REAL membership removal, not a local hide.
    expect(mocks.groupMemberRepo.updateStatus).toHaveBeenCalledWith(
      GROUP_ROOM,
      TEST_USER_ID,
      "LEFT",
      expect.objectContaining({ leftAt: expect.any(Date) })
    );
    expect(mocks.groupRoomRepo.incMemberCount).toHaveBeenCalledWith(
      GROUP_ROOM,
      -1
    );
    // …and the same fan-out: group:removed to the leaver, roster event to the room.
    expect(
      publishedOn(`user:${TEST_USER_ID}`).some(
        (e) => e.event === "group:removed"
      )
    ).toBe(true);
    expect(
      publishedOn(`conv:${GROUP_ROOM}`).some(
        (e) => e.event === "group:member:removed"
      )
    ).toBe(true);
  });

  it("POSITIVE: groupAction DELETE clears history and keeps membership", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: GROUP_ROOM,
      userId: TEST_USER_ID,
      status: "ACTIVE",
      role: "MEMBER",
    });

    const res = await request(app)
      .post("/api/chat/conversations/leave/bulk")
      .set(auth())
      .send({ roomIds: [GROUP_ROOM], groupAction: "DELETE" });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0]).toEqual({
      roomId: GROUP_ROOM,
      type: "GROUP",
      status: "DELETED",
    });
    expect(mocks.groupMemberRepo.setClearedAt).toHaveBeenCalledWith(
      GROUP_ROOM,
      TEST_USER_ID
    );
    expect(mocks.groupMemberRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("NEGATIVE: partial failure — the admin row fails, the others still complete", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: PRIVATE_ROOM,
      participants: [TEST_USER_ID, "peer_1"],
    });
    // The group the caller owns → CHAT_OWNER_CANNOT_LEAVE.
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: GROUP_ROOM,
      userId: TEST_USER_ID,
      status: "ACTIVE",
      role: "ADMIN",
    });

    const res = await request(app)
      .post("/api/chat/conversations/leave/bulk")
      .set(auth())
      .send({ roomIds: [PRIVATE_ROOM, GROUP_ROOM] });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      { roomId: PRIVATE_ROOM, type: "PRIVATE", status: "DELETED" },
      {
        roomId: GROUP_ROOM,
        type: "GROUP",
        status: "FAILED",
        errorCode: "OWNER_CANNOT_LEAVE",
      },
    ]);
    expect(res.body.data.summary).toEqual({
      requested: 2,
      succeeded: 1,
      failed: 1,
    });
    // The successful item is NOT rolled back by the later failure.
    expect(mocks.privateRoomRepo.setDeletedFor).toHaveBeenCalledWith(
      PRIVATE_ROOM,
      TEST_USER_ID
    );
  });

  it("NEGATIVE: a room the caller doesn't belong to fails without touching it", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: PRIVATE_ROOM,
      participants: ["someone_else", "peer_1"],
    });

    const res = await request(app)
      .post("/api/chat/conversations/leave/bulk")
      .set(auth())
      .send({ roomIds: [PRIVATE_ROOM] });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0].status).toBe("FAILED");
    expect(res.body.data.results[0].errorCode).toBe("NOT_FOUND");
    expect(mocks.privateRoomRepo.setDeletedFor).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 400 on an empty roomIds array", async () => {
    const res = await request(app)
      .post("/api/chat/conversations/leave/bulk")
      .set(auth())
      .send({ roomIds: [] });

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 401 without a token", async () => {
    const res = await request(app)
      .post("/api/chat/conversations/leave/bulk")
      .send({ roomIds: [PRIVATE_ROOM] });

    expect(res.status).toBe(401);
  });
});

describe("POST /conversations/mute/bulk", () => {
  it("POSITIVE: mutes private + group with one server-computed expiry and emits conv:muted per room", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: PRIVATE_ROOM,
      participants: [TEST_USER_ID, "peer_1"],
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: GROUP_ROOM,
      userId: TEST_USER_ID,
      status: "ACTIVE",
      role: "MEMBER",
    });

    const before = Date.now();
    const res = await request(app)
      .post("/api/chat/conversations/mute/bulk")
      .set(auth())
      .send({
        action: "mute",
        roomIds: [PRIVATE_ROOM, GROUP_ROOM],
        durationMinutes: 60,
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      muted: [PRIVATE_ROOM, GROUP_ROOM],
      skipped: [],
    });

    // durationMinutes is resolved against the SERVER clock, once for the batch.
    const [, , privateUntil] = mocks.privateRoomRepo.setMuted.mock.calls[0];
    const [, , groupUntil] = mocks.groupMemberRepo.setMuted.mock.calls[0];
    expect(privateUntil.getTime()).toBe(groupUntil.getTime());
    expect(privateUntil.getTime()).toBeGreaterThanOrEqual(before + 59 * 60_000);
    expect(privateUntil.getTime()).toBeLessThanOrEqual(
      Date.now() + 60 * 60_000
    );

    // Multi-device sync: one conv:muted per room on the caller's own channel.
    const muteEvents = publishedOn(`user:${TEST_USER_ID}`).filter(
      (e) => e.event === "conv:muted"
    );
    expect(muteEvents.map((e) => e.data.roomId).sort()).toEqual(
      [GROUP_ROOM, PRIVATE_ROOM].sort()
    );
    expect(muteEvents.every((e) => e.data.isMuted === true)).toBe(true);
    expect(muteEvents.every((e) => typeof e.data.mutedUntil === "string")).toBe(
      true
    );
  });

  it("POSITIVE: omitted durationMinutes means an indefinite mute (mutedUntil null)", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: PRIVATE_ROOM,
      participants: [TEST_USER_ID, "peer_1"],
    });

    const res = await request(app)
      .post("/api/chat/conversations/mute/bulk")
      .set(auth())
      .send({ action: "mute", roomIds: [PRIVATE_ROOM] });

    expect(res.status).toBe(200);
    expect(mocks.privateRoomRepo.setMuted).toHaveBeenCalledWith(
      PRIVATE_ROOM,
      TEST_USER_ID,
      null
    );
    const [event] = publishedOn(`user:${TEST_USER_ID}`).filter(
      (e) => e.event === "conv:muted"
    );
    expect(event.data.mutedUntil).toBeNull();
  });

  it("POSITIVE: unmute clears state and emits conv:unmuted", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: PRIVATE_ROOM,
      participants: [TEST_USER_ID, "peer_1"],
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: GROUP_ROOM,
      userId: TEST_USER_ID,
      status: "ACTIVE",
      role: "MEMBER",
    });

    const res = await request(app)
      .post("/api/chat/conversations/mute/bulk")
      .set(auth())
      .send({ action: "unmute", roomIds: [PRIVATE_ROOM, GROUP_ROOM] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      unmuted: [PRIVATE_ROOM, GROUP_ROOM],
      skipped: [],
    });
    expect(mocks.privateRoomRepo.setUnmuted).toHaveBeenCalledWith(
      PRIVATE_ROOM,
      TEST_USER_ID
    );
    expect(mocks.groupMemberRepo.setUnmuted).toHaveBeenCalledWith(
      GROUP_ROOM,
      TEST_USER_ID
    );
    expect(
      publishedOn(`user:${TEST_USER_ID}`).filter(
        (e) => e.event === "conv:unmuted"
      )
    ).toHaveLength(2);
  });

  it("NEGATIVE: an unreachable room is skipped, not fatal — the rest still mute", async () => {
    mocks.privateRoomRepo.findByRoomId.mockImplementation(
      async (roomId: string) =>
        roomId === PRIVATE_ROOM
          ? { roomId, participants: [TEST_USER_ID, "peer_1"] }
          : null
    );

    const res = await request(app)
      .post("/api/chat/conversations/mute/bulk")
      .set(auth())
      .send({ action: "mute", roomIds: [PRIVATE_ROOM, PRIVATE_ROOM_2] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      muted: [PRIVATE_ROOM],
      skipped: [PRIVATE_ROOM_2],
    });
  });

  it("NEGATIVE: 400 on an unknown action", async () => {
    const res = await request(app)
      .post("/api/chat/conversations/mute/bulk")
      .set(auth())
      .send({ action: "silence", roomIds: [PRIVATE_ROOM] });

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 400 when more than 50 rooms are selected", async () => {
    const res = await request(app)
      .post("/api/chat/conversations/mute/bulk")
      .set(auth())
      .send({
        action: "mute",
        roomIds: Array.from({ length: 51 }, (_, i) => `prv_room_${i}`),
      });

    expect(res.status).toBe(400);
  });
});

describe("POST /conversations/read/bulk", () => {
  it("POSITIVE: reads each room up to its CURRENT last message and fans out receipts", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: PRIVATE_ROOM,
      participants: [TEST_USER_ID, "peer_1"],
      lastMessageId: MSG_ID,
      unreadCountByUser: { [TEST_USER_ID]: 0 },
    });
    mocks.privateRoomRepo.markReadUpTo.mockResolvedValue({
      roomId: PRIVATE_ROOM,
      participants: [TEST_USER_ID, "peer_1"],
      lastMessageId: MSG_ID,
      unreadCountByUser: { [TEST_USER_ID]: 0 },
    });
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: MSG_ID,
      roomId: PRIVATE_ROOM,
      sequenceNumber: 12,
      createdAt: new Date(1000),
    });

    const res = await request(app)
      .post("/api/chat/conversations/read/bulk")
      .set(auth())
      .send({ roomIds: [PRIVATE_ROOM] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updatedCount: 1 });

    // Boundary comes from the server, never the client.
    expect(mocks.privateRoomRepo.markReadUpTo).toHaveBeenCalledWith({
      roomId: PRIVATE_ROOM,
      userId: TEST_USER_ID,
      upToMessageId: MSG_ID,
    });
    // Same effects as the per-room POST .../read: sender receipt + own-device sync.
    expect(
      publishedOn(`conv:${PRIVATE_ROOM}`).some(
        (e) => e.event === "message:read"
      )
    ).toBe(true);
    expect(
      publishedOn(`user:${TEST_USER_ID}`).some((e) => e.event === "read_sync")
    ).toBe(true);
  });

  it("POSITIVE: a group row resolves its boundary from the group room, not the private one", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: GROUP_ROOM,
      lastMessageId: MSG_ID,
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: GROUP_ROOM,
      userId: TEST_USER_ID,
      status: "ACTIVE",
    });
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: MSG_ID,
      roomId: GROUP_ROOM,
      sequenceNumber: 7,
      createdAt: new Date(1000),
    });
    mocks.groupMessageRepo.countUnreadAfter.mockResolvedValue(0);

    const res = await request(app)
      .post("/api/chat/conversations/read/bulk")
      .set(auth())
      .send({ roomIds: [GROUP_ROOM] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updatedCount: 1 });
    expect(mocks.groupMemberRepo.advanceReadPointer).toHaveBeenCalledWith(
      GROUP_ROOM,
      TEST_USER_ID,
      MSG_ID,
      new Date(1000),
      0
    );
  });

  it("NEGATIVE: an empty conversation is skipped and never counted", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: PRIVATE_ROOM,
      participants: [TEST_USER_ID, "peer_1"],
      lastMessageId: null,
    });

    const res = await request(app)
      .post("/api/chat/conversations/read/bulk")
      .set(auth())
      .send({ roomIds: [PRIVATE_ROOM] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updatedCount: 0 });
    expect(mocks.privateRoomRepo.markReadUpTo).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 400 when roomIds is missing", async () => {
    const res = await request(app)
      .post("/api/chat/conversations/read/bulk")
      .set(auth())
      .send({});

    expect(res.status).toBe(400);
  });
});
