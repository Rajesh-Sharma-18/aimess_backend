/**
 * Automatically Delete Messages (disappearing messages) — PRIVATE 1:1 chats.
 *
 * Covers the four things the feature can silently get wrong:
 *   1. WHICH timer a message gets — ONE per conversation, with the legacy
 *      per-user map still readable, since every other leg depends on it;
 *   2. the setting write: persisted first, system message posted, and BOTH
 *      users' devices told over `conv:auto_delete:updated`;
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
  readRoomAutoDelete,
  validateAutoDeleteInput,
  AUTO_DELETE_AFTER_VIEW_GRACE_SEC,
} from "../../src/lib/auto-delete.js";
import { invalidateAccountChatSettings } from "../../src/lib/account-chat-settings.js";
import { userGrpcClient } from "../../src/grpc/user-snapshot.client.js";

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

function room(autoDelete: Record<string, unknown> | null = null) {
  return {
    id: "room-oid",
    roomId: ROOM,
    participants: [TEST_USER_ID, PEER],
    autoDelete,
    autoDeleteBy: {},
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
  // Mirrors the repository: ONE record for the conversation, stamped with who
  // changed it. An explicit OFF is stored like any other value.
  mocks.privateRoomRepo.setAutoDelete.mockImplementation(
    async (_roomId: string, userId: string, s: any) =>
      room({ ...s, setAt: new Date().toISOString(), setBy: userId })
  );
  invalidateAccountChatSettings();
  setAccountTimer("OFF");
});

/** Point the (mocked) user-service at one account-wide Settings → Chat value. */
function setAccountTimer(autoDeleteTimer: string): void {
  (userGrpcClient.getChatSettings as jest.Mock).mockResolvedValue({
    autoDeleteTimer,
    typingIndicators: true,
    readReceipts: true,
  });
}

