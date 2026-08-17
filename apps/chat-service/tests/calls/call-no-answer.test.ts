/**
 * WhatsApp-style unanswered call: ONE call, ONE row, two readings.
 *
 * The caller's client ends a still-ringing call the moment its ring window
 * elapses, which is the same 60s the server's RINGING → MISSED sweep uses — so
 * the sweep never wins in practice and the outcome has to be decided on that
 * hangup. `endCall` takes `reason: "NO_ANSWER"` for exactly that, and settles
 * the call as the EXISTING MISSED status (no new state) — from which the caller
 * renders "No answer" and the callee "Missed call".
 *
 * What is asserted here is the part a client must not be able to bend:
 *   - only an unanswered RINGING call ended BY THE CALLER becomes MISSED,
 *   - a deliberate hangup mid-ring is still CANCELLED,
 *   - an answered call is never rewritten to MISSED (the answer race),
 *   - the transition happens once — no second card, push or unread bump.
 */
import { CallStatus } from "../../src/types/enums.js";
import { CallService } from "../../src/services/call.service.js";
import {
  publishCallMissedSafe,
  publishCallActivitySafe,
} from "../../src/events/publish-call-incoming.js";

jest.mock("../../src/events/publish-call-incoming.js", () => ({
  publishCallIncomingSafe: jest.fn(),
  publishCallMissedSafe: jest.fn(),
  publishCallCancelSafe: jest.fn(),
  publishCallHandledPushSafe: jest.fn(),
  publishCallActivitySafe: jest.fn(),
}));

const missedPush = publishCallMissedSafe as jest.Mock;
const activityPush = publishCallActivitySafe as jest.Mock;

const CALLER = "caller-1";
const CALLEE = "callee-1";

function buildService() {
  const stubs = {
    callRepo: {
      findByCallId: jest.fn(),
      claimStatusTransition: jest.fn().mockResolvedValue({ won: true }),
      findActiveByParticipant: jest.fn().mockResolvedValue([]),
      findStuckRinging: jest.fn().mockResolvedValue([]),
      findStuckInProgress: jest.fn().mockResolvedValue([]),
      claimForMissed: jest.fn().mockResolvedValue({ won: true }),
      removeGroupCallee: jest.fn(),
    },
    privateRoomRepo: { findByRoomId: jest.fn() },
    redis: {
      publish: jest.fn().mockResolvedValue(1),
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
    },
    livekit: { deleteRoom: jest.fn().mockResolvedValue(undefined) },
    friendshipRepo: { findFriendship: jest.fn() },
    getCallPrivacy: jest.fn().mockResolvedValue({ whoCanCallMe: "EVERYONE" }),
    getUserSnapshot: jest
      .fn()
      .mockResolvedValue({ displayName: "Peter", avatarUrl: "a.png" }),
    callChatMessages: { post: jest.fn().mockResolvedValue(null) },
    callFlags: { isCallingEnabled: jest.fn().mockResolvedValue(true) },
    groupMemberRepo: {
      findActiveByRoomAndUser: jest.fn(),
      findActiveMembers: jest.fn().mockResolvedValue([]),
    },
    groupSystemMessages: {
      postOrUpdateCall: jest.fn().mockResolvedValue(undefined),
    },
  };
  const service = new CallService(
    stubs.callRepo as never,
    stubs.privateRoomRepo as never,
    stubs.redis as never,
    stubs.livekit as never,
    stubs.friendshipRepo as never,
    stubs.getCallPrivacy,
    stubs.getUserSnapshot,
    stubs.callChatMessages as never,
    stubs.callFlags as never,
    stubs.groupMemberRepo as never,
    stubs.groupSystemMessages as never
  );
  return { service, stubs };
}

const ringingCall = {
  callId: "call-1",
  callerId: CALLER,
  calleeId: CALLEE,
  calleeIds: [],
  groupId: null,
  privateRoomId: "room-1",
  type: "AUDIO",
  status: CallStatus.RINGING,
  answeredAt: null,
  durationSec: 0,
};

const cardStatuses = (stubs: ReturnType<typeof buildService>["stubs"]) =>
  stubs.callChatMessages.post.mock.calls.map(
    (c: [{ outcome: string }]) => c[0].outcome
  );

const publishedEvents = (stubs: ReturnType<typeof buildService>["stubs"]) =>
  stubs.redis.publish.mock.calls.map((c: [string, string]) => {
    try {
      return (JSON.parse(c[1]) as { event?: string }).event ?? "";
    } catch {
      return "";
    }
  });

beforeEach(() => {
  missedPush.mockClear();
  activityPush.mockClear();
});

