/**
 * Automatically Delete Messages (disappearing messages) — GROUP chats.
 *
 * The group twin of `tests/private/auto-delete.test.ts`, covering the four
 * things this feature can silently get wrong, plus the two rules that are
 * group-specific:
 *   1. WHO may change the timer — admin/moderator only, member is 403;
 *   2. WHICH timer a message gets — the room's one record, read off the same
 *      write that allocates the sequence;
 *   3. "After Viewing" being REJECTED — a group message carries one global
 *      deadline, so the old behaviour was "the first member to open the chat
 *      deletes it for everyone who hasn't";
 *   4. the sweeper deleting through the SAME delete-for-everyone path a manual
 *      delete uses, but `bySystem` so a departed/muted sender's messages still
 *      disappear — and claiming each row so two replicas cannot both delete it;
 *   5. the `not: null` guard on the sweeper query, without which Mongo treats
 *      "no timer" as "overdue" and deletes the entire group.
 *
 * Routes: GET/PUT /api/chat/groups/rooms/:roomId/auto-delete
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import {
  computeAutoDeleteStamp,
  readRoomAutoDelete,
} from "../../src/lib/auto-delete.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_autodelete_1";
const MEMBER_B = "member-b";
const url = `/api/chat/groups/rooms/${ROOM}/auto-delete`;

function publishes(): Array<{ channel: string; event: string; data: any }> {
  return mocks.redis.publish.mock.calls.map(
    ([channel, raw]: [string, string]) => ({
      channel,
      ...(JSON.parse(raw) as { event: string; data: any }),
    })
  );
}

function room(autoDelete: Record<string, unknown> | null = null) {
  return {
    id: "room-oid",
    roomId: ROOM,
    name: "Anime Fans",
    status: "ACTIVE",
    memberCount: 2,
    memberLimit: 256,
    autoDelete,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Put the caller in the room with `role`; ADMIN by default. */
function asRole(role: string) {
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
    roomId: ROOM,
    userId: TEST_USER_ID,
    role,
    status: "ACTIVE",
  });
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(room());
  mocks.groupRoomRepo.findByRoomId.mockResolvedValue(room());
  mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
    { userId: TEST_USER_ID, role: "ADMIN" },
    { userId: MEMBER_B, role: "MEMBER" },
  ]);
  // Mirrors the repository: ONE record for the room, stamped with who changed it.
  mocks.groupRoomRepo.setAutoDelete.mockImplementation(
    async (_roomId: string, userId: string, s: any) =>
      room({ ...s, setAt: new Date().toISOString(), setBy: userId })
  );
  mocks.groupRoomRepo.allocateSequence.mockResolvedValue(7);
  mocks.groupMessageRepo.create.mockImplementation(async (row: any) => ({
    ...row,
    id: "msg-new",
    createdAt: new Date(),
    revision: 1,
  }));
  asRole("ADMIN");
});

// ── 1. Who may change it (WhatsApp: admins only) ─────────────────────────────
describe("permission", () => {
  it("lets an ADMIN set the group timer", async () => {
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 604800 });

    expect(res.status).toBe(200);
    expect(mocks.groupRoomRepo.setAutoDelete).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      { mode: "TIMER", ttlSeconds: 604800 }
    );
    expect(res.body.data.mode).toBe("TIMER");
    expect(res.body.data.isEnabled).toBe(true);
    expect(res.body.data.label).toBe("7 days");
  });

  it("lets a MODERATOR set it too", async () => {
    asRole("MODERATOR");
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 86400 });
    expect(res.status).toBe(200);
    expect(mocks.groupRoomRepo.setAutoDelete).toHaveBeenCalledTimes(1);
  });

  it("reports canEdit per ROLE so the client can grey out the picker", async () => {
    asRole("MEMBER");
    const asMember = await request(app).get(url).set(bearer(makeAccessToken()));
    expect(asMember.body.data.canEdit).toBe(false);

    asRole("ADMIN");
    const asAdmin = await request(app).get(url).set(bearer(makeAccessToken()));
    expect(asAdmin.body.data.canEdit).toBe(true);
  });
});

