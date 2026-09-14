/**
 * `sweepOrphanedCalls` — end a call once every participant is gone, instead of
 * waiting out the three-hour max-duration ceiling.
 *
 * The gateway arms an in-process `setTimeout` when a participant's socket
 * drops, and that timer is the only thing that ends a call nobody hung up. It
 * lives in one node's memory, it is `unref`ed, and the gateway installs no
 * SIGTERM handler — so a redeploy loses it silently, and on a crash the
 * `disconnecting` handler never runs to arm it at all. The row then sits
 * IN_PROGRESS for the full ceiling, with BOTH participants unable to place or
 * receive any call for three hours.
 *
 * The replacement cannot be a timer for that reason, so it asks a liveness
 * question instead. That is the right question because a call only becomes
 * stranded when nobody is left to hang it up: if a participant were still
 * connected, their client would end the call normally.
 *
 * The test that matters most here is the short-read one. The presence lookup
 * swallows its own Redis errors and returns an EMPTY map, which read literally
 * says "nobody is online" — so a naive implementation ends every live call on
 * the platform during a Redis blip.
 */
import { CallService } from "../../src/services/call.service.js";

const NOW = new Date(10_000_000_000);
const GRACE = 300;
const MAX = 10_800;

/** An IN_PROGRESS call answered well before NOW, between u1 and u2. */
const strandedCall = (callId: string, over: Record<string, unknown> = {}) => ({
  callId,
  callerId: "u1",
  calleeId: "u2",
  calleeIds: [],
  privateRoomId: "r1",
  type: "AUDIO",
  status: "IN_PROGRESS",
  initiatedAt: new Date(NOW.getTime() - 3_600_000),
  answeredAt: new Date(NOW.getTime() - 3_600_000),
  ...over,
});

function buildService(
  getOnlineMany?: (ids: string[]) => Promise<Map<string, boolean>>
) {
  const stubs = {
    callRepo: {
      claimStatusTransition: jest.fn().mockResolvedValue({ won: true }),
      findStuckInProgress: jest.fn().mockResolvedValue([]),
    },
    redis: { publish: jest.fn().mockResolvedValue(1) },
    getUserSnapshot: jest
      .fn()
      .mockResolvedValue({ displayName: "", avatarUrl: "" }),
    callChatMessages: { post: jest.fn().mockResolvedValue(null) },
    getOnlineMany: jest.fn(
      getOnlineMany ??
        (async (ids: string[]) => new Map(ids.map((id) => [id, false])))
    ),
  };
  const service = new CallService(
    stubs.callRepo as never,
    {} as never,
    stubs.redis as never,
    {} as never,
    {} as never,
    jest.fn() as never,
    stubs.getUserSnapshot,
    stubs.callChatMessages as never,
    undefined,
    undefined,
    undefined,
    stubs.getOnlineMany as never
  );
  return { service, stubs };
}

