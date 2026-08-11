/**
 * Unit tests — CallService sweep (RINGING → MISSED) + reconcile from LiveKit
 * `room_finished`. See Docs/calls/CALLS-LIVEKIT.md §7 Phase 3.
 *
 * Direct service tests. Stubs Redis publish, callRepo, and the Prisma layer.
 */
import { CallService } from "../../src/services/call.service.js";

function buildService() {
  const stubs = {
    callRepo: {
      create: jest.fn(),
      findByCallId: jest.fn(),
      updateStatus: jest.fn().mockResolvedValue({ callId: "c" }),
      claimStatusTransition: jest.fn().mockResolvedValue({ won: true }),
      findByParticipant: jest.fn(),
      findActiveByParticipant: jest.fn().mockResolvedValue([]),
      findStuckRinging: jest.fn(),
      claimForMissed: jest.fn(),
      // Default to "nothing stranded" so the existing sweep tests are unaffected.
      findStuckInProgress: jest.fn().mockResolvedValue([]),
    },
    privateRoomRepo: {
      findByRoomId: jest.fn(),
      findByParticipantsKey: jest.fn(),
    },
    redis: {
      publish: jest.fn().mockResolvedValue(1),
      // Media-leg claim: SET NX succeeds by default (nobody holds the leg).
      set: jest.fn().mockResolvedValue("OK"),
      get: jest.fn().mockResolvedValue(null),
      eval: jest.fn().mockResolvedValue(1),
    },
    livekit: { mintToken: jest.fn() },
    friendshipRepo: { areFriends: jest.fn() },
    getCallPrivacy: jest.fn(),
    getUserSnapshot: jest
      .fn()
      .mockResolvedValue({ displayName: "", avatarUrl: "" }),
    callChatMessages: { post: jest.fn().mockResolvedValue(null) },
  };
  const service = new CallService(
    stubs.callRepo as never,
    stubs.privateRoomRepo as never,
    stubs.redis as never,
    stubs.livekit as never,
    stubs.friendshipRepo as never,
    stubs.getCallPrivacy,
    stubs.getUserSnapshot,
    stubs.callChatMessages as never
  );
  return { service, stubs };
}

describe("CallService.sweepMissedCalls", () => {
  it("flips claimed rows and publishes call:missed to both rooms", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findStuckRinging.mockResolvedValue([
      {
        callId: "c1",
        callerId: "u1",
        calleeId: "u2",
        privateRoomId: "r1",
        type: "AUDIO",
      },
      {
        callId: "c2",
        callerId: "u1",
        calleeId: "u3",
        privateRoomId: "r2",
        type: "VIDEO",
      },
    ]);
    stubs.callRepo.claimForMissed.mockResolvedValue({ won: true });

    const flipped = await service.sweepMissedCalls(new Date(1_000_000), 60, 50);

    expect(flipped).toBe(2);
    // Both call rooms AND both user rooms got a publish (2 * 2 = 4).
    expect(stubs.redis.publish).toHaveBeenCalledTimes(4);
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "call:c1",
      expect.stringContaining("call:missed")
    );
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "self:u2",
      expect.stringContaining("call:missed")
    );
    expect(stubs.callChatMessages.post).toHaveBeenCalledTimes(2);
    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "c1", outcome: "MISSED" })
    );
  });

  it("skips publishing for rows the atomic claim lost (multi-node race)", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findStuckRinging.mockResolvedValue([
      { callId: "c1", calleeId: "u2" },
    ]);
    stubs.callRepo.claimForMissed.mockResolvedValue({ won: false });

    const flipped = await service.sweepMissedCalls(new Date(), 60, 50);

    expect(flipped).toBe(0);
    expect(stubs.redis.publish).not.toHaveBeenCalled();
    expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
  });

  it("no candidates → no publishes, returns 0", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findStuckRinging.mockResolvedValue([]);
    const flipped = await service.sweepMissedCalls(new Date(), 60, 50);
    expect(flipped).toBe(0);
    expect(stubs.callRepo.claimForMissed).not.toHaveBeenCalled();
  });
});

