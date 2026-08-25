/**
 * The chat card must exist WHILE the phone is ringing (WhatsApp behavior), and
 * every later state must transition that same row rather than append a new one.
 * These tests pin the CallService half of that contract: which lifecycle state
 * each entry point posts, and that 1:1 and GROUP calls each go to their own
 * timeline writer.
 */
import { CallService } from "../../src/services/call.service.js";
import {
  publishCallCancelSafe,
  publishCallHandledPushSafe,
  publishCallMissedSafe,
} from "../../src/events/publish-call-incoming.js";

// Stub the fire-and-forget push publishers so we can assert WHICH one the answer
// path fires. The regression this guards: answering must push `call.handled`
// (non-terminal "stop ringing on your other devices"), NEVER `call.cancelled`,
// which every device — including the one that just answered — would treat as
// "call is over" and tear down, leaving the caller connected to nobody.
jest.mock("../../src/events/publish-call-incoming.js", () => ({
  publishCallIncomingSafe: jest.fn(),
  publishCallMissedSafe: jest.fn(),
  publishCallCancelSafe: jest.fn(),
  publishCallHandledPushSafe: jest.fn(),
  publishCallActivitySafe: jest.fn(),
}));

const ROOM = { roomId: "room-1", participants: ["caller", "callee"] };

function buildService() {
  const stubs = {
    callRepo: {
      create: jest
        .fn()
        .mockImplementation(async (data) => ({ ...data, calleeIds: [] })),
      findByCallId: jest.fn(),
      claimStatusTransition: jest.fn().mockResolvedValue({ won: true }),
      findCallerRinging: jest.fn().mockResolvedValue([]),
      findActiveByParticipant: jest.fn().mockResolvedValue([]),
      findActiveBetween: jest.fn().mockResolvedValue(null),
      findActiveByGroup: jest.fn().mockResolvedValue(null),
      findStuckRinging: jest.fn().mockResolvedValue([]),
      findStuckInProgress: jest.fn().mockResolvedValue([]),
      claimForMissed: jest.fn().mockResolvedValue({ won: true }),
      removeGroupCallee: jest.fn(),
    },
    privateRoomRepo: {
      findByRoomId: jest.fn().mockResolvedValue(ROOM),
      findByParticipantsKey: jest.fn().mockResolvedValue(ROOM),
      create: jest.fn(),
    },
    redis: { publish: jest.fn().mockResolvedValue(1) },
    livekit: {
      mintToken: jest.fn().mockResolvedValue({ url: "wss://lk", token: "t" }),
    },
    friendshipRepo: {
      areFriends: jest.fn().mockResolvedValue(true),
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
    },
    getCallPrivacy: jest
      .fn()
      .mockResolvedValue({ whoCanCallMe: "FRIENDS", allowedUserIds: [] }),
    getUserSnapshot: jest
      .fn()
      .mockResolvedValue({ displayName: "Caller", avatarUrl: "" }),
    callChatMessages: { post: jest.fn().mockResolvedValue(null) },
    callFlags: { isCallingEnabled: jest.fn().mockResolvedValue(true) },
    groupMemberRepo: {
      findActiveByRoomAndUser: jest.fn().mockResolvedValue({ userId: "u1" }),
      findActiveMembers: jest
        .fn()
        .mockResolvedValue([{ userId: "u1" }, { userId: "u2" }]),
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

describe("CallService — the card appears while ringing", () => {
  it("initiateCall posts a RINGING row before anyone answers", async () => {
    const { service, stubs } = buildService();

    await service.initiateCall({
      callerId: "caller",
      calleeId: "callee",
      type: "VIDEO",
      privateRoomId: "room-1",
    });

    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({
        callerId: "caller",
        calleeId: "callee",
        callType: "VIDEO",
        outcome: "RINGING",
        privateRoomId: "room-1",
      })
    );
  });

  it("a glare loser never leaves an orphan ringing card", async () => {
    const { service, stubs } = buildService();
    // Reciprocal call exists and wins (its callId sorts lower), so this
    // initiate must abort — after create, but before any card is posted.
    stubs.callRepo.create.mockImplementation(async (data) => ({
      ...data,
      callId: "zzz",
      calleeIds: [],
    }));
    stubs.callRepo.findActiveBetween.mockResolvedValue({ callId: "aaa" });

    await expect(
      service.initiateCall({
        callerId: "caller",
        calleeId: "callee",
        type: "AUDIO",
      })
    ).rejects.toThrow();

    expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
  });

  it("answerCall moves the SAME card from RINGING to ANSWERED", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c-1",
      callerId: "caller",
      calleeId: "callee",
      calleeIds: [],
      groupId: null,
      privateRoomId: "room-1",
      type: "AUDIO",
      status: "RINGING",
    });

    await service.answerCall({ callId: "c-1", calleeId: "callee" });

    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "c-1", outcome: "ANSWERED" })
    );
  });

  it("answerCall pushes call.handled to the answerer, never call.cancelled", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c-1",
      callerId: "caller",
      calleeId: "callee",
      calleeIds: [],
      groupId: null,
      privateRoomId: "room-1",
      type: "AUDIO",
      status: "RINGING",
    });

    await service.answerCall({ callId: "c-1", calleeId: "callee" });

    // The answered-elsewhere signal must be the non-terminal one, addressed to
    // the callee, carrying the reason the client keys on.
    expect(publishCallHandledPushSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        calleeId: "callee",
        callId: "c-1",
        reason: "answered_elsewhere",
      })
    );
    // The bug, pinned: a live answered call must never emit a cancellation push.
    expect(publishCallCancelSafe).not.toHaveBeenCalled();
  });

  it("initiateGroupCall posts a RINGING row into the GROUP timeline", async () => {
    const { service, stubs } = buildService();

    await service.initiateGroupCall({
      callerId: "u1",
      groupId: "grp-1",
      type: "AUDIO",
    });

    expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
    expect(stubs.groupSystemMessages.postOrUpdateCall).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "grp-1",
        // Live states carry CALL_STARTED; only settled ones carry CALL_ENDED.
        systemEvent: "CALL_STARTED",
        messageType: "VOICE_CALL",
        systemData: expect.objectContaining({ status: "RINGING" }),
        contentExtra: expect.objectContaining({
          call: expect.objectContaining({ callStatus: "RINGING" }),
        }),
      })
    );
  });

  it("an abandoned outgoing ring is settled to CANCELLED, not left ringing forever", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findCallerRinging.mockResolvedValue([
      {
        callId: "stale-1",
        callerId: "caller",
        calleeId: "old-callee",
        calleeIds: [],
        groupId: null,
        privateRoomId: "room-0",
        type: "AUDIO",
        status: "RINGING",
      },
    ]);

    await service.initiateCall({
      callerId: "caller",
      calleeId: "callee",
      type: "AUDIO",
      privateRoomId: "room-1",
    });

    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "stale-1", outcome: "CANCELLED" })
    );
  });
});

