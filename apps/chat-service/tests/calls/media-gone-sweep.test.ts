/**
 * `sweepAbandonedMediaCalls` — end an answered call once LiveKit's room has
 * lost a participant and still lacks them a few seconds later.
 *
 * This is what frees two users after one app is killed mid-call (crash,
 * force-quit, an auto-update). The gateway's disconnect cleanup is an in-memory
 * timer, the `participant_left` webhook is not guaranteed and its head-count is
 * a lagging cache, and the orphan sweep needs BOTH users offline — so without
 * this the row stays IN_PROGRESS and both users read "busy" for three hours.
 *
 * The tests that matter most are the ones that must NOT end a call: a room that
 * is full again, a LiveKit lookup that failed, and a callee still joining.
 */
import { ServerError } from "livekit-server-sdk";

import { CallService } from "../../src/services/call.service.js";
import { LiveKitService } from "../../src/services/livekit.service.js";

const KEY = "call:media-gone";
const NOW = new Date(10_000_000_000);
const SEEN = NOW.getTime() - 15_000;
const MAX = 10_800;
const BATCH = 50;

/** An IN_PROGRESS call answered five minutes before NOW, between u1 and u2. */
const liveCall = (callId: string, over: Record<string, unknown> = {}) => ({
  callId,
  callerId: "u1",
  calleeId: "u2",
  calleeIds: [],
  privateRoomId: "r1",
  type: "AUDIO",
  status: "IN_PROGRESS",
  initiatedAt: new Date(NOW.getTime() - 310_000),
  answeredAt: new Date(NOW.getTime() - 300_000),
  ...over,
});

function buildService() {
  const stubs = {
    callRepo: {
      findByCallId: jest.fn().mockResolvedValue(liveCall("c1")),
      findStuckInProgress: jest.fn().mockResolvedValue([]),
      claimStatusTransition: jest.fn().mockResolvedValue({ won: true }),
    },
    redis: {
      publish: jest.fn().mockResolvedValue(1),
      zrangebyscore: jest.fn().mockResolvedValue(["c1", String(SEEN)]),
      zrem: jest.fn().mockResolvedValue(1),
      zadd: jest.fn().mockResolvedValue(1),
      // No poll lease by default, so the confirm tests see only the confirm step.
      set: jest.fn().mockResolvedValue(null),
    },
    livekit: {
      countParticipants: jest.fn().mockResolvedValue(1),
      deleteRoom: jest.fn().mockResolvedValue(undefined),
    },
    getUserSnapshot: jest
      .fn()
      .mockResolvedValue({ displayName: "", avatarUrl: "" }),
    callChatMessages: { post: jest.fn().mockResolvedValue(null) },
  };
  const service = new CallService(
    stubs.callRepo as never,
    {} as never,
    stubs.redis as never,
    stubs.livekit as never,
    {} as never,
    jest.fn() as never,
    stubs.getUserSnapshot,
    stubs.callChatMessages as never
  );
  return { service, stubs };
}

describe("CallService.sweepAbandonedMediaCalls — confirm", () => {
  it("ends a call whose room is still short, dated to the first sighting", async () => {
    const { service, stubs } = buildService();

    const ended = await service.sweepAbandonedMediaCalls(NOW, MAX, BATCH);

    expect(ended).toBe(1);
    // Only sightings at least 10s old are re-checked.
    expect(stubs.redis.zrangebyscore).toHaveBeenCalledWith(
      KEY,
      "-inf",
      NOW.getTime() - 10_000,
      "WITHSCORES",
      "LIMIT",
      0,
      BATCH
    );
    expect(stubs.livekit.countParticipants).toHaveBeenCalledWith("c1");
    // Ended at the sighting, not at the confirmation: 300s - 15s = 285s.
    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "c1",
      "IN_PROGRESS",
      {
        status: "ENDED",
        endedAt: new Date(SEEN),
        durationSec: 285,
        endedBy: "SYSTEM_LIVEKIT",
      }
    );
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "call:c1",
      expect.stringContaining('"call:ended"')
    );
    expect(stubs.callChatMessages.post).toHaveBeenCalled();
    expect(stubs.redis.zrem).toHaveBeenCalledWith(KEY, "c1");
  });

  it("an empty room (both gone, or the room closed) ends the call too", async () => {
    const { service, stubs } = buildService();
    stubs.livekit.countParticipants.mockResolvedValue(0);

    await expect(
      service.sweepAbandonedMediaCalls(NOW, MAX, BATCH)
    ).resolves.toBe(1);
  });

  it("leaves the call alone when the room is full again, and drops the sighting", async () => {
    const { service, stubs } = buildService();
    // A duplicate-identity eviction, or a peer who reconnected in time.
    stubs.livekit.countParticipants.mockResolvedValue(2);

    await expect(
      service.sweepAbandonedMediaCalls(NOW, MAX, BATCH)
    ).resolves.toBe(0);

    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
    expect(stubs.redis.zrem).toHaveBeenCalledWith(KEY, "c1");
  });

  it("never ends a call when LiveKit cannot be asked, and stops the pass", async () => {
    const { service, stubs } = buildService();
    stubs.redis.zrangebyscore.mockResolvedValue([
      "c1",
      String(SEEN),
      "c2",
      String(SEEN),
    ]);
    stubs.livekit.countParticipants.mockRejectedValue(new Error("fetch failed"));

    await expect(
      service.sweepAbandonedMediaCalls(NOW, MAX, BATCH)
    ).resolves.toBe(0);

    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    // Sightings survive for the next pass, and an outage costs ONE lookup.
    expect(stubs.redis.zrem).not.toHaveBeenCalled();
    expect(stubs.livekit.countParticipants).toHaveBeenCalledTimes(1);
  });

  it("waits while the callee may still be joining (answered under 60s ago)", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(
      liveCall("c1", { answeredAt: new Date(NOW.getTime() - 20_000) })
    );

    await expect(
      service.sweepAbandonedMediaCalls(NOW, MAX, BATCH)
    ).resolves.toBe(0);

    expect(stubs.livekit.countParticipants).not.toHaveBeenCalled();
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    expect(stubs.redis.zrem).not.toHaveBeenCalled();
  });

  it("drops the sighting of a call that already ended, without asking LiveKit", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(
      liveCall("c1", { status: "ENDED" })
    );

    await expect(
      service.sweepAbandonedMediaCalls(NOW, MAX, BATCH)
    ).resolves.toBe(0);

    expect(stubs.livekit.countParticipants).not.toHaveBeenCalled();
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    expect(stubs.redis.zrem).toHaveBeenCalledWith(KEY, "c1");
  });

  it("a pass that starts while another is running does nothing", async () => {
    const { service, stubs } = buildService();
    let release!: (v: string[]) => void;
    stubs.redis.zrangebyscore.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        release = resolve;
      })
    );

    const first = service.sweepAbandonedMediaCalls(NOW, MAX, BATCH);
    await expect(
      service.sweepAbandonedMediaCalls(NOW, MAX, BATCH)
    ).resolves.toBe(0);
    release([]);
    await first;

    expect(stubs.redis.zrangebyscore).toHaveBeenCalledTimes(1);
  });
});

