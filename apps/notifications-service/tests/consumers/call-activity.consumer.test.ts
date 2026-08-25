/**
 * call.consumer.ts — the `call.activity` projection.
 *
 * One settled call must produce ONE inbox row per participant, and the two
 * rows must be independent: a failure writing the caller's history is not a
 * reason for the callee to lose theirs. A failure must also surface (throw)
 * so the message is redelivered rather than silently dropped.
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
  it("writes one row for each participant, with per-side direction", async () => {
    await handleCallActivity(payload);

    const rows = inboxRows();
    expect(rows).toHaveLength(2);
    const caller = rows.find((c) => c.userId === CALLER)!;
    const callee = rows.find((c) => c.userId === CALLEE)!;

    expect(caller.data.callDirection).toBe("OUTGOING");
    expect(callee.data.callDirection).toBe("INCOMING");
    // Same call → same idempotency key on both sides.
    expect(caller.data.groupKey).toBe("call:call-1");
    expect(callee.data.groupKey).toBe("call:call-1");
    // Only the side that missed the call is badged.
    expect(caller.data.markRead).toBe("true");
    expect(callee.data.markRead).toBeUndefined();
    // The rows are history only — the push is the separate CALL_MISSED below.
    expect(caller.skipPush).toBe(true);
    expect(callee.skipPush).toBe(true);
  });

  it("pushes the missed-call banner to the callee whose row badges as missed", async () => {
    await handleCallActivity(payload);

    const missed = missedPushes();
    expect(missed).toHaveLength(1);
    const push = missed[0]!;
    // Only the callee (INCOMING) is ever badged missed — never the caller.
    expect(push.userId).toBe(CALLEE);
    expect(push.skipInbox).toBe(true);
    expect(push.collapseKey).toBe("call:missed:call-1");
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

    expect(inboxRows()).toHaveLength(2);
    expect(missedPushes()).toHaveLength(0);
  });

  it("gives each side a navigation target instead of making the client infer one", async () => {
    await handleCallActivity(payload);

    const rows = inboxRows();
    const caller = rows.find((c) => c.userId === CALLER)!;
    const callee = rows.find((c) => c.userId === CALLEE)!;

    // The PEER's conversation on each side — the same destination the
    // missed-call push already deep-links to, and where the call card and the
    // call-back button live.
    expect(JSON.parse(caller.data.navigation)).toEqual({
      type: "conversation",
      id: CALLEE,
      roomId: "prv_1",
    });
    expect(JSON.parse(callee.data.navigation)).toEqual({
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

    // Dedupe is STRUCTURAL, not a guard here: the same groupKey plus
    // `resurface: "false"` makes the downstream write transition the same row
    // rather than stack a second one, and keeps a settled row from flipping
    // back to unread.
    for (const side of [...first, ...second]) {
      expect(side.data.groupKey).toBe("call:call-1");
      expect(side.data.resurface).toBe("false");
    }
    expect(second.map((s) => s.userId)).toEqual(first.map((s) => s.userId));
  });

  it("still writes the callee's row when the caller's write fails", async () => {
    pushToUser.mockImplementation(async (input: { userId: string }) => {
      if (input.userId === CALLER) throw new Error("boom");
    });

    await expect(handleCallActivity(payload)).rejects.toThrow(/callId=call-1/);

    // Both inbox rows were attempted — the caller's failure did not abort the
    // callee's — and the callee's missed push still fired.
    expect(inboxRows()).toHaveLength(2);
    expect(inputs().some((input) => input.userId === CALLEE)).toBe(true);
    expect(missedPushes()).toHaveLength(1);
  });
});