describe("caller's ring window elapses (NO_ANSWER)", () => {
  it("settles the call as MISSED and writes exactly one MISSED card", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingCall);

    const result = await service.endCall({
      callId: "call-1",
      userId: CALLER,
      reason: "NO_ANSWER",
    });

    expect(result.status).toBe(CallStatus.MISSED);
    // Claimed FROM RINGING — the atomic guard that makes an answer win the race.
    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "call-1",
      CallStatus.RINGING,
      expect.objectContaining({ status: CallStatus.MISSED, durationSec: 0 })
    );
    expect(cardStatuses(stubs)).toEqual(["MISSED"]);
    expect(publishedEvents(stubs)).toContain("call:missed");
    expect(publishedEvents(stubs)).not.toContain("call:cancelled");
  });

  it("tells the callee they missed a call — the push the cancel path never sent", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingCall);

    await service.endCall({
      callId: "call-1",
      userId: CALLER,
      reason: "NO_ANSWER",
    });

    expect(missedPush).toHaveBeenCalledTimes(1);
    expect(missedPush).toHaveBeenCalledWith(
      expect.objectContaining({ calleeId: CALLEE, callerId: CALLER })
    );
  });

  it("projects ONE call-history row carrying the canonical MISSED outcome", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingCall);

    await service.endCall({
      callId: "call-1",
      userId: CALLER,
      reason: "NO_ANSWER",
    });

    expect(activityPush).toHaveBeenCalledTimes(1);
    expect(activityPush).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "call-1",
        callerId: CALLER,
        calleeId: CALLEE,
        status: "MISSED",
        durationSec: 0,
      })
    );
  });

  it("works the same for a video call", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      ...ringingCall,
      type: "VIDEO",
    });

    const result = await service.endCall({
      callId: "call-1",
      userId: CALLER,
      reason: "NO_ANSWER",
    });

    expect(result.status).toBe(CallStatus.MISSED);
    expect(activityPush).toHaveBeenCalledWith(
      expect.objectContaining({ callType: "VIDEO", status: "MISSED" })
    );
  });
});

describe("outcomes that must NOT become no-answer", () => {
  it("a deliberate hangup mid-ring stays CANCELLED", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingCall);

    const result = await service.endCall({ callId: "call-1", userId: CALLER });

    expect(result.status).toBe(CallStatus.ENDED);
    expect(cardStatuses(stubs)).toEqual(["CANCELLED"]);
    expect(publishedEvents(stubs)).toContain("call:cancelled");
    expect(missedPush).not.toHaveBeenCalled();
  });

  it("ignores a NO_ANSWER claim from the CALLEE — only the caller can time out", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingCall);

    const result = await service.endCall({
      callId: "call-1",
      userId: CALLEE,
      reason: "NO_ANSWER",
    });

    expect(result.status).toBe(CallStatus.ENDED);
    expect(cardStatuses(stubs)).toEqual(["CANCELLED"]);
  });

  it("never rewrites an ANSWERED call to MISSED, even with the reason set", async () => {
    const { service, stubs } = buildService();
    const answeredAt = new Date(Date.now() - 42_000);
    stubs.callRepo.findByCallId.mockResolvedValue({
      ...ringingCall,
      status: CallStatus.IN_PROGRESS,
      answeredAt,
    });

    const result = await service.endCall({
      callId: "call-1",
      userId: CALLER,
      reason: "NO_ANSWER",
    });

    expect(result.status).toBe(CallStatus.ENDED);
    expect(result.durationSec).toBeGreaterThan(0);
    expect(cardStatuses(stubs)).toEqual(["ENDED"]);
    expect(missedPush).not.toHaveBeenCalled();
  });

  it("an explicit decline is still DECLINED", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingCall);

    await service.declineCall({ callId: "call-1", calleeId: CALLEE });

    expect(cardStatuses(stubs)).toEqual(["DECLINED"]);
    expect(missedPush).not.toHaveBeenCalled();
  });
});

describe("idempotency", () => {
  it("a second no-answer end after the call already settled changes nothing", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingCall);
    await service.endCall({
      callId: "call-1",
      userId: CALLER,
      reason: "NO_ANSWER",
    });

    // The row is terminal now — a retry, a duplicate socket event or a racing
    // sweep all re-read THIS state.
    stubs.callRepo.findByCallId.mockResolvedValue({
      ...ringingCall,
      status: CallStatus.MISSED,
      endedAt: new Date(),
    });
    const again = await service.endCall({
      callId: "call-1",
      userId: CALLER,
      reason: "NO_ANSWER",
    });

    expect(again.status).toBe(CallStatus.MISSED);
    expect(cardStatuses(stubs)).toEqual(["MISSED"]);
    expect(missedPush).toHaveBeenCalledTimes(1);
    expect(activityPush).toHaveBeenCalledTimes(1);
    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledTimes(1);
  });

  it("the sweep cannot double-fan-out a call the caller already settled", async () => {
    const { service, stubs } = buildService();
    // Lost claim = another writer already moved this row.
    stubs.callRepo.claimForMissed.mockResolvedValue({ won: false });
    stubs.callRepo.findStuckRinging.mockResolvedValue([ringingCall]);

    const flipped = await service.sweepMissedCalls(new Date(), 60, 50);

    expect(flipped).toBe(0);
    expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
    expect(missedPush).not.toHaveBeenCalled();
    expect(activityPush).not.toHaveBeenCalled();
  });

  it("the sweep still settles a ring nobody reported — same fan-out, one card", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findStuckRinging.mockResolvedValue([ringingCall]);

    const flipped = await service.sweepMissedCalls(new Date(), 60, 50);

    expect(flipped).toBe(1);
    expect(cardStatuses(stubs)).toEqual(["MISSED"]);
    expect(missedPush).toHaveBeenCalledTimes(1);
    expect(publishedEvents(stubs)).toContain("call:missed");
  });
});