/**
 * Redialling is the commonest shape of a missed call there is: nobody picks
 * up, so the caller hangs up and tries again. `initiateCall`'s self-cleanup
 * settles the abandoned ring, and it used to settle it CANCELLED
 * unconditionally — the one ending that produces no missed-call push and no
 * MISSED row, for a ring the callee genuinely missed. It now asks the same
 * `ringResolvesAsMissed` question every other abandoned-ring path asks.
 */
describe("CallService — redialling settles the abandoned ring honestly", () => {
  const staleRing = (ringSec: number | null) => ({
    callId: "stale-1",
    callerId: "caller",
    calleeId: "old-callee",
    calleeIds: [],
    groupId: null,
    privateRoomId: "room-0",
    type: "AUDIO",
    status: "RINGING",
    answeredAt: null,
    ...(ringSec === null
      ? {}
      : { initiatedAt: new Date(Date.now() - ringSec * 1000) }),
  });

  const redial = (service: CallService) =>
    service.initiateCall({
      callerId: "caller",
      calleeId: "callee",
      type: "AUDIO",
      privateRoomId: "room-1",
    });

  beforeEach(() => {
    (publishCallMissedSafe as jest.Mock).mockClear();
  });

  it("a long unanswered ring becomes MISSED, with the push the callee needs", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findCallerRinging.mockResolvedValue([staleRing(30)]);

    await redial(service);

    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "stale-1",
      "RINGING",
      expect.objectContaining({ status: "MISSED" })
    );
    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "stale-1", outcome: "MISSED" })
    );
    expect(publishCallMissedSafe as jest.Mock).toHaveBeenCalledTimes(1);
    expect((publishCallMissedSafe as jest.Mock).mock.calls[0][0]).toMatchObject(
      {
        callId: "stale-1",
        calleeId: "old-callee",
        callerId: "caller",
      }
    );
    // The redial itself still goes out — cleanup must never cost the new call.
    expect(stubs.callRepo.create).toHaveBeenCalledTimes(1);
  });

  it("a ring abandoned after only a second still becomes MISSED, with the push", async () => {
    // No misdial grace (CALL_CANCEL_GRACE_SEC is 0): redialling away from a ring
    // the callee never took leaves them a missed call however briefly it rang.
    const { service, stubs } = buildService();
    stubs.callRepo.findCallerRinging.mockResolvedValue([staleRing(1)]);

    await redial(service);

    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "stale-1",
      "RINGING",
      expect.objectContaining({ status: "MISSED" })
    );
    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "stale-1", outcome: "MISSED" })
    );
    expect(publishCallMissedSafe as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it("NO GROUPING: two redials leave two separate call rows, each settled on its own", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findCallerRinging.mockResolvedValue([
      { ...staleRing(30), callId: "stale-1" },
      { ...staleRing(40), callId: "stale-2", privateRoomId: "room-0" },
    ]);

    await redial(service);

    const missedCards = stubs.callChatMessages.post.mock.calls
      .filter((c: [{ outcome: string }]) => c[0].outcome === "MISSED")
      .map((c: [{ callId: string }]) => c[0].callId);
    expect(missedCards).toEqual(["stale-1", "stale-2"]);
    // One push per call session — never one "2 missed calls".
    expect(publishCallMissedSafe as jest.Mock).toHaveBeenCalledTimes(2);
  });
});