// ── 1. Which timer applies (§3.1 one-sided, §3.2 two different timers) ───────
describe("effective timer resolution", () => {
  const dayTimer = { mode: "TIMER" as const, ttlSeconds: 86400, setAt: "" };

  it("gives BOTH participants' messages the conversation's one timer", () => {
    const setting = readRoomAutoDelete(room({ ...dayTimer, setBy: PEER }));
    expect(setting.ttlSeconds).toBe(86400);
    expect(setting.setBy).toBe(PEER);
  });

  // A brand-new friendship has no `autoDelete` record at all, so this IS the
  // new-conversation default: Off, with nothing to initialize and nothing
  // inherited from either user's other chats or account settings.
  it("is OFF for a room nobody has configured", () => {
    expect(readRoomAutoDelete(room()).mode).toBe("OFF");
    expect(readRoomAutoDelete({}).mode).toBe("OFF");
  });

  it("falls back to the newest entry of the LEGACY per-user map", () => {
    // Rooms written before the timer became conversation-wide must not silently
    // turn themselves off on deploy.
    const legacy = readRoomAutoDelete({
      autoDeleteBy: {
        [TEST_USER_ID]: {
          mode: "TIMER",
          ttlSeconds: 3600,
          setAt: "2026-08-01",
        },
        [PEER]: { mode: "TIMER", ttlSeconds: 86400, setAt: "2026-08-09" },
      },
    });
    expect(legacy.ttlSeconds).toBe(86400);
    expect(legacy.setBy).toBe(PEER);
  });

  it("prefers the conversation record over the legacy map", () => {
    const setting = readRoomAutoDelete({
      autoDelete: { mode: "TIMER", ttlSeconds: 3600, setAt: "2026-08-01" },
      autoDeleteBy: {
        [PEER]: { mode: "TIMER", ttlSeconds: 86400, setAt: "2026-08-09" },
      },
    });
    expect(setting.ttlSeconds).toBe(3600);
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
    expect(formatAutoDeleteDuration(2592000)).toBe("30 days");
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

  it("notifies BOTH participants' devices with the SAME payload", async () => {
    await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 3600 });

    // One timer per conversation, so the peer's open screen must flip without a
    // refresh — and `user:<id>` reaches every session that user has open, on
    // whatever screen, while nobody outside the pair is subscribed to either.
    const events = publishes().filter(
      (p) => p.event === "conv:auto_delete:updated"
    );
    expect(events.map((e) => e.channel).sort()).toEqual(
      [`user:${PEER}`, `user:${TEST_USER_ID}`].sort()
    );
    expect(events[0].data).toEqual(events[1].data);
    expect(events[0].data.ttlSeconds).toBe(3600);
    expect(events[0].data.roomId).toBe(ROOM);
    expect(events[0].data.actorId).toBe(TEST_USER_ID);
  });

  it("publishes nothing when the write itself fails", async () => {
    // The event is the other client's only signal, so it must never announce a
    // change the database did not take.
    mocks.privateRoomRepo.setAutoDelete.mockResolvedValue(null);
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 3600 });

    expect(res.status).toBe(404);
    expect(
      publishes().filter((p) => p.event === "conv:auto_delete:updated")
    ).toHaveLength(0);
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
      room({ mode: "TIMER", ttlSeconds: 86400, setAt: "", setBy: TEST_USER_ID })
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
    // BOTH senders — one timer governs the whole conversation.
    const [args] =
      mocks.privateMessageRepo.restampPendingAutoDeletes.mock.calls.at(-1)!;
    expect(args.senderIds.sort()).toEqual([PEER, TEST_USER_ID].sort());
  });

  it("leaves already-armed messages alone when turned OFF (§7)", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(
      room({ mode: "TIMER", ttlSeconds: 3600, setAt: "", setBy: TEST_USER_ID })
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
      room({ mode: "TIMER", ttlSeconds: 3600, setAt: "", setBy: TEST_USER_ID })
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

  it("GET returns the same conversation timer to either participant", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(
      room({ mode: "TIMER", ttlSeconds: 3600, setAt: "", setBy: PEER })
    );
    const res = await request(app).get(url).set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    // Set by the PEER, read by this caller — same answer.
    expect(res.body.data.ttlSeconds).toBe(3600);
    expect(res.body.data.self.ttlSeconds).toBe(3600);
    expect(res.body.data.setBy).toBe(PEER);
  });

  it("GET reports OFF for an unconfigured chat, whatever the account settings say", async () => {
    setAccountTimer("DAYS_30");
    const res = await request(app).get(url).set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.isEnabled).toBe(false);
    expect(res.body.data.mode).toBe("OFF");
    expect(res.body.data.ttlSeconds).toBeNull();
  });

  it("writes only the caller's own entry, whatever the body claims", async () => {
    // Ownership comes from the access token; a userId in the body is ignored.
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 3600, userId: PEER });

    expect(res.status).toBe(200);
    expect(mocks.privateRoomRepo.setAutoDelete).toHaveBeenCalledTimes(1);
    expect(mocks.privateRoomRepo.setAutoDelete).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID,
      { mode: "TIMER", ttlSeconds: 3600 }
    );
  });
});