// ── 1b. After Viewing is UNSUPPORTED for groups ──────────────────────────────
describe("After Viewing is rejected", () => {
  it("400s an ADMIN who asks for AFTER_VIEWING, and writes nothing", async () => {
    // One global `autoDeleteAt` per group message means "after viewing" can only
    // ever mean "after the FIRST member views it" — a silent delete-for-everyone
    // triggered by one reader. Refused rather than approximated.
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "AFTER_VIEWING" });

    expect(res.status).toBe(400);
    expect(res.body.message ?? res.body.error?.code ?? "").toBeDefined();
    expect(mocks.groupRoomRepo.setAutoDelete).not.toHaveBeenCalled();
    expect(
      mocks.groupMessageRepo.restampPendingAutoDeletes
    ).not.toHaveBeenCalled();
    expect(
      publishes().filter((p) => p.event === "conv:auto_delete:updated")
    ).toHaveLength(0);
  });

  it("advertises supportsAfterViewing=false on GET so clients hide the option", async () => {
    const res = await request(app).get(url).set(bearer(makeAccessToken()));
    expect(res.status).toBe(200);
    expect(res.body.data.capabilities.supportsAfterViewing).toBe(false);
    expect(res.body.data.conversationType).toBe("GROUP");
  });

  it("rejects a plain MEMBER with 403 and writes nothing", async () => {
    asRole("MEMBER");
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 86400 });

    expect(res.status).toBe(403);
    expect(mocks.groupRoomRepo.setAutoDelete).not.toHaveBeenCalled();
    expect(
      publishes().filter((p) => p.event === "conv:auto_delete:updated")
    ).toHaveLength(0);
  });

  it("404s a non-member rather than confirming the group exists", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);
    const res = await request(app).get(url).set(bearer(makeAccessToken()));
    expect(res.status).toBe(404);
  });

  it("lets any MEMBER READ the timer — it applies to them too", async () => {
    asRole("MEMBER");
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(
      room({ mode: "TIMER", ttlSeconds: 86400, setAt: "", setBy: MEMBER_B })
    );
    const res = await request(app).get(url).set(bearer(makeAccessToken()));
    expect(res.status).toBe(200);
    expect(res.body.data.ttlSeconds).toBe(86400);
  });
});

// ── 2. The setting write: fan-out, system message, restamp, no-op guard ──────
describe("updating the timer", () => {
  it("notifies EVERY active member with the same payload", async () => {
    await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 3600 });

    const events = publishes().filter(
      (p) => p.event === "conv:auto_delete:updated"
    );
    expect(events.map((e) => e.channel).sort()).toEqual(
      [`user:${MEMBER_B}`, `user:${TEST_USER_ID}`].sort()
    );
    expect(events[0].data).toEqual(events[1].data);
    expect(events[0].data.type).toBe("GROUP");
    expect(events[0].data.roomId).toBe(ROOM);
    expect(events[0].data.actorId).toBe(TEST_USER_ID);
  });

  it("publishes nothing when the write itself fails", async () => {
    mocks.groupRoomRepo.setAutoDelete.mockResolvedValue(null);
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 3600 });

    expect(res.status).toBe(404);
    expect(
      publishes().filter((p) => p.event === "conv:auto_delete:updated")
    ).toHaveLength(0);
  });

  it("posts a SYSTEM message so the room learns about it in-chat", async () => {
    await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 3600 });

    const rows = mocks.groupMessageRepo.create.mock.calls.map(
      ([arg]: [any]) => arg
    );
    const sys = rows.find((r: any) => r.systemEvent === "AUTO_DELETE_UPDATED");
    expect(sys).toBeDefined();
    expect(sys.systemData.mode).toBe("TIMER");
    expect(sys.systemData.durationLabel).toBe("1 hour");
    // The group renderer must produce the real line, not the "updated the
    // group" default it falls back to for unknown events.
    expect(sys.content.text).toContain("1 hour");
  });

  it("re-stamps messages already counting down, for the WHOLE room", async () => {
    await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 86400 });

    expect(
      mocks.groupMessageRepo.restampPendingAutoDeletes
    ).toHaveBeenCalledWith({
      roomId: ROOM,
      ttlSeconds: 86400,
      afterView: false,
    });
  });

  it("does NOT re-stamp when the timer is turned OFF", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(
      room({ mode: "TIMER", ttlSeconds: 3600, setAt: "", setBy: TEST_USER_ID })
    );
    await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "OFF" });

    expect(
      mocks.groupMessageRepo.restampPendingAutoDeletes
    ).not.toHaveBeenCalled();
  });

  it("is a no-op when the same option is tapped again", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(
      room({ mode: "TIMER", ttlSeconds: 3600, setAt: "", setBy: TEST_USER_ID })
    );
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 3600 });

    expect(res.status).toBe(200);
    expect(mocks.groupRoomRepo.setAutoDelete).not.toHaveBeenCalled();
    expect(
      publishes().filter((p) => p.event === "conv:auto_delete:updated")
    ).toHaveLength(0);
  });
});

