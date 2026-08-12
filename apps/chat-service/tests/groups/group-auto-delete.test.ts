/**
 * Automatically Delete Messages (disappearing messages) — GROUP chats.
 *
 * The group twin of `tests/private/auto-delete.test.ts`, covering the four
 * things this feature can silently get wrong, plus the two rules that are
 * group-specific:
 *   1. WHO may change the timer — admin/moderator only, member is 403;
 *   2. WHICH timer a message gets — the room's one record, read off the same
 *      write that allocates the sequence;
 *   3. "After Viewing" arming on a member's read receipt, and only after the
 *      membership check;
 *   4. the sweeper deleting through the SAME delete-for-everyone path a manual
 *      delete uses, but `bySystem` so a departed/muted sender's messages still
 *      disappear;
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
  AUTO_DELETE_AFTER_VIEW_GRACE_SEC,
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
      .send({ mode: "AFTER_VIEWING" });
    expect(res.status).toBe(200);
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
    const stamp = computeAutoDeleteStamp(
      readRoomAutoDelete(room({ mode: "AFTER_VIEWING", setAt: "" })),
      new Date()
    );
    expect(stamp).toEqual({ autoDeleteAt: null, autoDeleteAfterView: true });
  });
});

// ── 4. "After Viewing" arms on a member's read receipt ───────────────────────
describe("After Viewing arming", () => {
  it("arms the reader's RECEIVED messages on markReadUpTo, never their own", async () => {
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "507f1f77bcf86cd799439011",
      roomId: ROOM,
      createdAt: new Date(),
      sequenceNumber: 4,
    });

    await mocks.groupMessageService.markReadUpTo({
      roomId: ROOM,
      userId: TEST_USER_ID,
      upToMessageId: "507f1f77bcf86cd799439011",
    });

    expect(mocks.groupMessageRepo.armAfterViewing).toHaveBeenCalledTimes(1);
    const [roomId, readerId, deleteAt] =
      mocks.groupMessageRepo.armAfterViewing.mock.calls[0];
    expect(roomId).toBe(ROOM);
    expect(readerId).toBe(TEST_USER_ID);
    // A short grace period after the receipt, not immediate.
    const delta = (deleteAt as Date).getTime() - Date.now();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(
      AUTO_DELETE_AFTER_VIEW_GRACE_SEC * 1000 + 500
    );
  });

  it("never arms for a non-member", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);
    await mocks.groupMessageService.markReadUpTo({
      roomId: ROOM,
      userId: TEST_USER_ID,
      upToMessageId: "507f1f77bcf86cd799439011",
    });
    expect(mocks.groupMessageRepo.armAfterViewing).not.toHaveBeenCalled();
  });
});

// ── 5. The sweeper ───────────────────────────────────────────────────────────
describe("group auto-delete sweeper", () => {
  it("deletes due messages bySystem, through the normal delete path", async () => {
    const { groupAutoDeleteService, chatMessageOrchestrator } = mocks as any;
    const deleteDirect = jest
      .spyOn(chatMessageOrchestrator, "deleteDirect")
      .mockResolvedValue({ tombstone: { messageId: "msg-1" } } as any);

    mocks.groupMessageRepo.findDueAutoDeletes.mockResolvedValue([
      { id: "msg-1", roomId: ROOM, senderId: TEST_USER_ID },
      { id: "msg-2", roomId: ROOM, senderId: MEMBER_B },
      // System messages are never stamped; guard against one slipping through.
      { id: "msg-3", roomId: ROOM, senderId: null },
    ]);

    const n = await groupAutoDeleteService.sweepDue(new Date(), 200);

    expect(n).toBe(3); // page size drives the drain loop
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
    mocks.groupMessageRepo.findDueAutoDeletes.mockResolvedValue([
      { id: "msg-1", roomId: ROOM, senderId: TEST_USER_ID },
    ]);

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
    mocks.groupMessageRepo.findDueAutoDeletes.mockResolvedValue([
      { id: "msg-gone", roomId: ROOM, senderId: MEMBER_B },
    ]);

    await groupAutoDeleteService.sweepDue(new Date(), 200);

    expect(mocks.groupMessageRepo.deleteForEveryone).toHaveBeenCalledWith(
      "msg-gone",
      ROOM,
      MEMBER_B,
      "SELF_DELETE"
    );
  });
});

// ── 6. The query guard that a mocked-repo suite can never catch by behaviour ─
describe("sweeper query shape", () => {
  it("keeps the `not: null` guard on the due-messages filter", async () => {
    // On MongoDB, Prisma's `lte` on a nullable DateTime also matches explicit
    // NULLs. Every message we write sets `autoDeleteAt: null` when it has no
    // timer, so dropping this guard deletes the whole group ~30s after each
    // send. This exact bug destroyed 53 dev messages when private shipped, and
    // a mocked-repo suite cannot observe it — so pin the query text instead.
    const { GroupMessageRepository } =
      await import("../../src/repositories/group-message.repository.js");
    const src = GroupMessageRepository.prototype.findDueAutoDeletes.toString();
    expect(src).toContain("not: null");
    expect(src).toContain("lte: now");
  });
});