// ── 2b. The canonical room-policy DTO ────────────────────────────────────────
describe("room-policy contract", () => {
  const url = `/api/chat/private/rooms/${ROOM}/auto-delete`;
  const REQUIRED = [
    "conversationType",
    "mode",
    "ttlSeconds",
    "isEnabled",
    "setAt",
    "setBy",
    "policyVersion",
    "canEdit",
    "capabilities",
  ];

  it("GET and PUT return the SAME shape", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(
      room({ mode: "TIMER", ttlSeconds: 3600, setAt: "", setBy: PEER })
    );
    const got = await request(app).get(url).set(bearer(makeAccessToken()));
    const put = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 86400 });

    expect(got.status).toBe(200);
    expect(put.status).toBe(200);
    for (const key of REQUIRED) {
      expect(got.body.data).toHaveProperty(key);
      expect(put.body.data).toHaveProperty(key);
    }
    // Only `restampPending` is PUT-specific — it describes the write, not the
    // policy, so a GET consumer never has to handle it.
    expect(Object.keys(put.body.data).sort()).toEqual(
      [...Object.keys(got.body.data), "restampPending"].sort()
    );
  });

  it("the socket event carries the same block as the REST payload", async () => {
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 86400 });

    const [event] = publishes().filter(
      (p) => p.event === "conv:auto_delete:updated"
    );
    // Same policy block, plus the routing/actor fields the socket needs.
    for (const key of REQUIRED) {
      expect(event.data[key]).toEqual(res.body.data[key]);
    }
    expect(event.data.type).toBe("PRIVATE");
    expect(event.data.actorId).toBe(TEST_USER_ID);
  });

  it("advertises PRIVATE capabilities and an always-editable policy", async () => {
    const res = await request(app).get(url).set(bearer(makeAccessToken()));
    expect(res.body.data.conversationType).toBe("PRIVATE");
    // Either participant may change a private conversation's timer.
    expect(res.body.data.canEdit).toBe(true);
    expect(res.body.data.capabilities.supportsAfterViewing).toBe(true);
  });

  it("accepts AFTER_VIEWING, which groups reject", async () => {
    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "AFTER_VIEWING" });
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe("AFTER_VIEWING");
  });

  it("surfaces the room's policyVersion", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      ...room({ mode: "TIMER", ttlSeconds: 3600, setAt: "", setBy: PEER }),
      autoDeletePolicyVersion: 12,
    });
    const res = await request(app).get(url).set(bearer(makeAccessToken()));
    expect(res.body.data.policyVersion).toBe(12);
  });

  it("accepts every canonical TTL preset and the debug values", async () => {
    for (const ttlSeconds of [
      86400, 604800, 2592000, 300, 600, 1800, 3600, 21600,
    ]) {
      expect(validateAutoDeleteInput({ mode: "TIMER", ttlSeconds })).toBeNull();
    }
    // Bounds, not the preset list, are what validation enforces.
    expect(validateAutoDeleteInput({ mode: "TIMER", ttlSeconds: 59 })).toBe(
      "CHAT_AUTO_DELETE_INVALID_TTL"
    );
  });

  it("rejects group AFTER_VIEWING at the pure-validation layer too", async () => {
    expect(
      validateAutoDeleteInput({ mode: "AFTER_VIEWING" }, "GROUP")
    ).toBe("CHAT_AUTO_DELETE_MODE_UNSUPPORTED");
    expect(
      validateAutoDeleteInput({ mode: "AFTER_VIEWING" }, "PRIVATE")
    ).toBeNull();
  });
});

// ── 3. "After Viewing" arms on the recipient's read receipt (§3.4, §8.7) ─────
const TARGET_ID = "507f1f77bcf86cd799439011";

/** A valid in-room read target at `seq`. */
function target(seq: number, roomId = ROOM) {
  mocks.privateMessageRepo.findById.mockResolvedValue({
    id: TARGET_ID,
    roomId,
    senderId: PEER,
    sequenceNumber: seq,
    createdAt: new Date(),
  });
}