describe("CallService.sweepOrphanedCalls", () => {
  it("ends a call when no participant is connected", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findStuckInProgress.mockResolvedValue([
      strandedCall("c1"),
    ]);

    const flipped = await service.sweepOrphanedCalls(NOW, GRACE, MAX, 50);

    expect(flipped).toBe(1);
    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "c1",
      "IN_PROGRESS",
      // A distinct sentinel from the 3h ceiling's SYSTEM_TIMEOUT, so support and
      // analytics can tell the two apart. No client sees it — the REST DTO
      // collapses anything starting with SYSTEM.
      expect.objectContaining({ status: "ENDED", endedBy: "SYSTEM_ORPHANED" })
    );
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "call:c1",
      expect.stringContaining("call:ended")
    );
  });

  it("leaves the call alone while any participant is still connected", async () => {
    const { service, stubs } = buildService(
      async () =>
        // The callee is gone, the caller is not. One live participant is enough:
        // their client is what will end the call normally.
        new Map([
          ["u1", true],
          ["u2", false],
        ])
    );
    stubs.callRepo.findStuckInProgress.mockResolvedValue([
      strandedCall("c1"),
    ]);

    const flipped = await service.sweepOrphanedCalls(NOW, GRACE, MAX, 50);

    expect(flipped).toBe(0);
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
    expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
  });

  it("does NOTHING when the liveness lookup comes back short", async () => {
    // The presence service returns an empty map on ANY Redis error, and a
    // partial answer is indistinguishable from that. Read literally it means
    // "everyone is offline", so without this guard one Redis blip ends every
    // live call at once. A delayed cleanup is recoverable; that is not.
    const { service, stubs } = buildService(
      async () => new Map([["u1", false]]) // u2 missing
    );
    stubs.callRepo.findStuckInProgress.mockResolvedValue([
      strandedCall("c1"),
    ]);

    const flipped = await service.sweepOrphanedCalls(NOW, GRACE, MAX, 50);

    expect(flipped).toBe(0);
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
  });

  it("does NOTHING when the liveness lookup throws outright", async () => {
    const { service, stubs } = buildService(async () => {
      throw new Error("redis down");
    });
    stubs.callRepo.findStuckInProgress.mockResolvedValue([
      strandedCall("c1"),
    ]);

    await expect(
      service.sweepOrphanedCalls(NOW, GRACE, MAX, 50)
    ).resolves.toBe(0);
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
  });

  it("asks for calls older than the GRACE, not the 3h ceiling", async () => {
    const { service, stubs } = buildService();

    await service.sweepOrphanedCalls(NOW, GRACE, MAX, 50);

    // The whole point of this sweep is the shorter cutoff. Handing it
    // maxDurationSec would make it a duplicate of sweepStaleInProgressCalls and
    // silently restore the three-hour wait.
    expect(stubs.callRepo.findStuckInProgress).toHaveBeenCalledWith(
      new Date(NOW.getTime() - GRACE * 1000),
      50
    );
  });

  it("settles a never-connected orphan as CANCELLED with no duration", async () => {
    // Shares settleStrandedCall with the ceiling sweep, so the rule that an
    // IN_PROGRESS row with no answeredAt is a cancelled ring — not a
    // full-length call — has to hold on this path too.
    const { service, stubs } = buildService();
    stubs.callRepo.findStuckInProgress.mockResolvedValue([
      strandedCall("c1", { answeredAt: null }),
    ]);

    await service.sweepOrphanedCalls(NOW, GRACE, MAX, 50);

    const update = stubs.callRepo.claimStatusTransition.mock
      .calls[0][2] as { durationSec: number };
    expect(update.durationSec).toBe(0);
    const card = stubs.callChatMessages.post.mock.calls[0][0] as {
      outcome: string;
    };
    expect(card.outcome).toBe("CANCELLED");
  });

  it("asks about every participant exactly once across the batch", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findStuckInProgress.mockResolvedValue([
      strandedCall("c1"),
      strandedCall("c2"),
    ]);

    await service.sweepOrphanedCalls(NOW, GRACE, MAX, 50);

    // One batched lookup for the whole page, de-duplicated — not one per call
    // and not one per participant.
    expect(stubs.getOnlineMany).toHaveBeenCalledTimes(1);
    expect(stubs.getOnlineMany.mock.calls[0][0].sort()).toEqual(["u1", "u2"]);
  });

  it("no-ops when no liveness source is wired at all", async () => {
    // The dependency is optional so existing construction sites compile
    // unchanged. Absent, the ceiling stays the only backstop — the behaviour
    // that predates this sweep — rather than everything reading as offline.
    const service = new CallService(
      { findStuckInProgress: jest.fn(), claimStatusTransition: jest.fn() } as never,
      {} as never,
      { publish: jest.fn() } as never,
      {} as never,
      {} as never,
      jest.fn() as never,
      jest.fn() as never
    );

    await expect(
      service.sweepOrphanedCalls(NOW, GRACE, MAX, 50)
    ).resolves.toBe(0);
  });
});
