/**
 * call.consumer.ts — the `call.activity` projection.
 *
 * One settled call produces ONE inbox row, for the callee only: the caller placed
 * the call and never gets a self-generated notification (AIMESS-43/334). A failed
 * write must surface (throw) so the message is redelivered, not silently dropped.
 *
 * The projection ALSO owns the missed-call push now: whenever the callee's row
 * badges as missed (`isUnreadCallActivity`), it fires the same "Missed call
 * from X" banner as `call.missed`, so every settle path that never emits a
 * `call.missed` (callee ended / declined the ring) still notifies. The two
 * artifacts are distinguishable: inbox rows carry `skipPush: true` and
 * `type: "call.activity"`; the missed push carries `skipInbox: true` and
 * `type: "CALL_MISSED"`.
 */
const pushToUser = jest.fn();
jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: (...args: unknown[]) => pushToUser(...args),
}));

const redisMock = {
  set: jest.fn(async () => "OK" as string | null),
};
jest.mock("../../src/config/redis.js", () => ({ redis: redisMock }));

import { handleCallActivity } from "../../src/consumers/call.consumer.js";

const CALLER = "11111111-1111-4111-8111-111111111111";
const CALLEE = "22222222-2222-4222-8222-222222222222";

const payload = {
  callId: "call-1",
  callerId: CALLER,
  calleeId: CALLEE,
  callType: "AUDIO",
  status: "MISSED",
  durationSec: 0,
  ringDurationSec: 60,
  privateRoomId: "prv_1",
  endedAt: 1_700_000_000_000,
  callerName: "Caller",
  callerAvatar: "",
  calleeName: "Callee",
  calleeAvatar: "",
};

type PushInput = {
  userId: string;
  type: string;
  skipPush?: boolean;
  skipInbox?: boolean;
  excludeSessionId?: string;
  collapseKey?: string;
  data: Record<string, string>;
};

const inputs = (): PushInput[] =>
  pushToUser.mock.calls.map(([input]) => input as PushInput);
const inboxRows = (): PushInput[] =>
  inputs().filter((i) => i.type === "call.activity");
const missedPushes = (): PushInput[] =>
  inputs().filter((i) => i.type === "CALL_MISSED");

beforeEach(() => {
  jest.clearAllMocks();
  pushToUser.mockResolvedValue(undefined);
  redisMock.set.mockResolvedValue("OK");
});