describe("After Viewing arming", () => {
  beforeEach(() => {
    mocks.privateRoomRepo.markReadUpTo.mockResolvedValue(room());
  });

  it("arms the reader's RECEIVED messages up to the ACCEPTED watermark", async () => {
    const { privateMessageService } = mocks as any;
    target(12);

    await privateMessageService.markRead({
      roomId: ROOM,
      userId: TEST_USER_ID,
      lastMessageId: TARGET_ID,
    });
    await new Promise((r) => setImmediate(r)); // arming is fire-and-forget

    expect(mocks.privateMessageRepo.armAfterViewing).toHaveBeenCalledTimes(1);
    const [roomId, readerId, deleteAt, upToSeq] =
      mocks.privateMessageRepo.armAfterViewing.mock.calls[0];
    expect(roomId).toBe(ROOM);
    expect(readerId).toBe(TEST_USER_ID);
    // BOUNDED: a read to seq 12 must never arm a message at seq 13. Without
    // this the countdown started on messages the reader had not scrolled to.
    expect(upToSeq).toBe(12);
    // A short grace period after the receipt, not immediate.
    const delta = (deleteAt as Date).getTime() - Date.now();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(
      AUTO_DELETE_AFTER_VIEW_GRACE_SEC * 1000 + 500
    );
  });

  it("passes the bound straight through to an indexed, own-message-excluding query", async () => {
    // The repository is where "incoming only, unarmed only, at-or-below the
    // watermark" actually lives — a mocked-repo suite cannot observe it, so
    // exercise the real method against a captured Prisma call.
    const captured: any[] = [];
    const prisma = {
      privateMessage: {
        updateMany: jest.fn(async (args: any) => {
          captured.push(args);
          return { count: 2 };
        }),
      },
    };
    const { PrivateMessageRepository } =
      await import("../../src/repositories/private-message.repository.js");
    const repo = new PrivateMessageRepository(prisma as any, {} as any);

    await repo.armAfterViewing(ROOM, TEST_USER_ID, new Date(), 12);

    expect(captured[0].where).toMatchObject({
      roomId: ROOM,
      senderId: { not: TEST_USER_ID },
      autoDeleteAfterView: true,
      autoDeleteAt: null,
      isDeleted: false,
      sequenceNumber: { lte: 12 },
    });
  });

  it("arms NOTHING when the watermark could not be resolved", async () => {
    const { PrivateMessageRepository } =
      await import("../../src/repositories/private-message.repository.js");
    const updateMany = jest.fn();
    const repo = new PrivateMessageRepository(
      { privateMessage: { updateMany } } as any,
      {} as any
    );
    await expect(
      repo.armAfterViewing(ROOM, TEST_USER_ID, new Date(), 0)
    ).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("arms nothing and mutates nothing for a FOREIGN target", async () => {
    const { privateMessageService } = mocks as any;
    target(12, "prv_someone_elses_room");

    const res = await privateMessageService.markRead({
      roomId: ROOM,
      userId: TEST_USER_ID,
      lastMessageId: TARGET_ID,
    });
    await new Promise((r) => setImmediate(r));

    expect(res).toBeNull();
    expect(mocks.privateRoomRepo.markReadUpTo).not.toHaveBeenCalled();
    expect(mocks.privateMessageRepo.armAfterViewing).not.toHaveBeenCalled();
  });

  it("arms nothing and mutates nothing for a MALFORMED target", async () => {
    const { privateMessageService } = mocks as any;
    mocks.privateMessageRepo.findById.mockResolvedValue(null);

    const res = await privateMessageService.markRead({
      roomId: ROOM,
      userId: TEST_USER_ID,
      lastMessageId: "tmp-optimistic-id",
    });
    await new Promise((r) => setImmediate(r));

    expect(res).toBeNull();
    expect(mocks.privateRoomRepo.markReadUpTo).not.toHaveBeenCalled();
    expect(mocks.privateMessageRepo.armAfterViewing).not.toHaveBeenCalled();
  });

  it("rejects a NON-PARTICIPANT before anything is written", async () => {
    const { privateMessageService } = mocks as any;
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: ["someone-else", PEER],
      autoDeleteBy: {},
    });
    target(12);

    await expect(
      privateMessageService.markRead({
        roomId: ROOM,
        userId: TEST_USER_ID,
        lastMessageId: TARGET_ID,
      })
    ).rejects.toThrow();
    await new Promise((r) => setImmediate(r));

    expect(mocks.privateRoomRepo.markReadUpTo).not.toHaveBeenCalled();
    expect(mocks.privateMessageRepo.armAfterViewing).not.toHaveBeenCalled();
  });

  it("is idempotent across repeated reads to the same watermark", async () => {
    const { privateMessageService } = mocks as any;
    target(12);
    for (let i = 0; i < 3; i++) {
      await privateMessageService.markRead({
        roomId: ROOM,
        userId: TEST_USER_ID,
        lastMessageId: TARGET_ID,
      });
    }
    await new Promise((r) => setImmediate(r));

    // Three calls, each bounded by the SAME watermark — the repository's
    // `autoDeleteAt: null` predicate makes the 2nd and 3rd match nothing, so
    // the deadline never moves.
    const bounds = mocks.privateMessageRepo.armAfterViewing.mock.calls.map(
      (c: any[]) => c[3]
    );
    expect(bounds).toEqual([12, 12, 12]);
  });
});