describe("CallService.reconcileFromLiveKitRoomFinished", () => {
  it("IN_PROGRESS → ENDED with computed durationSec + publishes call:ended", async () => {
    const { service, stubs } = buildService();
    const answered = new Date(1_000_000);
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      status: "IN_PROGRESS",
      answeredAt: answered,
      callerId: "u1",
      calleeId: "u2",
      privateRoomId: "r1",
      type: "AUDIO",
    });

    await service.reconcileFromLiveKitRoomFinished("c1", "room_finished");

    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "c1",
      "IN_PROGRESS",
      expect.objectContaining({
        status: "ENDED",
        endedBy: "SYSTEM_LIVEKIT",
        durationSec: expect.any(Number),
      })
    );
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "call:c1",
      expect.stringContaining("call:ended")
    );
    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "c1", outcome: "ENDED" })
    );
  });

  it("unknown room → no writes, no publishes", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(null);
    await service.reconcileFromLiveKitRoomFinished("nope", "room_finished");
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
  });

  it("already ENDED → idempotent no-op", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      status: "ENDED",
    });
    await service.reconcileFromLiveKitRoomFinished("c1", "room_finished");
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
  });

  it("RINGING → cancels (caller abandoned before answer): RINGING→ENDED + call:cancelled to BOTH rooms + CANCELLED chat row", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      status: "RINGING",
      callerId: "u1",
      calleeId: "u2",
      privateRoomId: "r1",
      type: "AUDIO",
    });

    await service.reconcileFromLiveKitRoomFinished("c1", "room_finished");

    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "c1",
      "RINGING",
      expect.objectContaining({ status: "ENDED", endedBy: "SYSTEM_LIVEKIT" })
    );
    // Callee on their personal channel (they never joined call:<id>)...
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "self:u2",
      expect.stringContaining("call:cancelled")
    );
    // ...and caller on `call:<id>` (they joined at ack) so their FE clears too,
    // covering the rare network-split where their own Disconnected doesn't fire.
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "call:c1",
      expect.stringContaining("call:cancelled")
    );
    // Pre-answer cancel posts a CANCELLED audit row — mirrors endCall's wasRinging.
    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "c1", outcome: "CANCELLED" })
    );
  });

  // Regression: rapid cancel-then-recall churns the caller's LiveKit connection,
  // and during RINGING the caller is the room's ONLY participant — so treating
  // participant_left like room_finished cancelled the brand-new call. The caller
  // saw a 15s hang then "engine not connected"; the callee's incoming box
  // appeared and vanished before it could be answered.
  it("RINGING + participant_left → ignored (only room_finished may cancel a ring)", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      status: "RINGING",
      callerId: "u1",
      calleeId: "u2",
      privateRoomId: "r1",
      type: "AUDIO",
    });

    await service.reconcileFromLiveKitRoomFinished("c1", "participant_left");

    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
    expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
  });

  it("IN_PROGRESS + participant_left → still ends (a peer dropping ends an answered call)", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      status: "IN_PROGRESS",
      answeredAt: new Date(1_000_000),
      callerId: "u1",
      calleeId: "u2",
      privateRoomId: "r1",
      type: "AUDIO",
    });

    await service.reconcileFromLiveKitRoomFinished("c1", "participant_left");

    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "c1",
      "IN_PROGRESS",
      expect.objectContaining({ status: "ENDED", endedBy: "SYSTEM_LIVEKIT" })
    );
  });

  it("RINGING with a lost claim (raced by decline/sweep) publishes nothing", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      status: "RINGING",
      callerId: "u1",
      calleeId: "u2",
    });
    stubs.callRepo.claimStatusTransition.mockResolvedValue({ won: false });

    await service.reconcileFromLiveKitRoomFinished("c1", "room_finished");

    expect(stubs.redis.publish).not.toHaveBeenCalled();
    expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
  });

  it("losing the atomic terminal transition emits no event or chat row", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      status: "IN_PROGRESS",
      answeredAt: new Date(),
      callerId: "u1",
      calleeId: "u2",
      privateRoomId: "r1",
      type: "AUDIO",
    });
    stubs.callRepo.claimStatusTransition.mockResolvedValue({ won: false });

    await service.reconcileFromLiveKitRoomFinished("c1", "room_finished");

    expect(stubs.redis.publish).not.toHaveBeenCalled();
    expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
  });
});

