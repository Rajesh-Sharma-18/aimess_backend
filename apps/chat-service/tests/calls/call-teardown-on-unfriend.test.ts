/**
 * Unit tests — CallService.endCallsBetween.
 *
 * "Calls are between friends" was previously only enforced at the START of a
 * call (`assertCanStartCall`) and, while still ringing, at answer time. An
 * unfriend or a block landing on a call that was ALREADY established did
 * nothing: the two parties kept talking on a call neither was any longer
 * authorized to be on. `friendship.deleted` / `friendship.blocked` now reach
 * this method through `events/call-teardown-bridge.ts`.
 *
 * Direct service tests (no gRPC, no AMQP, no Express) — the call/room repos,
 * Redis, LiveKit and the friendship repo are all stubbed.
 */
import { CallService } from "../../src/services/call.service.js";

interface Stubs {
  callRepo: {
    findAllActiveBetween: jest.Mock;
    claimStatusTransition: jest.Mock;
  };
  redis: { publish: jest.Mock; set: jest.Mock; eval: jest.Mock };
  callChatMessages: { post: jest.Mock };
}

function buildService(): { service: CallService; stubs: Stubs } {
  const stubs: Stubs = {
    callRepo: {
      findAllActiveBetween: jest.fn().mockResolvedValue([]),
      claimStatusTransition: jest.fn().mockResolvedValue({ won: true }),
    },
    redis: {
      publish: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue("OK"),
      eval: jest.fn().mockResolvedValue(1),
    },
    callChatMessages: { post: jest.fn().mockResolvedValue(undefined) },
  };
  const service = new CallService(
    stubs.callRepo as never,
    {} as never, // privateRoomRepo — unused on this path
    stubs.redis as never,
    { mintToken: jest.fn() } as never,
    { areFriends: jest.fn() } as never,
    jest.fn(),
    jest.fn(),
    stubs.callChatMessages as never
  );
  return { service, stubs };
}

const RINGING_CALL = {
  callId: "c-ring",
  callerId: "alice",
  calleeId: "bob",
  calleeIds: [],
  status: "RINGING",
  type: "AUDIO",
  answeredAt: null,
  privateRoomId: "room-1",
};

const LIVE_CALL = {
  ...RINGING_CALL,
  callId: "c-live",
  status: "IN_PROGRESS",
  // Answered 30s ago — the recorded duration must be real, not zero.
  answeredAt: new Date(Date.now() - 30_000),
};

/** Payloads published on a given Redis channel. */
function publishesOn(stubs: Stubs, channel: string): string[] {
  return stubs.redis.publish.mock.calls
    .filter((c: unknown[]) => c[0] === channel)
    .map((c: unknown[]) => c[1] as string);
}

describe("CallService.endCallsBetween", () => {
  it("ESTABLISHED CALL: an unfriend mid-call ends it with the real duration", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findAllActiveBetween.mockResolvedValue([LIVE_CALL]);

    await expect(service.endCallsBetween("alice", "bob")).resolves.toBe(1);

    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "c-live",
      "IN_PROGRESS",
      expect.objectContaining({
        status: "ENDED",
        endedBy: "SYSTEM_FRIENDSHIP",
        durationSec: expect.any(Number),
      })
    );
    const [, , patch] = stubs.callRepo.claimStatusTransition.mock.calls[0];
    expect(patch.durationSec).toBeGreaterThanOrEqual(29);

    // Both parties are told, on the personal channel that survives a reconnect.
    for (const self of ["self:alice", "self:bob"]) {
      expect(publishesOn(stubs, self).join()).toContain("call:ended");
    }
    expect(publishesOn(stubs, "call:c-live").join()).toContain("call:ended");
    // The timeline card settles as a completed call, not a cancelled one.
    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "ENDED",
        endedBy: "SYSTEM_FRIENDSHIP",
      })
    );
  });

  it("RINGING CALL: an unfriend mid-ring cancels it, duration 0", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findAllActiveBetween.mockResolvedValue([RINGING_CALL]);

    await expect(service.endCallsBetween("alice", "bob")).resolves.toBe(1);

    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "c-ring",
      "RINGING",
      expect.objectContaining({ status: "ENDED", durationSec: 0 })
    );
    // A ring is cancelled, never "ended" — the callee never joined `call:<id>`,
    // so `self:` is the channel that actually stops their phone.
    expect(publishesOn(stubs, "self:bob").join()).toContain("call:cancelled");
    expect(publishesOn(stubs, "self:bob").join()).not.toContain("call:ended");
    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "CANCELLED" })
    );
  });

  it("ends BOTH directions when glare left a ring alive each way", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findAllActiveBetween.mockResolvedValue([
      RINGING_CALL,
      { ...RINGING_CALL, callId: "c-rev", callerId: "bob", calleeId: "alice" },
    ]);

    await expect(service.endCallsBetween("alice", "bob")).resolves.toBe(2);
    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledTimes(2);
  });

  it("NO-OP: nothing active between the pair → no writes, no publishes", async () => {
    const { service, stubs } = buildService();

    await expect(service.endCallsBetween("alice", "bob")).resolves.toBe(0);
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
  });

  // A redelivered AMQP event, or a hangup that landed first, must not produce a
  // second `call:ended` — clients would render a duplicate card.
  it("IDEMPOTENT: a lost status CAS publishes nothing and is not counted", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findAllActiveBetween.mockResolvedValue([LIVE_CALL]);
    stubs.callRepo.claimStatusTransition.mockResolvedValue({ won: false });

    await expect(service.endCallsBetween("alice", "bob")).resolves.toBe(0);
    expect(stubs.redis.publish).not.toHaveBeenCalled();
    expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
  });

  it("GUARD: a self-pair or an empty id is refused before touching the DB", async () => {
    const { service, stubs } = buildService();

    await expect(service.endCallsBetween("alice", "alice")).resolves.toBe(0);
    await expect(service.endCallsBetween("", "bob")).resolves.toBe(0);
    expect(stubs.callRepo.findAllActiveBetween).not.toHaveBeenCalled();
  });
});