// ── 4. The sweeper (§5.1, §5.2, §5.3) ────────────────────────────────────────

/** Stub the claim step with the rows this worker "won". */
function claims(
  rows: Array<{
    id: string;
    roomId: string;
    senderId: string | null;
    attempts: number;
  }>
): void {
  mocks.privateMessageRepo.claimDueAutoDeletes.mockResolvedValue(rows);
}

describe("auto-delete sweeper", () => {
  it("deletes due messages through the normal delete-for-everyone path", async () => {
    const { autoDeleteService, chatMessageOrchestrator } = mocks as any;
    const deleteDirect = jest
      .spyOn(chatMessageOrchestrator, "deleteDirect")
      .mockResolvedValue({ tombstone: {} } as any);

    claims([
      { id: "msg-1", roomId: ROOM, senderId: TEST_USER_ID, attempts: 1 },
      { id: "msg-2", roomId: ROOM, senderId: PEER, attempts: 1 },
      // System messages are never stamped; guard against one slipping through.
      { id: "msg-3", roomId: ROOM, senderId: null, attempts: 1 },
    ]);

    const res = await autoDeleteService.sweepDue(new Date(), 200);

    expect(res).toEqual({ claimed: 3, completed: 2, failed: 0 });
    expect(deleteDirect).toHaveBeenCalledTimes(2);
    expect(deleteDirect).toHaveBeenCalledWith({
      conversationType: "PRIVATE",
      roomId: ROOM,
      messageId: "msg-1",
      userId: TEST_USER_ID,
      scope: "forEveryone",
    });
  });

  /**
   * §4/§21: when the message that EXPIRES is the room's last one, the inbox
   * preview must fall back to the previous surviving message — including its
   * TIMESTAMP, so the row moves down the list instead of sitting at the top
   * showing a message that no longer exists. Runs the REAL deleteDirect (no
   * spy) so the whole persisted chain is exercised, not just the entry point.
   */
  it("rolls the room snapshot back to the previous surviving message when the LAST message expires", async () => {
    const { autoDeleteService } = mocks as any;
    const prevAt = new Date("2026-08-10T10:05:00.000Z");
    const expiredAt = new Date("2026-08-10T10:10:00.000Z");

    claims([
      { id: "msg-latest", roomId: ROOM, senderId: TEST_USER_ID, attempts: 1 },
    ]);
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "msg-latest",
      roomId: ROOM,
      senderId: TEST_USER_ID,
      receiverId: PEER,
      messageType: "TEXT",
      isDeleted: false,
      createdAt: expiredAt,
    });
    mocks.privateMessageRepo.deleteForEveryone.mockResolvedValue({
      id: "msg-latest",
      roomId: ROOM,
      senderId: TEST_USER_ID,
      receiverId: PEER,
      sequenceNumber: 3,
      createdAt: expiredAt,
      deletedAt: expiredAt,
    });
    mocks.privateMessageRepo.findPreviousVisible.mockResolvedValue({
      id: "msg-prev",
      senderId: PEER,
      content: { text: "still here" },
      messageType: "TEXT",
      createdAt: prevAt,
      clientMessageId: null,
      sequenceNumber: 2,
      revision: 2,
    });
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      ...room(),
      lastMessageId: "msg-latest",
    });

    await autoDeleteService.sweepDue(new Date(), 200);
    await new Promise((r) => setImmediate(r)); // the recalc is fire-and-forget

    expect(mocks.privateRoomRepo.setLastMessage).toHaveBeenCalledWith(
      ROOM,
      expect.objectContaining({ id: "msg-prev", createdAt: prevAt })
    );
  });

  /**
   * §20 — expiry vs. a message that arrived while the sweeper was running. The
   * recalculation re-reads the newest SURVIVING message rather than assuming
   * "the one before the expired one", so the newer message wins and the room
   * snapshot is never rolled back past it.
   */
  it("does not clobber a message that arrived after the expired one", async () => {
    const { autoDeleteService } = mocks as any;
    const newerAt = new Date("2026-08-10T10:12:00.000Z");

    claims([
      { id: "msg-expired", roomId: ROOM, senderId: TEST_USER_ID, attempts: 1 },
    ]);
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "msg-expired",
      roomId: ROOM,
      senderId: TEST_USER_ID,
      receiverId: PEER,
      messageType: "TEXT",
      isDeleted: false,
      createdAt: new Date("2026-08-10T10:10:00.000Z"),
    });
    mocks.privateMessageRepo.deleteForEveryone.mockResolvedValue({
      id: "msg-expired",
      roomId: ROOM,
      senderId: TEST_USER_ID,
      receiverId: PEER,
      sequenceNumber: 3,
      createdAt: new Date("2026-08-10T10:10:00.000Z"),
    });
    // A message landed between the sweep query and the recalculation.
    mocks.privateMessageRepo.findPreviousVisible.mockResolvedValue({
      id: "msg-newer",
      senderId: PEER,
      content: { text: "just arrived" },
      messageType: "TEXT",
      createdAt: newerAt,
      clientMessageId: null,
      sequenceNumber: 4,
      revision: 4,
    });
    // The snapshot still points at the expired message — the newer one's own
    // bump has not landed yet. This is the window the race lives in.
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      ...room(),
      lastMessageId: "msg-expired",
    });

    await autoDeleteService.sweepDue(new Date(), 200);
    await new Promise((r) => setImmediate(r));

    expect(mocks.privateRoomRepo.setLastMessage).toHaveBeenCalledWith(
      ROOM,
      expect.objectContaining({ id: "msg-newer", createdAt: newerAt })
    );
    // Never rolled back to anything older than what actually survives.
    expect(mocks.privateRoomRepo.setLastMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps going, and backs off, when one message fails to delete", async () => {
    const { autoDeleteService, chatMessageOrchestrator } = mocks as any;
    const deleteDirect = jest
      .spyOn(chatMessageOrchestrator, "deleteDirect")
      .mockRejectedValueOnce(new Error("CHAT_MESSAGE_ALREADY_DELETED"))
      .mockResolvedValue({ tombstone: {} } as any);

    claims([
      { id: "msg-1", roomId: ROOM, senderId: TEST_USER_ID, attempts: 2 },
      { id: "msg-2", roomId: ROOM, senderId: TEST_USER_ID, attempts: 1 },
    ]);

    await expect(autoDeleteService.sweepDue(new Date(), 200)).resolves.toEqual({
      claimed: 2,
      completed: 1,
      failed: 1,
    });
    expect(deleteDirect).toHaveBeenCalledTimes(2);
    // The failing row is handed back with its attempt count so the shared
    // backoff can space out the retry, instead of being re-tried every tick.
    expect(mocks.privateMessageRepo.releaseAutoDeleteClaim).toHaveBeenCalledWith(
      expect.objectContaining({ id: "msg-1", attempts: 2 })
    );
  });

  it("runs no side effects at all when it claims nothing", async () => {
    // A replica that lost every race gets an empty list. This is the whole
    // point of leasing: losing the race must cost nothing, not "delete anyway
    // and swallow the error".
    const { autoDeleteService, chatMessageOrchestrator } = mocks as any;
    const deleteDirect = jest.spyOn(chatMessageOrchestrator, "deleteDirect");
    claims([]);

    await expect(autoDeleteService.sweepDue(new Date(), 200)).resolves.toEqual({
      claimed: 0,
      completed: 0,
      failed: 0,
    });
    expect(deleteDirect).not.toHaveBeenCalled();
  });
});