// ── 3. Which stamp a new message carries ─────────────────────────────────────
describe("stamping sent messages", () => {
  it("reads the room's timer off the sequence allocation and stamps the row", async () => {
    const withTimer = room({
      mode: "TIMER",
      ttlSeconds: 3600,
      setAt: "",
      setBy: TEST_USER_ID,
    });
    mocks.groupRoomRepo.allocateSequenceWithRoom.mockResolvedValue({
      sequenceNumber: 9,
      room: withTimer,
    });

    await mocks.groupMessageService.sendMessage({
      roomId: ROOM,
      senderId: TEST_USER_ID,
      senderName: "Krish",
      senderAvatar: "",
      content: { text: "hello" },
      messageType: "TEXT",
    });

    const [row] = mocks.groupMessageRepo.create.mock.calls[0];
    expect(row.sequenceNumber).toBe(9);
    expect(row.autoDeleteAfterView).toBe(false);
    expect(row.autoDeleteAt).toBeInstanceOf(Date);
    expect((row.autoDeleteAt as Date).getTime() - Date.now()).toBeGreaterThan(
      3_500_000
    );
  });

  it("leaves the row unstamped when the group has no timer", async () => {
    await mocks.groupMessageService.sendMessage({
      roomId: ROOM,
      senderId: TEST_USER_ID,
      senderName: "Krish",
      senderAvatar: "",
      content: { text: "hello" },
      messageType: "TEXT",
    });

    const [row] = mocks.groupMessageRepo.create.mock.calls[0];
    expect(row.autoDeleteAt).toBeNull();
    expect(row.autoDeleteAfterView).toBe(false);
  });

  it("marks an AFTER_VIEWING message as waiting, with no deadline yet", () => {
    // The pure stamp function is shared with private and still understands the
    // mode; what changed is that no GROUP room can be put INTO that mode.
    const stamp = computeAutoDeleteStamp(
      readRoomAutoDelete(room({ mode: "AFTER_VIEWING", setAt: "" })),
      new Date()
    );
    expect(stamp).toEqual({ autoDeleteAt: null, autoDeleteAfterView: true });
  });
});

// ── 4. A group read NEVER arms anything ──────────────────────────────────────
describe("group reads never arm", () => {
  it("has no arming method on the repository at all", async () => {
    // Deleted rather than left unused: an unused method is an invitation to
    // call it again, and calling it deletes a message for members who never
    // opened the chat.
    const { GroupMessageRepository } =
      await import("../../src/repositories/group-message.repository.js");
    expect(
      (GroupMessageRepository.prototype as Record<string, unknown>)
        .armAfterViewing
    ).toBeUndefined();
  });

  it("markReadUpTo advances the watermark without arming", async () => {
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "507f1f77bcf86cd799439011",
      roomId: ROOM,
      createdAt: new Date(),
      sequenceNumber: 4,
    });

    const res = await mocks.groupMessageService.markReadUpTo({
      roomId: ROOM,
      userId: TEST_USER_ID,
      upToMessageId: "507f1f77bcf86cd799439011",
    });

    expect(res.readToSeq).toBe(4);
    expect(mocks.groupMemberRepo.advanceReadPointer).toHaveBeenCalledTimes(1);
    expect(mocks.groupMessageRepo.armAfterViewing).not.toHaveBeenCalled();
  });

  it("mutates nothing for a non-member", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);
    const res = await mocks.groupMessageService.markReadUpTo({
      roomId: ROOM,
      userId: TEST_USER_ID,
      upToMessageId: "507f1f77bcf86cd799439011",
    });
    expect(res).toEqual({ readToSeq: 0, remainingUnread: 0 });
    expect(mocks.groupMemberRepo.advanceReadPointer).not.toHaveBeenCalled();
    expect(mocks.groupMessageRepo.armAfterViewing).not.toHaveBeenCalled();
  });

  it("mutates nothing for a target belonging to ANOTHER room", async () => {
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "507f1f77bcf86cd799439011",
      roomId: "grp_somewhere_else",
      createdAt: new Date(),
      sequenceNumber: 99,
    });
    const res = await mocks.groupMessageService.markReadUpTo({
      roomId: ROOM,
      userId: TEST_USER_ID,
      upToMessageId: "507f1f77bcf86cd799439011",
    });
    expect(res).toEqual({ readToSeq: 0, remainingUnread: 0 });
    expect(mocks.groupMemberRepo.advanceReadPointer).not.toHaveBeenCalled();
  });
});

// ── 5. The sweeper ───────────────────────────────────────────────────────────

/** Stub the claim step with the rows this worker "won". */
function claims(
  rows: Array<{
    id: string;
    roomId: string;
    senderId: string | null;
    attempts: number;
  }>
): void {
  mocks.groupMessageRepo.claimDueAutoDeletes.mockResolvedValue(rows);
}