describe("CallService.endCall chat messages", () => {
  it("posts a duration audit row only for an answered call", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      status: "IN_PROGRESS",
      answeredAt: new Date(Date.now() - 65_000),
      callerId: "u1",
      calleeId: "u2",
      privateRoomId: "r1",
      type: "VIDEO",
    });

    await service.endCall({ callId: "c1", userId: "u1" });

    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "c1",
        outcome: "ENDED",
        durationSec: expect.any(Number),
      })
    );
  });

  it("posts a CANCELLED chat row when the caller cancels before answer", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      status: "RINGING",
      answeredAt: null,
      callerId: "u1",
      calleeId: "u2",
      privateRoomId: "r1",
      type: "AUDIO",
    });

    await service.endCall({ callId: "c1", userId: "u1" });

    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "c1",
        outcome: "CANCELLED",
        durationSec: 0,
      })
    );
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "self:u2",
      expect.stringContaining("call:cancelled")
    );
    // Regression: the caller's OTHER devices show an outgoing-mirror banner for
    // this ring. Without a publish on the caller's own channel they never learn
    // it was cancelled and the banner stays up forever, blocking later calls.
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "self:u1",
      expect.stringContaining("call:cancelled")
    );
  });
});

/**
 * Media-leg ownership. Call signalling is broadcast to `self:<userId>` — every
 * device of the user — so without a per-leg claim nothing can tell the device
 * that answered from the ones that only watched it ring, and a sibling tab ends
 * up able to hang up a call it was never on.
 */
describe("CallService — call leg ownership", () => {
  const ringingCall = {
    callId: "c1",
    status: "RINGING",
    callerId: "u1",
    calleeId: "u2",
    privateRoomId: "r1",
    type: "AUDIO",
  };

  it("a second device answering the same ring is rejected, not told it won", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingCall);
    stubs.redis.set.mockResolvedValue(null); // legA already holds the claim
    stubs.redis.get.mockResolvedValue("legA");

    await expect(
      service.answerCall({ callId: "c1", calleeId: "u2", legId: "legB" })
    ).rejects.toThrow("CALL_ALREADY_ANSWERED");

    // Never mint a token for the loser: holding one is what let it join LiveKit,
    // evict the answering leg, and take the whole call down with it.
    expect(stubs.livekit.mintToken).not.toHaveBeenCalled();
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
  });

  it("the SAME leg re-answering still wins (retry / socket reconnect)", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingCall);
    stubs.redis.set.mockResolvedValue(null);
    stubs.redis.get.mockResolvedValue("legA");
    stubs.livekit.mintToken.mockResolvedValue({ url: "ws://lk", token: "t" });

    const result = await service.answerCall({
      callId: "c1",
      calleeId: "u2",
      legId: "legA",
    });

    expect(result.status).toBe("IN_PROGRESS");
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "self:u2",
      expect.stringContaining("call:handled")
    );
  });

  it("`call:handled` names the winning leg so the gateway can skip that device", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingCall);
    stubs.livekit.mintToken.mockResolvedValue({ url: "ws://lk", token: "t" });

    await service.answerCall({ callId: "c1", calleeId: "u2", legId: "legA" });

    const handled = stubs.redis.publish.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("call:handled")
    );
    expect(JSON.parse(String(handled?.[1])).data).toEqual(
      expect.objectContaining({ handledByLegId: "legA" })
    );
    // And `call:answered` says WHO picked up, so a group callee still free to
    // join doesn't mistake it for their own device answering.
    const answered = stubs.redis.publish.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("call:answered")
    );
    expect(JSON.parse(String(answered?.[1])).data).toEqual(
      expect.objectContaining({ answeredByUserId: "u2" })
    );
  });

  it("fails CLOSED when Redis is unreachable — never grants the call to both", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringingCall);
    stubs.redis.set.mockRejectedValue(new Error("redis down"));

    await expect(
      service.answerCall({ callId: "c1", calleeId: "u2", legId: "legA" })
    ).rejects.toThrow("redis down");
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
  });

  it("endCall from a callee leg that did not answer is a silent no-op", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      ...ringingCall,
      status: "IN_PROGRESS",
      answeredAt: new Date(Date.now() - 30_000),
    });
    stubs.redis.get.mockResolvedValue("legA");

    const result = await service.endCall({
      callId: "c1",
      userId: "u2",
      legId: "legB",
    });

    expect(result.status).toBe("IN_PROGRESS");
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
  });

  it("endCall from the answering leg still ends the call", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      ...ringingCall,
      status: "IN_PROGRESS",
      answeredAt: new Date(Date.now() - 30_000),
    });
    stubs.redis.get.mockResolvedValue("legA");

    await service.endCall({ callId: "c1", userId: "u2", legId: "legA" });

    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "c1",
      "IN_PROGRESS",
      expect.objectContaining({ status: "ENDED", endedBy: "u2" })
    );
  });

  it("the CALLER's other devices may still hang up (spec §4.2 mirror hangup)", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      ...ringingCall,
      status: "IN_PROGRESS",
      answeredAt: new Date(Date.now() - 30_000),
    });
    stubs.redis.get.mockResolvedValue("legA");

    await service.endCall({
      callId: "c1",
      userId: "u1",
      legId: "some-other-leg",
    });

    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalled();
  });

  it("participant_left with both peers still in the room does NOT end the call", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      ...ringingCall,
      status: "IN_PROGRESS",
      answeredAt: new Date(Date.now() - 30_000),
    });

    // A duplicate-identity eviction: one extra leg left, the call is still up.
    await service.reconcileFromLiveKitRoomFinished("c1", "participant_left", 2);

    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
  });

  it("participant_left that leaves one peer behind still ends the call", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      ...ringingCall,
      status: "IN_PROGRESS",
      answeredAt: new Date(Date.now() - 30_000),
    });

    await service.reconcileFromLiveKitRoomFinished("c1", "participant_left", 1);

    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "c1",
      "IN_PROGRESS",
      expect.objectContaining({ status: "ENDED", endedBy: "SYSTEM_LIVEKIT" })
    );
  });
});