// ── 5. Restamp durability ────────────────────────────────────────────────────
describe("restamp durability", () => {
  const url = `/api/chat/private/rooms/${ROOM}/auto-delete`;

  it("retires the pending marker for THIS policy version once re-stamped", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(
      room({ mode: "TIMER", ttlSeconds: 86400, setAt: "", setBy: TEST_USER_ID })
    );
    mocks.privateRoomRepo.setAutoDelete.mockResolvedValue({
      ...room({ mode: "TIMER", ttlSeconds: 3600, setAt: "", setBy: TEST_USER_ID }),
      autoDeletePolicyVersion: 8,
    });

    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 3600 });

    expect(res.status).toBe(200);
    expect(res.body.data.policyVersion).toBe(8);
    expect(res.body.data.restampPending).toBe(false);
    expect(
      mocks.privateRoomRepo.clearAutoDeleteRestampPending
    ).toHaveBeenCalledWith(ROOM, 8);
  });

  it("reports restampPending instead of claiming a change that never landed", async () => {
    // The old code did `.catch(log)` here and returned 200 regardless, leaving
    // every enrolled message on the old deadline with nothing left to fix it.
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(
      room({ mode: "TIMER", ttlSeconds: 86400, setAt: "", setBy: TEST_USER_ID })
    );
    mocks.privateRoomRepo.setAutoDelete.mockResolvedValue({
      ...room({ mode: "TIMER", ttlSeconds: 3600, setAt: "", setBy: TEST_USER_ID }),
      autoDeletePolicyVersion: 9,
    });
    mocks.privateMessageRepo.restampPendingAutoDeletes.mockRejectedValue(
      new Error("mongo down")
    );

    const res = await request(app)
      .put(url)
      .set(bearer(makeAccessToken()))
      .send({ mode: "TIMER", ttlSeconds: 3600 });

    expect(res.status).toBe(200);
    expect(res.body.data.restampPending).toBe(true);
    // The marker written alongside the policy is NOT cleared, so the repair
    // pass still owns the work.
    expect(
      mocks.privateRoomRepo.clearAutoDeleteRestampPending
    ).not.toHaveBeenCalled();
  });

  it("finishes an interrupted restamp from the room's CURRENT policy", async () => {
    const { autoDeleteService } = mocks as any;
    mocks.privateRoomRepo.findPendingAutoDeleteRestamps.mockResolvedValue([
      {
        roomId: ROOM,
        participants: [TEST_USER_ID, PEER],
        autoDelete: { mode: "TIMER", ttlSeconds: 600, setAt: "", setBy: PEER },
        autoDeleteRestampPending: 4,
      },
    ]);

    await expect(autoDeleteService.sweepPendingRestamps(100)).resolves.toBe(1);

    expect(
      mocks.privateMessageRepo.restampPendingAutoDeletes
    ).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM, ttlSeconds: 600 })
    );
    expect(
      mocks.privateRoomRepo.clearAutoDeleteRestampPending
    ).toHaveBeenCalledWith(ROOM, 4);
  });

  it("emits no duplicate system message or socket event on repair", async () => {
    const { autoDeleteService } = mocks as any;
    mocks.privateRoomRepo.findPendingAutoDeleteRestamps.mockResolvedValue([
      {
        roomId: ROOM,
        participants: [TEST_USER_ID, PEER],
        autoDelete: { mode: "TIMER", ttlSeconds: 600, setAt: "", setBy: PEER },
        autoDeleteRestampPending: 4,
      },
    ]);

    await autoDeleteService.sweepPendingRestamps(100);

    expect(
      publishes().filter((p) => p.event === "conv:auto_delete:updated")
    ).toHaveLength(0);
    const created = mocks.privateMessageRepo.createMessage.mock.calls.map(
      ([arg]: [any]) => arg
    );
    expect(
      created.filter((c: any) => c.systemEvent === "AUTO_DELETE_UPDATED")
    ).toHaveLength(0);
  });
});

