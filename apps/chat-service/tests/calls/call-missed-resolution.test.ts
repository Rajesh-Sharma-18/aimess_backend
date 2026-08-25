/**
 * The MISSED decision, in the one place the backend makes it.
 *
 * Two bugs met here and they were the same bug. `reason: "NO_ANSWER"` is
 * OPTIONAL on the wire, and a caller's ring timeout normally fires at the same
 * 60s the server sweep uses and wins the race — so in production most missed
 * calls arrived as a plain `call:end`. That settled them as a cancellation,
 * which skipped the unanswered fan-out entirely. Meanwhile the notification
 * projection, reading the SAME call through `cancelCountsAsMissed`, wrote the
 * callee an UNREAD "Missed call" row. The badge half of the rule and the push
 * half disagreed: the callee had a missed call sitting in the app and nothing
 * in their tray telling them about it.
 *
 * `ringResolvesAsMissed` is now the single decision, and both halves read it.
 *
 * The invariants asserted here are the ones that must never regress:
 *   - a connected call can NEVER become MISSED, whatever the ring lasted,
 *   - a ring the caller abandoned INSIDE the grace window is still a cancel,
 *   - only the CALLER's hangup can read as "no answer",
 *   - an already-terminal call is never downgraded by a late `call:end`,
 *   - every path that resolves MISSED goes through the ONE shared fan-out, so
 *     the push, the card and the events can never drift apart.
 */
import { CALL_CANCEL_GRACE_SEC } from "@aimess/constants";

import { CallStatus } from "../../src/types/enums.js";
import { CallService } from "../../src/services/call.service.js";
import {
  publishCallMissedSafe,
  publishCallCancelSafe,
} from "../../src/events/publish-call-incoming.js";

jest.mock("../../src/events/publish-call-incoming.js", () => ({
  publishCallIncomingSafe: jest.fn(),
  publishCallMissedSafe: jest.fn(),
  publishCallCancelSafe: jest.fn(),
  publishCallHandledPushSafe: jest.fn(),
  publishCallActivitySafe: jest.fn(),
}));

const missedPush = publishCallMissedSafe as jest.Mock;
const cancelPush = publishCallCancelSafe as jest.Mock;

const CALLER = "caller-1";
const CALLEE = "callee-1";

function buildService() {
  const stubs = {
    callRepo: {
      findByCallId: jest.fn(),
      claimStatusTransition: jest.fn().mockResolvedValue({ won: true }),
      findActiveByParticipant: jest.fn().mockResolvedValue([]),
      findAllActiveBetween: jest.fn().mockResolvedValue([]),
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

/** A ringing call that started `ringSec` ago. */
const ringingFor = (ringSec: number) => ({
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
  initiatedAt: new Date(Date.now() - ringSec * 1000),
});

const PAST_GRACE = CALL_CANCEL_GRACE_SEC + 25;

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

const claimedStatus = (stubs: ReturnType<typeof buildService>["stubs"]) =>
  (
    stubs.callRepo.claimStatusTransition.mock.calls[0] as
      | [string, string, { status: string }]
      | undefined
  )?.[2]?.status;

beforeEach(() => {
  missedPush.mockClear();
  cancelPush.mockClear();
});

describe("generic call:end — the path most missed calls actually take", () => {
  it("resolves a long unanswered ring as MISSED even without reason=NO_ANSWER", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingFor(PAST_GRACE));

    const result = await service.endCall({ callId: "call-1", userId: CALLER });

    expect(result.status).toBe(CallStatus.MISSED);
    expect(claimedStatus(stubs)).toBe(CallStatus.MISSED);
    expect(cardStatuses(stubs)).toEqual(["MISSED"]);
    expect(publishedEvents(stubs)).toContain("call:missed");
    expect(publishedEvents(stubs)).not.toContain("call:cancelled");
    // The whole point: the callee's device actually gets told.
    expect(missedPush).toHaveBeenCalledTimes(1);
    expect(missedPush.mock.calls[0][0]).toMatchObject({
      callId: "call-1",
      calleeId: CALLEE,
      callerId: CALLER,
    });
  });

  it("resolves an unanswered ring the caller cut immediately as MISSED, with a missed push", async () => {
    // No misdial grace: a caller hanging up in the first second still leaves the
    // callee a missed call. Regression guard for the "ends quickly → no missed
    // notification" bug (CALL_CANCEL_GRACE_SEC is 0).
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingFor(0));

    const result = await service.endCall({ callId: "call-1", userId: CALLER });

    expect(result.status).toBe(CallStatus.MISSED);
    expect(claimedStatus(stubs)).toBe(CallStatus.MISSED);
    expect(cardStatuses(stubs)).toEqual(["MISSED"]);
    expect(publishedEvents(stubs)).toContain("call:missed");
    expect(publishedEvents(stubs)).not.toContain("call:cancelled");
    expect(missedPush).toHaveBeenCalledTimes(1);
    expect(missedPush.mock.calls[0][0]).toMatchObject({
      callId: "call-1",
      calleeId: CALLEE,
      callerId: CALLER,
    });
  });

  it("keeps honouring an explicit reason=NO_ANSWER regardless of ring length", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingFor(1));

    const result = await service.endCall({
      callId: "call-1",
      userId: CALLER,
      reason: "NO_ANSWER",
    });

    expect(result.status).toBe(CallStatus.MISSED);
    expect(missedPush).toHaveBeenCalledTimes(1);
  });

  it("does NOT read the CALLEE hanging up a long ring as a missed call", async () => {
    // The callee acting on a ring is them dealing with it, not missing it.
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingFor(PAST_GRACE));

    const result = await service.endCall({ callId: "call-1", userId: CALLEE });

    expect(result.status).toBe(CallStatus.ENDED);
    expect(cardStatuses(stubs)).toEqual(["CANCELLED"]);
    expect(missedPush).not.toHaveBeenCalled();
  });
});