describe("group auto-delete sweeper", () => {
  it("deletes due messages bySystem, through the normal delete path", async () => {
    const { groupAutoDeleteService, chatMessageOrchestrator } = mocks as any;
    const deleteDirect = jest
      .spyOn(chatMessageOrchestrator, "deleteDirect")
      .mockResolvedValue({ tombstone: { messageId: "msg-1" } } as any);

    claims([
      { id: "msg-1", roomId: ROOM, senderId: TEST_USER_ID, attempts: 1 },
      { id: "msg-2", roomId: ROOM, senderId: MEMBER_B, attempts: 1 },
      // System messages are never stamped; guard against one slipping through.
      { id: "msg-3", roomId: ROOM, senderId: null, attempts: 1 },
    ]);

    const res = await groupAutoDeleteService.sweepDue(new Date(), 200);

    expect(res).toEqual({ claimed: 3, completed: 2, failed: 0 });
    expect(deleteDirect).toHaveBeenCalledTimes(2);
    // `bySystem` is what lets a message from a member who has since LEFT or been
    // muted still disappear — without it the sweep 400s on every such row.
    expect(deleteDirect).toHaveBeenCalledWith({
      conversationType: "GROUP",
      roomId: ROOM,
      messageId: "msg-1",
      userId: TEST_USER_ID,
      scope: "forEveryone",
      bySystem: true,
    });
  });

  it("fans the tombstone out to every member's personal channel", async () => {
    const { groupAutoDeleteService, chatMessageOrchestrator } = mocks as any;
    jest
      .spyOn(chatMessageOrchestrator, "deleteDirect")
      .mockResolvedValue({ tombstone: { messageId: "msg-1" } } as any);
    claims([{ id: "msg-1", roomId: ROOM, senderId: TEST_USER_ID, attempts: 1 }]);

    await groupAutoDeleteService.sweepDue(new Date(), 200);

    // `conv:<roomId>` only reaches clients with the chat OPEN, and a sweep fires
    // with nobody guaranteed to be looking.
    const tombstones = publishes().filter((p) => p.event === "message:delete");
    expect(tombstones.map((p) => p.channel).sort()).toEqual(
      [`user:${MEMBER_B}`, `user:${TEST_USER_ID}`].sort()
    );
  });

  it("deletes a message whose sender is no longer a member", async () => {
    // No spy: exercises the real deleteDirect → GroupMessageService.deleteMessage
    // path, whose member/mute checks `bySystem` must bypass.
    const { groupAutoDeleteService } = mocks as any;
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "msg-gone",
      roomId: ROOM,
      senderId: MEMBER_B,
      messageType: "TEXT",
      isDeleted: false,
      createdAt: new Date(),
    });
    mocks.groupMessageRepo.deleteForEveryone.mockResolvedValue({
      id: "msg-gone",
      roomId: ROOM,
      senderId: MEMBER_B,
      sequenceNumber: 3,
      createdAt: new Date(),
      deletedAt: new Date(),
    });
    claims([{ id: "msg-gone", roomId: ROOM, senderId: MEMBER_B, attempts: 1 }]);

    await groupAutoDeleteService.sweepDue(new Date(), 200);

    expect(mocks.groupMessageRepo.deleteForEveryone).toHaveBeenCalledWith(
      "msg-gone",
      ROOM,
      MEMBER_B,
      "SELF_DELETE"
    );
  });
});

// ── 6. Claim/backoff behaviour ───────────────────────────────────────────────
describe("claiming and backoff", () => {
  it("hands a failing row back with bounded backoff instead of retrying it hot", async () => {
    const { groupAutoDeleteService, chatMessageOrchestrator } = mocks as any;
    jest
      .spyOn(chatMessageOrchestrator, "deleteDirect")
      .mockRejectedValue(new Error("boom"));
    claims([{ id: "msg-bad", roomId: ROOM, senderId: MEMBER_B, attempts: 3 }]);

    const res = await groupAutoDeleteService.sweepDue(new Date(), 200);

    expect(res).toEqual({ claimed: 1, completed: 0, failed: 1 });
    expect(mocks.groupMessageRepo.releaseAutoDeleteClaim).toHaveBeenCalledWith(
      expect.objectContaining({ id: "msg-bad", attempts: 3, error: expect.any(String) })
    );
  });

  it("deletes ONLY the rows this worker claimed", async () => {
    // The lease is the whole point: a replica that lost the race receives an
    // empty claim list and must run no side effects at all.
    const { groupAutoDeleteService, chatMessageOrchestrator } = mocks as any;
    const deleteDirect = jest.spyOn(chatMessageOrchestrator, "deleteDirect");
    claims([]);

    const res = await groupAutoDeleteService.sweepDue(new Date(), 200);

    expect(res).toEqual({ claimed: 0, completed: 0, failed: 0 });
    expect(deleteDirect).not.toHaveBeenCalled();
  });
});
