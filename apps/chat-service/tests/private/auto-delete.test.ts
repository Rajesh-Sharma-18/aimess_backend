/**
 * Automatically Delete Messages (disappearing messages) — PRIVATE 1:1 chats.
 *
 * Covers the four things the feature can silently get wrong:
 *   1. WHICH timer a message gets (one-sided vs. two different timers) — the
 *      pure resolution rules, since every other leg depends on them;
 *   2. the setting write: persisted, system message posted, and BOTH users'
 *      devices told over `conv:auto_delete:updated`;
 *   3. "After Viewing" arming only on the RECIPIENT's read receipt;
 *   4. the sweeper deleting due messages through the SAME delete-for-everyone
 *      path a manual delete uses (so tombstone/unread/preview all still fire).
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import {
  computeAutoDeleteStamp,
  formatAutoDeleteDuration,
  parseAutoDeleteMap,
  resolveEffectiveAutoDelete,
  validateAutoDeleteInput,
  AUTO_DELETE_AFTER_VIEW_GRACE_SEC,
} from "../../src/lib/auto-delete.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "prv_autodelete_1";
const PEER = "peer-user-1";

function publishes(): Array<{ channel: string; event: string; data: any }> {
  return mocks.redis.publish.mock.calls.map(
    ([channel, raw]: [string, string]) => ({
      channel,
      ...(JSON.parse(raw) as { event: string; data: any }),
    })
  );
}

function room(autoDeleteBy: Record<string, unknown> = {}) {
  return {
    id: "room-oid",
    roomId: ROOM,
    participants: [TEST_USER_ID, PEER],
    autoDeleteBy,
    mutedBy: {},
    archivedBy: {},
    unreadCountByUser: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.privateRoomRepo.findByRoomId.mockResolvedValue(room());
  mocks.privateRoomRepo.setAutoDelete.mockImplementation(
    async (_roomId: string, userId: string, s: any) =>
      room(s.mode === "OFF" ? {} : { [userId]: { ...s, setAt: "" } })
  );
});

// ── 1. Which timer applies (§3.1 one-sided, §3.2 two different timers) ───────
describe("effective timer resolution", () => {
  const dayTimer = { mode: "TIMER" as const, ttlSeconds: 86400, setAt: "" };
  const hourTimer = { mode: "TIMER" as const, ttlSeconds: 3600, setAt: "" };

  it("applies the only configured timer to BOTH senders when one-sided", () => {
    const map = parseAutoDeleteMap({ [TEST_USER_ID]: dayTimer });
    // The setter's own message…
    expect(resolveEffectiveAutoDelete(map, TEST_USER_ID, PEER).ttlSeconds).toBe(
      86400
    );
    // …and the peer's message, which has no setting of its own.
    expect(resolveEffectiveAutoDelete(map, PEER, TEST_USER_ID).ttlSeconds).toBe(
      86400
    );
  });

  it("uses each sender's OWN timer when both users configured one", () => {
    const map = parseAutoDeleteMap({
      [TEST_USER_ID]: hourTimer,
      [PEER]: dayTimer,
    });
    expect(resolveEffectiveAutoDelete(map, TEST_USER_ID, PEER).ttlSeconds).toBe(
      3600
    );
    expect(resolveEffectiveAutoDelete(map, PEER, TEST_USER_ID).ttlSeconds).toBe(
      86400
    );
  });

  it("is OFF when nobody configured it", () => {
    const map = parseAutoDeleteMap({});
    expect(resolveEffectiveAutoDelete(map, TEST_USER_ID, PEER).mode).toBe(
      "OFF"
    );
  });

  it("stamps a TIMER deadline from send time, and defers AFTER_VIEWING", () => {
    const sentAt = new Date("2026-08-05T10:00:00.000Z");
    expect(
      computeAutoDeleteStamp(
        { mode: "TIMER", ttlSeconds: 86400, setAt: "" },
        sentAt
      ).autoDeleteAt?.toISOString()
    ).toBe("2026-08-06T10:00:00.000Z");

    const afterView = computeAutoDeleteStamp(
      { mode: "AFTER_VIEWING", ttlSeconds: null, setAt: "" },
      sentAt
    );
    expect(afterView.autoDeleteAt).toBeNull();
    expect(afterView.autoDeleteAfterView).toBe(true);
  });

  it("rejects out-of-range and malformed timers", () => {
    expect(validateAutoDeleteInput({ mode: "TIMER", ttlSeconds: 86400 })).toBe(
      null
    );
    expect(validateAutoDeleteInput({ mode: "TIMER", ttlSeconds: 5 })).toBe(
      "CHAT_AUTO_DELETE_INVALID_TTL"
    );
    expect(validateAutoDeleteInput({ mode: "TIMER" })).toBe(
      "CHAT_AUTO_DELETE_INVALID_TTL"
    );
    expect(validateAutoDeleteInput({ mode: "SOMETIMES" })).toBe(
      "CHAT_AUTO_DELETE_INVALID_MODE"
    );
    expect(validateAutoDeleteInput({ mode: "OFF" })).toBe(null);
  });

  it("labels durations for the system message", () => {
    // The three presets read EXACTLY as the picker labels them, so the system
    // message never contradicts the option the user just tapped.
    expect(formatAutoDeleteDuration(86400)).toBe("24 hours");
    expect(formatAutoDeleteDuration(604800)).toBe("7 days");
    expect(formatAutoDeleteDuration(7776000)).toBe("90 days");
    // Custom timers fall back to generic humanization.
    expect(formatAutoDeleteDuration(3600)).toBe("1 hour");
    expect(formatAutoDeleteDuration(10800)).toBe("3 hours");
    expect(formatAutoDeleteDuration(172800)).toBe("2 days");
    expect(formatAutoDeleteDuration(null)).toBe("");
  });
});

// ── 2. The setting endpoints (§2, §7, §8.4) ──────────────────────────────────
describe("PUT /chat/private/rooms/:roomId/auto-delete", () => {
  const url = `/api/chat/private/rooms/${ROOM}/auto-delete`;

  it("persists the caller's own timer and returns the effective state", async () => {
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 86400 });

    expect(res.status).toBe(200);
    expect(mocks.privateRoomRepo.setAutoDelete).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      { mode: "TIMER", ttlSeconds: 86400 }
    );
    expect(res.body.data.mode).toBe("TIMER");
    expect(res.body.data.ttlSeconds).toBe(86400);
    expect(res.body.data.isEnabled).toBe(true);
    expect(res.body.data.label).toBe("24 hours");
  });

  it("notifies BOTH participants' devices with conv:auto_delete:updated", async () => {
    await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 3600 });

    const channels = publishes()
      .filter((p) => p.event === "conv:auto_delete:updated")
      .map((p) => p.channel)
      .sort();
    expect(channels).toEqual([`user:${PEER}`, `user:${TEST_USER_ID}`].sort());
  });

  it("posts a SYSTEM message so the peer learns about it in-chat", async () => {
    await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 3600 });

    const created = mocks.privateMessageRepo.createMessage.mock.calls.map(
      ([arg]: [any]) => arg
    );
    const sys = created.find(
      (c: any) => c.systemEvent === "AUTO_DELETE_UPDATED"
    );
    expect(sys).toBeDefined();
    expect(sys.systemData.mode).toBe("TIMER");
    expect(sys.systemData.durationLabel).toBe("1 hour");
    expect(sys.content.text).toContain("auto-delete after 1 hour");
  });

  it("re-stamps messages already counting down when the timer CHANGES (§8.8)", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(
      room({
        [TEST_USER_ID]: { mode: "TIMER", ttlSeconds: 86400, setAt: "" },
      })
    );
    await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 3600 });

    expect(
      mocks.privateMessageRepo.restampPendingAutoDeletes
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: ROOM,
        ttlSeconds: 3600,
        afterView: false,
      })
    );
    // One-sided: the peer has no setting, so their messages follow this timer too.
    const [args] =
      mocks.privateMessageRepo.restampPendingAutoDeletes.mock.calls.at(-1)!;
    expect(args.senderIds.sort()).toEqual([PEER, TEST_USER_ID].sort());
  });

  it("leaves already-armed messages alone when turned OFF (§7)", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(
      room({ [TEST_USER_ID]: { mode: "TIMER", ttlSeconds: 3600, setAt: "" } })
    );
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "OFF" });

    expect(res.status).toBe(200);
    expect(res.body.data.isEnabled).toBe(false);
    expect(
      mocks.privateMessageRepo.restampPendingAutoDeletes
    ).not.toHaveBeenCalled();
  });

  it("is a no-op (no system message, no re-stamp) when nothing changed", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(
      room({ [TEST_USER_ID]: { mode: "TIMER", ttlSeconds: 3600, setAt: "" } })
    );
    await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 3600 });

    expect(mocks.privateRoomRepo.setAutoDelete).not.toHaveBeenCalled();
    expect(
      publishes().filter((p) => p.event === "conv:auto_delete:updated")
    ).toHaveLength(0);
  });

  it("rejects an invalid duration", async () => {
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 5 });
    expect(res.status).toBe(400);
  });

  it("404s for a room the caller is not a participant of", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: ["someone-else", PEER],
      autoDeleteBy: {},
    });
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "OFF" });
    expect(res.status).toBe(404);
  });

  it("GET returns both sides' settings", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(
      room({
        [TEST_USER_ID]: { mode: "TIMER", ttlSeconds: 3600, setAt: "" },
        [PEER]: { mode: "TIMER", ttlSeconds: 86400, setAt: "" },
      })
    );
    const res = await request(app).get(url).set(bearer(makeAccessToken()));
    expect(res.status).toBe(200);
    // "Mine" wins for MY next message; the peer's is exposed for display.
    expect(res.body.data.ttlSeconds).toBe(3600);
    expect(res.body.data.self.ttlSeconds).toBe(3600);
    expect(res.body.data.peer.ttlSeconds).toBe(86400);
  });
});

// ── 3. "After Viewing" arms on the recipient's read receipt (§3.4, §8.7) ─────
describe("After Viewing arming", () => {
  it("arms the reader's RECEIVED messages on markRead, never their own", async () => {
    const { privateMessageService } = mocks as any;
    await privateMessageService.armAfterViewingMessages(ROOM, TEST_USER_ID);

    expect(mocks.privateMessageRepo.armAfterViewing).toHaveBeenCalledTimes(1);
    const [roomId, readerId, deleteAt] =
      mocks.privateMessageRepo.armAfterViewing.mock.calls[0];
    expect(roomId).toBe(ROOM);
    expect(readerId).toBe(TEST_USER_ID);
    // A short grace period after the receipt, not immediate.
    const delta = (deleteAt as Date).getTime() - Date.now();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(
      AUTO_DELETE_AFTER_VIEW_GRACE_SEC * 1000 + 500
    );
  });
});

// ── 4. The sweeper (§5.1, §5.2, §5.3) ────────────────────────────────────────
describe("auto-delete sweeper", () => {
  it("deletes due messages through the normal delete-for-everyone path", async () => {
    const { autoDeleteService, chatMessageOrchestrator } = mocks as any;
    const deleteDirect = jest
      .spyOn(chatMessageOrchestrator, "deleteDirect")
      .mockResolvedValue({ tombstone: {} } as any);

    mocks.privateMessageRepo.findDueAutoDeletes.mockResolvedValue([
      { id: "msg-1", roomId: ROOM, senderId: TEST_USER_ID },
      { id: "msg-2", roomId: ROOM, senderId: PEER },
      // System messages are never stamped; guard against one slipping through.
      { id: "msg-3", roomId: ROOM, senderId: null },
    ]);

    const n = await autoDeleteService.sweepDue(new Date(), 200);

    expect(n).toBe(3); // page size drives the drain loop
    expect(deleteDirect).toHaveBeenCalledTimes(2);
    expect(deleteDirect).toHaveBeenCalledWith({
      conversationType: "PRIVATE",
      roomId: ROOM,
      messageId: "msg-1",
      userId: TEST_USER_ID,
      scope: "forEveryone",
    });
  });

  it("keeps going when one message loses the delete race", async () => {
    const { autoDeleteService, chatMessageOrchestrator } = mocks as any;
    const deleteDirect = jest
      .spyOn(chatMessageOrchestrator, "deleteDirect")
      .mockRejectedValueOnce(new Error("CHAT_MESSAGE_ALREADY_DELETED"))
      .mockResolvedValue({ tombstone: {} } as any);

    mocks.privateMessageRepo.findDueAutoDeletes.mockResolvedValue([
      { id: "msg-1", roomId: ROOM, senderId: TEST_USER_ID },
      { id: "msg-2", roomId: ROOM, senderId: TEST_USER_ID },
    ]);

    await expect(autoDeleteService.sweepDue(new Date(), 200)).resolves.toBe(2);
    expect(deleteDirect).toHaveBeenCalledTimes(2);
  });
});

// ── 5. The due-query must never treat "no timer" as "overdue" ────────────────
describe("findDueAutoDeletes query shape", () => {
  /**
   * REGRESSION GUARD. On MongoDB, Prisma's `lte` also matches a column whose
   * value is explicitly `null` — and every message we write sets
   * `autoDeleteAt: null` when it has no timer. A filter of `{lte: now}` alone
   * therefore selects EVERY ordinary message (and every unread "After Viewing"
   * message) as due, and the sweeper deletes them seconds after they are sent.
   * That shipped once and destroyed messages on a live database; this test
   * fails if the `not: null` guard is ever "simplified" away.
   */
  it("excludes rows with no deadline (autoDeleteAt null)", async () => {
    const captured: any[] = [];
    const prisma = {
      privateMessage: {
        findMany: jest.fn(async (args: any) => {
          captured.push(args);
          return [];
        }),
      },
    };
    const { PrivateMessageRepository } =
      await import("../../src/repositories/private-message.repository.js");
    const repo = new PrivateMessageRepository(
      prisma as any,
      { allocateRevision: jest.fn(async () => 1) } as any
    );

    const now = new Date();
    await repo.findDueAutoDeletes(now, 200);

    const where = captured[0]?.where;
    const conditions: any[] = where?.AND ?? [where];
    const excludesNull = conditions.some(
      (c) =>
        c?.autoDeleteAt &&
        "not" in c.autoDeleteAt &&
        c.autoDeleteAt.not === null
    );
    const boundedByNow = conditions.some((c) => c?.autoDeleteAt?.lte === now);

    expect(excludesNull).toBe(true);
    expect(boundedByNow).toBe(true);
    expect(where?.isDeleted).toBe(false);
  });
});
