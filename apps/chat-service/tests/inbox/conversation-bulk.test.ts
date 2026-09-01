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
jest.mock("../../src/events/unread-summary-bridge.js", () => ({
  notifyUnreadChanged: jest.fn(),
  registerUnreadSummaryPusher: jest.fn(),
}));

import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { notifyUnreadChanged } from "../../src/events/unread-summary-bridge.js";

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
    // Delete Conversation reads the membership row at ANY list-visible status
    // (ACTIVE/LEFT/KICKED), not the ACTIVE-only finder — a removed member has
    // to be able to delete their read-only row too.
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
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

  // "Delete Conversation" on a group the caller is still ACTIVE in: WhatsApp
  // semantics — leave AND drop the row, instead of the read-only LEFT row a
  // plain "LEAVE" leaves behind.
  describe('groupAction "LEAVE_AND_DELETE"', () => {
    const activeMember = () => {
      mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
        roomId: GROUP_ROOM,
        userId: TEST_USER_ID,
        status: "ACTIVE",
        role: "MEMBER",
      });
      mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
        roomId: GROUP_ROOM,
        userId: TEST_USER_ID,
        status: "ACTIVE",
        role: "MEMBER",
      });
      mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
        { userId: "member_2" },
      ]);
    };

    const call = () =>
      request(app)
        .post("/api/chat/conversations/leave/bulk")
        .set(auth())
        .send({ roomIds: [GROUP_ROOM], groupAction: "LEAVE_AND_DELETE" });

    it("POSITIVE: an active member leaves AND the row is cleared, in one call", async () => {
      activeMember();

      const res = await call();

      expect(res.status).toBe(200);
      expect(res.body.data.results[0]).toEqual({
        roomId: GROUP_ROOM,
        type: "GROUP",
        status: "LEFT",
      });
      // Both halves ran — real membership removal…
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
      // …and the caller's own clearedAt cutoff, which is what takes the row out
      // of their inbox and their group search results.
      expect(mocks.groupMemberRepo.setClearedAt).toHaveBeenCalledWith(
        GROUP_ROOM,
        TEST_USER_ID
      );
      // The existing leave fan-out is unchanged: the leaver hears group:removed,
      // the remaining roster hears group:member:removed.
      expect(
        publishedOn(`user:${TEST_USER_ID}`).filter(
          (e) => e.event === "group:removed"
        )
      ).toHaveLength(1);
      expect(
        publishedOn(`conv:${GROUP_ROOM}`).some(
          (e) => e.event === "group:member:removed"
        )
      ).toBe(true);
    });

    // A MODERATOR is an ordinary leaver: the only role the leave gate rejects is
    // ADMIN, so moderation rights never trap someone in a group. (They come back
    // as a plain MEMBER if re-added — see group-member.test.ts REJOIN.)
    it("POSITIVE: a MODERATOR leaves and is cleared, same as a member", async () => {
      mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
        roomId: GROUP_ROOM,
        userId: TEST_USER_ID,
        status: "ACTIVE",
        role: "MODERATOR",
      });
      mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
        roomId: GROUP_ROOM,
        userId: TEST_USER_ID,
        status: "ACTIVE",
        role: "MODERATOR",
      });
      mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
        { userId: "member_2" },
      ]);

      const res = await call();

      expect(res.status).toBe(200);
      expect(res.body.data.results[0]).toEqual({
        roomId: GROUP_ROOM,
        type: "GROUP",
        status: "LEFT",
      });
      expect(mocks.groupMemberRepo.updateStatus).toHaveBeenCalledWith(
        GROUP_ROOM,
        TEST_USER_ID,
        "LEFT",
        expect.objectContaining({ leftAt: expect.any(Date) })
      );
      expect(mocks.groupMemberRepo.setClearedAt).toHaveBeenCalledWith(
        GROUP_ROOM,
        TEST_USER_ID
      );
    });

    // Scenario 6/7 — a double-click, a second device, or an admin who removed
    // the caller while the confirm dialog sat open. The membership has already
    // ended, which IS the caller's intent, so the clear still runs.
    it("IDEMPOTENT: already not a member — still clears, emits no second leave", async () => {
      mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);
      mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
        roomId: GROUP_ROOM,
        userId: TEST_USER_ID,
        status: "LEFT",
        role: "MEMBER",
      });

      const res = await call();

      expect(res.status).toBe(200);
      expect(res.body.data.results[0]).toEqual({
        roomId: GROUP_ROOM,
        type: "GROUP",
        status: "LEFT",
      });
      expect(mocks.groupMemberRepo.setClearedAt).toHaveBeenCalledWith(
        GROUP_ROOM,
        TEST_USER_ID
      );
      // No duplicate status flip, no duplicate member-count decrement, and no
      // second MEMBER_LEFT / group:removed for the remaining members to render.
      expect(mocks.groupMemberRepo.updateStatus).not.toHaveBeenCalled();
      expect(mocks.groupRoomRepo.incMemberCount).not.toHaveBeenCalled();
      expect(
        publishedOn(`user:${TEST_USER_ID}`).some(
          (e) => e.event === "group:removed"
        )
      ).toBe(false);
    });

    // The owner has to transfer ownership or disband — clearing their
    // conversation while they stay in the group would be the wrong half.
    it("NEGATIVE: the owner fails with OWNER_CANNOT_LEAVE and is NOT cleared", async () => {
      mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
        roomId: GROUP_ROOM,
        userId: TEST_USER_ID,
        status: "ACTIVE",
        role: "ADMIN",
      });

      const res = await call();

      expect(res.status).toBe(200);
      expect(res.body.data.results[0]).toEqual({
        roomId: GROUP_ROOM,
        type: "GROUP",
        status: "FAILED",
        errorCode: "OWNER_CANNOT_LEAVE",
      });
      expect(mocks.groupMemberRepo.setClearedAt).not.toHaveBeenCalled();
      expect(mocks.groupMemberRepo.updateStatus).not.toHaveBeenCalled();
    });

    // Scenario 10 — the action is GROUP-only; a private row in the same call is
    // still plain delete-for-me, with no membership concept involved.
    it("PRIVATE rows ignore the action and still run delete-for-me", async () => {
      activeMember();
      mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
        roomId: PRIVATE_ROOM,
        participants: [TEST_USER_ID, "peer_1"],
      });

      const res = await request(app)
        .post("/api/chat/conversations/leave/bulk")
        .set(auth())
        .send({
          roomIds: [PRIVATE_ROOM, GROUP_ROOM],
          groupAction: "LEAVE_AND_DELETE",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.results).toEqual([
        { roomId: PRIVATE_ROOM, type: "PRIVATE", status: "DELETED" },
        { roomId: GROUP_ROOM, type: "GROUP", status: "LEFT" },
      ]);
      expect(mocks.privateRoomRepo.setDeletedFor).toHaveBeenCalledWith(
        PRIVATE_ROOM,
        TEST_USER_ID
      );
    });
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

  /**
   * The Chats nav badge is a TOTAL the server owns, and both delete paths zero
   * the caller's stored counter (`setDeletedFor` / `setClearedAt`). Without this
   * push the badge keeps counting messages that are now behind the delete cutoff
   * — on EVERY device — until the client's staleTime lapses and the tab is
   * refocused. Asserted for both room kinds because they are two separate
   * services with two separate writes.
   */
  it("POSITIVE: deleting recomputes the caller's nav-badge total", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: PRIVATE_ROOM,
      participants: [TEST_USER_ID, "peer_1"],
    });
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      roomId: GROUP_ROOM,
      userId: TEST_USER_ID,
      status: "LEFT",
      role: "MEMBER",
    });

    const res = await request(app)
      .post("/api/chat/conversations/leave/bulk")
      .set(auth())
      .send({ roomIds: [PRIVATE_ROOM, GROUP_ROOM], groupAction: "DELETE" });

    expect(res.status).toBe(200);
    expect(res.body.data.summary.succeeded).toBe(2);
    // Once per deleted room, always for the DELETER — never for the peer, whose
    // own copy of the conversation is untouched.
    expect(notifyUnreadChanged).toHaveBeenCalledWith(TEST_USER_ID);
    expect(notifyUnreadChanged).not.toHaveBeenCalledWith("peer_1");
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
      failed: [],
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
      failed: [],
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
      // `skipped` alone can't be told apart from "already done" — the reason is
      // what lets the client show the row as failed instead of muted.
      failed: [{ roomId: PRIVATE_ROOM_2, errorCode: "NOT_FOUND" }],
    });
  });

  // The exact payload the iOS client sends. camelCase stays canonical; these
  // aliases exist because the mobile DTOs serialize snake_case and every such
  // request used to die at the validator with 400 "roomIds Required".
  it("POSITIVE: accepts the snake_case payload (room_ids / duration_minutes)", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: GROUP_ROOM,
      userId: TEST_USER_ID,
      status: "ACTIVE",
      role: "MEMBER",
    });

    const res = await request(app)
      .post("/api/chat/conversations/mute/bulk")
      .set(auth())
      .send({
        duration_minutes: 10,
        room_ids: [GROUP_ROOM],
        action: "mute",
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      muted: [GROUP_ROOM],
      skipped: [],
      failed: [],
    });
    const [, , until] = mocks.groupMemberRepo.setMuted.mock.calls[0];
    expect(until.getTime()).toBeGreaterThan(Date.now());
    expect(until.getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
  });

  it("NEGATIVE: a COMMUNITY id is reported UNSUPPORTED_ROOM_TYPE, never a silent no-op", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: PRIVATE_ROOM,
      participants: [TEST_USER_ID, "peer_1"],
    });
    const communityId = "a".repeat(24);

    const res = await request(app)
      .post("/api/chat/conversations/mute/bulk")
      .set(auth())
      .send({ action: "mute", room_ids: [PRIVATE_ROOM, communityId] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      muted: [PRIVATE_ROOM],
      skipped: [communityId],
      failed: [{ roomId: communityId, errorCode: "UNSUPPORTED_ROOM_TYPE" }],
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
    expect(res.body.data).toEqual({
      updatedCount: 1,
      updated: [PRIVATE_ROOM],
      failed: [],
    });

    // Boundary comes from the server, never the client.
    expect(mocks.privateRoomRepo.markReadUpTo).toHaveBeenCalledWith({
      roomId: PRIVATE_ROOM,
      userId: TEST_USER_ID,
      upToMessageId: MSG_ID,
      givesReceipts: true,
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
    expect(res.body.data).toEqual({
      updatedCount: 1,
      updated: [GROUP_ROOM],
      failed: [],
    });
    expect(mocks.groupMemberRepo.advanceReadPointer).toHaveBeenCalledWith(
      GROUP_ROOM,
      TEST_USER_ID,
      MSG_ID,
      new Date(1000),
      0,
      true
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
    // Nothing to read is already read — not a failure.
    expect(res.body.data).toEqual({
      updatedCount: 0,
      updated: [],
      failed: [],
    });
    expect(mocks.privateRoomRepo.markReadUpTo).not.toHaveBeenCalled();
  });

  it("POSITIVE: accepts the snake_case payload (room_ids, plus an ignored action)", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: PRIVATE_ROOM,
      participants: [TEST_USER_ID, "peer_1"],
      lastMessageId: null,
    });

    const res = await request(app)
      .post("/api/chat/conversations/read/bulk")
      .set(auth())
      .send({ room_ids: [PRIVATE_ROOM], action: "read" });

    expect(res.status).toBe(200);
  });

  it("NEGATIVE: 400 when roomIds is missing", async () => {
    const res = await request(app)
      .post("/api/chat/conversations/read/bulk")
      .set(auth())
      .send({});

    expect(res.status).toBe(400);
  });
});