// ── 6. The due-query must never treat "no timer" as "overdue" ────────────────
describe("claimDueAutoDeletes query shape", () => {
  /**
   * REGRESSION GUARD. On MongoDB, Prisma's `lte` also matches a column whose
   * value is explicitly `null` — and every message we write sets
   * `autoDeleteAt: null` when it has no timer. A filter of `{lte: now}` alone
   * therefore selects EVERY ordinary message (and every unread "After Viewing"
   * message) as due, and the sweeper deletes them seconds after they are sent.
   * That shipped once and destroyed messages on a live database; this test
   * fails if the `not: null` guard is ever "simplified" away.
   *
   * The claim path is now shared by private and group, so this covers both.
   */
  async function captureClaimQueries() {
    const captured: any[] = [];
    const delegate = {
      findMany: jest.fn(async (args: any) => {
        captured.push(args);
        return [];
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
      update: jest.fn(),
    };
    const { claimDueAutoDeletes } =
      await import("../../src/lib/auto-delete-claim.js");
    const now = new Date();
    await claimDueAutoDeletes(delegate as any, {
      now,
      limit: 200,
      token: "tok-1",
    });
    return { captured, delegate, now };
  }

  it("excludes rows with no deadline (autoDeleteAt null)", async () => {
    const { captured, now } = await captureClaimQueries();
    const conditions: any[] = captured[0]?.where?.AND ?? [];
    expect(
      conditions.some(
        (c) => c?.autoDeleteAt && "not" in c.autoDeleteAt && c.autoDeleteAt.not === null
      )
    ).toBe(true);
    expect(conditions.some((c) => c?.autoDeleteAt?.lte === now)).toBe(true);
    expect(captured[0]?.where?.isDeleted).toBe(false);
  });

  it("skips rows still inside their retry backoff", async () => {
    const { captured, now } = await captureClaimQueries();
    const conditions: any[] = captured[0]?.where?.AND ?? [];
    const backoff = conditions.find((c) =>
      (c?.OR ?? []).some((o: any) => "autoDeleteNextAttemptAt" in o)
    );
    // Explicit OR against null rather than relying on "lte also matches null":
    // if that quirk ever changes, the sweeper must not stop entirely.
    expect(backoff.OR).toEqual([
      { autoDeleteNextAttemptAt: null },
      { autoDeleteNextAttemptAt: { lte: now } },
    ]);
  });

  it("only claims rows nobody holds, or whose lease has expired", async () => {
    const { captured } = await captureClaimQueries();
    const conditions: any[] = captured[0]?.where?.AND ?? [];
    const claimable = conditions.find((c) =>
      (c?.OR ?? []).some((o: any) => "autoDeleteClaimToken" in o)
    );
    expect(claimable.OR[0]).toEqual({ autoDeleteClaimToken: null });
    // The `not: null` guard again: without it a NEVER-claimed row matches `lt`
    // and the stale-recovery branch would take rows a live worker just claimed.
    expect(claimable.OR[1].AND[0]).toEqual({
      autoDeleteClaimedAt: { not: null },
    });
  });

  it("resolves the winner by reading the token back, not by trusting a count", async () => {
    const captured: any[] = [];
    const delegate = {
      findMany: jest.fn(async (args: any) => {
        captured.push(args);
        // First call = candidates; second = the rows we actually won.
        return captured.length === 1
          ? [{ id: "a" }, { id: "b" }]
          : [
              {
                id: "a",
                roomId: ROOM,
                senderId: PEER,
                autoDeleteAttempts: 1,
              },
            ];
      }),
      updateMany: jest.fn(async () => ({ count: 2 })),
      update: jest.fn(),
    };
    const { claimDueAutoDeletes } =
      await import("../../src/lib/auto-delete-claim.js");

    const won = await claimDueAutoDeletes(delegate as any, {
      now: new Date(),
      limit: 200,
      token: "tok-mine",
    });

    // updateMany said 2; only ONE row actually carries our token. The count
    // says how many, never WHICH — so the read-back is what makes this safe.
    expect(won).toEqual([
      { id: "a", roomId: ROOM, senderId: PEER, attempts: 1 },
    ]);
    expect(captured[1].where).toEqual({ autoDeleteClaimToken: "tok-mine" });
  });

  it("backs off exponentially, with a ceiling", async () => {
    const { autoDeleteRetryDelaySec, AUTO_DELETE_RETRY_MAX_SEC } =
      await import("../../src/lib/auto-delete-claim.js");
    expect(autoDeleteRetryDelaySec(1)).toBe(60);
    expect(autoDeleteRetryDelaySec(2)).toBe(120);
    expect(autoDeleteRetryDelaySec(3)).toBe(240);
    expect(autoDeleteRetryDelaySec(50)).toBe(AUTO_DELETE_RETRY_MAX_SEC);
  });
});
