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