describe("CallService.sweepStaleInProgressCalls", () => {
  const NOW = new Date(10_000_000_000);
  const MAX = 14_400; // 4h

  /** A call answered `agoSec` before NOW. */
  const staleCall = (callId: string, agoSec: number) => ({
    callId,
    callerId: "u1",
    calleeId: "u2",
    privateRoomId: "r1",
    type: "AUDIO",
    answeredAt: new Date(NOW.getTime() - agoSec * 1000),
  });

  it("flips a stranded IN_PROGRESS call to ENDED with endedBy SYSTEM_TIMEOUT", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findStuckInProgress.mockResolvedValue([
      staleCall("c1", MAX + 600),
    ]);

    const flipped = await service.sweepStaleInProgressCalls(NOW, MAX, 50);

    expect(flipped).toBe(1);
    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "c1",
      "IN_PROGRESS",
      expect.objectContaining({
        status: "ENDED",
        endedBy: "SYSTEM_TIMEOUT",
      })
    );
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "call:c1",
      expect.stringContaining("call:ended")
    );
    expect(stubs.callChatMessages.post).toHaveBeenCalledTimes(1);
  });

  it("CAPS durationSec at maxDurationSec — an 8-day stranded call must not record 8 days", async () => {
    const { service, stubs } = buildService();
    const eightDaysSec = 8 * 24 * 60 * 60;
    stubs.callRepo.findStuckInProgress.mockResolvedValue([
      staleCall("c1", eightDaysSec),
    ]);

    await service.sweepStaleInProgressCalls(NOW, MAX, 50);

    const update = stubs.callRepo.claimStatusTransition.mock.calls[0][2] as {
      durationSec: number;
    };
    expect(update.durationSec).toBe(MAX);
    expect(update.durationSec).toBeLessThan(eightDaysSec);
  });

  it("does NOT touch fresh IN_PROGRESS calls — the repo cutoff excludes them", async () => {
    const { service, stubs } = buildService();
    // A live call is simply absent from the finder's result set.
    stubs.callRepo.findStuckInProgress.mockResolvedValue([]);

    const flipped = await service.sweepStaleInProgressCalls(NOW, MAX, 50);

    expect(flipped).toBe(0);
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
    expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
    // The cutoff must be derived from maxDurationSec, not hardcoded.
    expect(stubs.callRepo.findStuckInProgress).toHaveBeenCalledWith(
      new Date(NOW.getTime() - MAX * 1000),
      50
    );
  });

  it("IDEMPOTENT: a lost claim race publishes nothing and is not counted", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findStuckInProgress.mockResolvedValue([
      staleCall("c1", MAX + 600),
    ]);
    // Another node won the transition first.
    stubs.callRepo.claimStatusTransition.mockResolvedValue({ won: false });

    const flipped = await service.sweepStaleInProgressCalls(NOW, MAX, 50);

    expect(flipped).toBe(0);
    expect(stubs.redis.publish).not.toHaveBeenCalled();
    expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
  });
});
