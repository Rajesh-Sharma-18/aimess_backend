/**
 * call.consumer.ts — the `call.activity` projection.
 *
 * One settled call must produce ONE inbox row per participant, and the two
 * rows must be independent: a failure writing the caller's history is not a
 * reason for the callee to lose theirs. A failure must also surface (throw)
 * so the message is redelivered rather than silently dropped.
 */
const pushToUser = jest.fn();
jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: (...args: unknown[]) => pushToUser(...args),
}));

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

beforeEach(() => {
  jest.clearAllMocks();
  pushToUser.mockResolvedValue(undefined);
});

describe("handleCallActivity", () => {
  it("writes one row for each participant, with per-side direction", async () => {
    await handleCallActivity(payload);

    expect(pushToUser).toHaveBeenCalledTimes(2);
    const calls = pushToUser.mock.calls.map(([input]) => input);
    const caller = calls.find((c) => c.userId === CALLER);
    const callee = calls.find((c) => c.userId === CALLEE);

    expect(caller.data.callDirection).toBe("OUTGOING");
    expect(callee.data.callDirection).toBe("INCOMING");
    // Same call → same idempotency key on both sides.
    expect(caller.data.groupKey).toBe("call:call-1");
    expect(callee.data.groupKey).toBe("call:call-1");
    // Only the side that missed the call is badged.
    expect(caller.data.markRead).toBe("true");
    expect(callee.data.markRead).toBeUndefined();
    // History only — the ring and the missed-call alert are pushed elsewhere.
    expect(caller.skipPush).toBe(true);
    expect(callee.skipPush).toBe(true);
  });

  it("gives each side a navigation target instead of making the client infer one", async () => {
    await handleCallActivity(payload);

    const calls = pushToUser.mock.calls.map(([input]) => input);
    const caller = calls.find((c) => c.userId === CALLER);
    const callee = calls.find((c) => c.userId === CALLEE);

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

  it("emits every data value as a string — the FCM data map takes nothing else", async () => {
    // `durationSec` and `endedAt` are the ones that arrive as numbers from the
    // AMQP payload, so they are the ones that would slip through.
    await handleCallActivity({
      ...payload,
      durationSec: 35,
      endedAt: 1_700_000_000_123,
    });

    for (const [input] of pushToUser.mock.calls) {
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
    const first = pushToUser.mock.calls.map(([input]) => input);
    pushToUser.mockClear();
    await handleCallActivity(payload);
    const second = pushToUser.mock.calls.map(([input]) => input);

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

    // Both were attempted — the caller's failure did not abort the callee's.
    expect(pushToUser).toHaveBeenCalledTimes(2);
    expect(
      pushToUser.mock.calls.some(([input]) => input.userId === CALLEE)
    ).toBe(true);
  });
});