describe("a connected call can never become MISSED", () => {
  it("an answered call ended after a long time is ENDED with a duration", async () => {
    const { service, stubs } = buildService();
    const answeredAt = new Date(Date.now() - 120_000);
    stubs.callRepo.findByCallId.mockResolvedValue({
      ...ringingFor(180),
      status: CallStatus.IN_PROGRESS,
      answeredAt,
    });

    const result = await service.endCall({ callId: "call-1", userId: CALLER });

    expect(result.status).toBe(CallStatus.ENDED);
    expect(result.durationSec).toBeGreaterThan(0);
    expect(cardStatuses(stubs)).toEqual(["ENDED"]);
    expect(missedPush).not.toHaveBeenCalled();
  });

  it("an answered call cannot be forced to MISSED by sending reason=NO_ANSWER", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      ...ringingFor(180),
      status: CallStatus.IN_PROGRESS,
      answeredAt: new Date(Date.now() - 120_000),
    });

    const result = await service.endCall({
      callId: "call-1",
      userId: CALLER,
      reason: "NO_ANSWER",
    });

    expect(result.status).toBe(CallStatus.ENDED);
    expect(missedPush).not.toHaveBeenCalled();
  });
});

describe("terminal states are never downgraded", () => {
  for (const settled of [
    CallStatus.MISSED,
    CallStatus.ENDED,
    CallStatus.DECLINED,
  ]) {
    it(`a late call:end on a ${settled} call changes nothing`, async () => {
      const { service, stubs } = buildService();
      stubs.callRepo.findByCallId.mockResolvedValue({
        ...ringingFor(PAST_GRACE),
        status: settled,
      });

      const result = await service.endCall({
        callId: "call-1",
        userId: CALLER,
      });

      expect(result.status).toBe(settled);
      expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
      expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
      expect(missedPush).not.toHaveBeenCalled();
    });
  }
});

describe("server-driven teardown of a ring nobody took", () => {
  // A LiveKit event used to resolve a ring here, on either side of the grace
  // window. It must not, at ANY ring length: during RINGING the caller is the
  // room's only participant, so the room empties on any churn in their media
  // connection while their /chat socket is fine and the callee is still being
  // rung. Acting on that killed live calls — the callee's incoming call vanished
  // before it could be answered, the caller's ended without connecting.
  //
  // The grace-window decision itself is unchanged and still covered, through the
  // paths that legitimately settle a ring: `endCall` above (which is what the
  // gateway's socket-drop cleanup invokes) and `endCallsBetween` below.
  for (const [label, ringSec] of [
    ["after a long ring", PAST_GRACE],
    ["after a short ring", 1],
  ] as const) {
    it(`LiveKit room_finished ${label} leaves the ring alone`, async () => {
      const { service, stubs } = buildService();
      stubs.callRepo.findByCallId.mockResolvedValue(ringingFor(ringSec));

      await service.reconcileFromLiveKitRoomFinished("call-1", "room_finished");

      expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
      expect(cardStatuses(stubs)).toEqual([]);
      expect(missedPush).not.toHaveBeenCalled();
      expect(cancelPush).not.toHaveBeenCalled();
    });
  }

  it("an unfriend during a long ring resolves MISSED and pushes", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findAllActiveBetween.mockResolvedValue([
      ringingFor(PAST_GRACE),
    ]);

    const ended = await service.endCallsBetween(CALLER, CALLEE);

    expect(ended).toBe(1);
    expect(claimedStatus(stubs)).toBe(CallStatus.MISSED);
    expect(cardStatuses(stubs)).toEqual(["MISSED"]);
    expect(missedPush).toHaveBeenCalledTimes(1);
  });

  it("an unfriend during a LIVE call is still an ordinary end", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findAllActiveBetween.mockResolvedValue([
      {
        ...ringingFor(180),
        status: CallStatus.IN_PROGRESS,
        answeredAt: new Date(Date.now() - 90_000),
      },
    ]);

    await service.endCallsBetween(CALLER, CALLEE);

    expect(claimedStatus(stubs)).toBe(CallStatus.ENDED);
    expect(cardStatuses(stubs)).toEqual(["ENDED"]);
    expect(missedPush).not.toHaveBeenCalled();
  });
});

describe("a ring of unknown length is never asserted as missed", () => {
  it("a row with no initiatedAt falls back to the cancel path", async () => {
    // Only reachable from a hand-built row — `initiatedAt` is non-nullable in
    // the schema. Inventing a missed call out of missing data is the one
    // direction of this decision that cannot be walked back.
    const { service, stubs } = buildService();
    const { initiatedAt: _omitted, ...noStart } = ringingFor(PAST_GRACE);
    stubs.callRepo.findByCallId.mockResolvedValue(noStart);

    const result = await service.endCall({ callId: "call-1", userId: CALLER });

    expect(result.status).toBe(CallStatus.ENDED);
    expect(missedPush).not.toHaveBeenCalled();
  });
});
