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
      findStuckRinging: jest.fn(),
      findStuckInProgress: jest.fn().mockResolvedValue([]),
      claimForMissed: jest.fn(),
      // Default to "nothing stranded" so the existing sweep tests are unaffected.
      findStuckInProgress: jest.fn().mockResolvedValue([]),
    },
    privateRoomRepo: {
      findByRoomId: jest.fn(),
      findByParticipantsKey: jest.fn(),
    },
    redis: { publish: jest.fn().mockResolvedValue(1) },
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

    await service.reconcileFromLiveKitRoomFinished("c1");

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
    await service.reconcileFromLiveKitRoomFinished("nope");
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
  });

  it("already ENDED → idempotent no-op", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      status: "ENDED",
    });
    await service.reconcileFromLiveKitRoomFinished("c1");
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
  });

  it("RINGING → leave alone (sweep will pick it up as MISSED)", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      status: "RINGING",
    });
    await service.reconcileFromLiveKitRoomFinished("c1");
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
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

    await service.reconcileFromLiveKitRoomFinished("c1");

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

  it("does not post a chat row when the caller cancels before answer", async () => {
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

    expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "self:u2",
      expect.stringContaining("call:cancelled")
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