describe("handleCallActivity", () => {
  it("writes one row for the callee only — never for the caller (AIMESS-334)", async () => {
    await handleCallActivity(payload);

    const rows = inboxRows();
    expect(rows).toHaveLength(1);
    const callee = rows[0]!;
    expect(callee.userId).toBe(CALLEE);
    expect(rows.some((r) => r.userId === CALLER)).toBe(false);
    expect(callee.data.callDirection).toBe("INCOMING");
    expect(callee.data.groupKey).toBe("call:call-1");
    // A missed call is badged.
    expect(callee.data.markRead).toBeUndefined();
    // The row is history only — the push is the separate CALL_MISSED below.
    expect(callee.skipPush).toBe(true);
  });

  it("pushes the missed-call banner to the callee whose row badges as missed", async () => {
    await handleCallActivity(payload);

    const missed = missedPushes();
    expect(missed).toHaveLength(1);
    const push = missed[0]!;
    expect(push.userId).toBe(CALLEE);
    expect(push.skipInbox).toBe(true);
    // Per caller; reading the chat or answering closes it (§9.1).
    expect(push.collapseKey).toBe("missed:" + CALLER);
    expect(push.data).toMatchObject({
      type: "CALL_MISSED",
      callId: "call-1",
      callerId: CALLER,
      callType: "AUDIO",
    });
    // Claimed on the shared missed key, so a `call.missed` for the same call
    // (caller-cut path) does not double-push.
    expect(redisMock.set.mock.calls[0][0]).toBe(
      "push:sent:call.missed:call-1:" + CALLEE
    );
  });

  it("excludes the settling device from the missed push", async () => {
    await handleCallActivity({ ...payload, excludeSessionId: "sess-9" });

    const push = missedPushes()[0]!;
    expect(push.excludeSessionId).toBe("sess-9");
  });

  it("does NOT push for a connected call — an answered ENDED call is history only", async () => {
    await handleCallActivity({
      ...payload,
      status: "ENDED",
      durationSec: 120,
    });

    expect(inboxRows()).toHaveLength(1);
    expect(inboxRows()[0]!.data.markRead).toBe("true");
    expect(missedPushes()).toHaveLength(0);
  });

  it("navigates the callee to the caller's conversation", async () => {
    await handleCallActivity(payload);

    expect(JSON.parse(inboxRows()[0]!.data.navigation)).toEqual({
      type: "conversation",
      id: CALLER,
      roomId: "prv_1",
    });
  });

  it("emits every inbox data value as a string — the FCM data map takes nothing else", async () => {
    // `durationSec` and `endedAt` are the ones that arrive as numbers from the
    // AMQP payload, so they are the ones that would slip through.
    await handleCallActivity({
      ...payload,
      durationSec: 35,
      endedAt: 1_700_000_000_123,
    });

    for (const input of inboxRows()) {
      for (const [key, value] of Object.entries(input.data)) {
        expect(typeof value).toBe(`string` as const);
        expect(key).toBeTruthy();
      }
      expect(input.data.durationSec).toBe("35");
      expect(input.data.endedAt).toBe("1700000000123");
    }
  });

  it("is replay-safe: a redelivered event carries the same identity, never a second card", async () => {
    await handleCallActivity(payload);
    const first = inboxRows();
    pushToUser.mockClear();
    await handleCallActivity(payload);
    const second = inboxRows();

    for (const side of [...first, ...second]) {
      expect(side.data.groupKey).toBe("call:call-1");
      expect(side.data.resurface).toBe("false");
    }
    expect(second.map((s) => s.userId)).toEqual(first.map((s) => s.userId));
  });

  it("throws when the callee's row cannot be written, so the message is redelivered", async () => {
    pushToUser.mockImplementation(async (input: { userId: string; type: string }) => {
      if (input.type === "call.activity") throw new Error("boom");
    });

    await expect(handleCallActivity(payload)).rejects.toThrow(/callId=call-1/);
    // The missed push still fired.
    expect(missedPushes()).toHaveLength(1);
  });
});

describe("handleCallActivity — contract §9 outcomes", () => {
  type Row = PushInput & {
    copy: (locale: "en" | "vi" | "th") => { body: string };
  };
  const callee = () =>
    (inboxRows() as Row[]).find((r) => r.userId === CALLEE)!;

  it("BUSY is unanswered: missed row + missed push for the callee", async () => {
    await handleCallActivity({ ...payload, status: "BUSY", endReason: "busy", ringDurationSec: 0 });
    expect(callee().copy("en").body).toBe("Missed voice call");
    expect(callee().data.markRead).toBeUndefined();
    expect(missedPushes()).toHaveLength(1);
  });

  it("DECLINED sends no push; the callee's row lands read", async () => {
    await handleCallActivity({ ...payload, status: "DECLINED", endReason: "declined" });
    expect(callee().copy("en").body).toBe("You declined a voice call");
    expect(callee().copy("th").body).toBe("คุณปฏิเสธสายสนทนา");
    expect(callee().data.markRead).toBe("true");
    expect(missedPushes()).toHaveLength(0);
  });

  it("callee rejecting a ring (CANCELLED + endReason declined) reads declined, no push", async () => {
    await handleCallActivity({ ...payload, status: "CANCELLED", endReason: "declined", callType: "VIDEO" });
    expect(callee().copy("en").body).toBe("You declined a video call");
    expect(callee().copy("vi").body).toBe("Bạn đã từ chối cuộc gọi video");
    expect(callee().data.endReason).toBe("declined");
    expect(missedPushes()).toHaveLength(0);
  });

  it("ENDED under 1s (failed) is unanswered: missed row + push, never 'Voice call'", async () => {
    await handleCallActivity({ ...payload, status: "ENDED", durationSec: 0, endReason: "failed" });
    expect(callee().copy("en").body).toBe("Missed voice call");
    expect(missedPushes()).toHaveLength(1);
  });

  it("caller-cancelled ring still pushes missed", async () => {
    await handleCallActivity({ ...payload, status: "CANCELLED", endReason: "canceled" });
    expect(callee().copy("en").body).toBe("Missed voice call");
    expect(missedPushes()).toHaveLength(1);
  });
});