describe("CallService.sweepAbandonedMediaCalls — poll", () => {
  it("flags a short room found by the poll, but never ends it in the same pass", async () => {
    const { service, stubs } = buildService();
    stubs.redis.zrangebyscore.mockResolvedValue([]);
    stubs.redis.set.mockResolvedValue("OK");
    stubs.callRepo.findStuckInProgress.mockResolvedValue([liveCall("c9")]);

    await expect(
      service.sweepAbandonedMediaCalls(NOW, MAX, BATCH)
    ).resolves.toBe(0);

    // One poll per 30s across every node.
    expect(stubs.redis.set).toHaveBeenCalledWith(
      "lock:call-media-poll",
      "1",
      "EX",
      30,
      "NX"
    );
    expect(stubs.callRepo.findStuckInProgress).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 60_000),
      BATCH
    );
    expect(stubs.redis.zadd).toHaveBeenCalledWith(
      KEY,
      "NX",
      expect.any(Number),
      "c9"
    );
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
  });

  it("does not flag a room that still holds both people", async () => {
    const { service, stubs } = buildService();
    stubs.redis.zrangebyscore.mockResolvedValue([]);
    stubs.redis.set.mockResolvedValue("OK");
    stubs.callRepo.findStuckInProgress.mockResolvedValue([liveCall("c9")]);
    stubs.livekit.countParticipants.mockResolvedValue(2);

    await service.sweepAbandonedMediaCalls(NOW, MAX, BATCH);

    expect(stubs.redis.zadd).not.toHaveBeenCalled();
  });

  it("skips the poll while another node holds the lease", async () => {
    const { service, stubs } = buildService();
    stubs.redis.zrangebyscore.mockResolvedValue([]);

    await service.sweepAbandonedMediaCalls(NOW, MAX, BATCH);

    expect(stubs.callRepo.findStuckInProgress).not.toHaveBeenCalled();
    expect(stubs.livekit.countParticipants).not.toHaveBeenCalled();
  });
});

describe("LiveKitService.countParticipants", () => {
  const withRoster = (listParticipants: jest.Mock) =>
    Object.assign(new LiveKitService(), { rooms: { listParticipants } });

  it("counts the live roster", async () => {
    const svc = withRoster(jest.fn().mockResolvedValue([{}, {}]));
    await expect(svc.countParticipants("c1")).resolves.toBe(2);
  });

  it("reads a room LiveKit does not know as empty", async () => {
    const svc = withRoster(
      jest
        .fn()
        .mockRejectedValue(
          new ServerError("Not Found", "room not found", 404, "not_found")
        )
    );
    await expect(svc.countParticipants("c1")).resolves.toBe(0);
  });

  // A proxy that does not route /twirp answers a bare 404 for EVERY room;
  // reading that as "empty" would end every call at once.
  it("does not read a bare 404 as empty", async () => {
    const svc = withRoster(
      jest
        .fn()
        .mockRejectedValue(new ServerError("Not Found", "<html>", 404))
    );
    await expect(svc.countParticipants("c1")).rejects.toBeInstanceOf(
      ServerError
    );
  });

  it("does not read a transport failure as empty", async () => {
    const svc = withRoster(
      jest.fn().mockRejectedValue(new TypeError("fetch failed"))
    );
    await expect(svc.countParticipants("c1")).rejects.toBeInstanceOf(
      TypeError
    );
  });
});
