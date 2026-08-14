/**
 * Unit tests — CallService.initiateCall friendship + whoCanCallMe gate.
 * See Docs/calls/CALLS-LIVEKIT.md §7 Phase 2.
 *
 * Direct service tests (no gRPC, no Express) — stubs LiveKit, friendship repo,
 * privacy lookup, and the room+call repos.
 */
import { CallService } from "../../src/services/call.service.js";
import type { CallPrivacy } from "../../src/grpc/user-snapshot.client.js";

// `set`/`eval` back the per-caller initiate lock (withCallerLock). Without them
// the service's acquire throws and the lock silently fails open, so the tests
// would never exercise it.
type Redis = { publish: jest.Mock; set: jest.Mock; eval: jest.Mock };

interface Stubs {
  callRepo: {
    create: jest.Mock;
    findByCallId: jest.Mock;
    updateStatus: jest.Mock;
    findByParticipant: jest.Mock;
    findCallerRinging: jest.Mock;
    findActiveByParticipant: jest.Mock;
    findActiveBetween: jest.Mock;
    claimStatusTransition: jest.Mock;
  };
  privateRoomRepo: {
    findByRoomId: jest.Mock;
    findByParticipantsKey: jest.Mock;
    create: jest.Mock;
  };
  redis: Redis;
  livekit: { mintToken: jest.Mock };
  friendshipRepo: { areFriends: jest.Mock };
  getCallPrivacy: jest.Mock<Promise<CallPrivacy>, [string]>;
  getUserSnapshot: jest.Mock<
    Promise<{ displayName: string; avatarUrl: string; isDeleted?: boolean }>,
    [string]
  >;
}

function buildService(overrides: Partial<CallPrivacy> = {}): {
  service: CallService;
  stubs: Stubs;
} {
  const stubs: Stubs = {
    callRepo: {
      create: jest.fn().mockResolvedValue({
        callId: "generated",
        callerId: "caller",
        calleeId: "callee",
        status: "RINGING",
        type: "AUDIO",
      }),
      findByCallId: jest.fn(),
      updateStatus: jest.fn(),
      findByParticipant: jest.fn(),
      // Busy-gate stubs — default to "nobody busy, no glare, cleanup wins".
      findCallerRinging: jest.fn().mockResolvedValue([]),
      findActiveByParticipant: jest.fn().mockResolvedValue([]),
      findActiveBetween: jest.fn().mockResolvedValue(null),
      claimStatusTransition: jest.fn().mockResolvedValue({ won: true }),
    },
    privateRoomRepo: {
      findByRoomId: jest.fn().mockResolvedValue({
        roomId: "room-1",
        participants: ["caller", "callee"],
        blockedBy: [],
      }),
      findByParticipantsKey: jest.fn().mockResolvedValue({
        roomId: "derived-room",
        participants: ["caller", "callee"],
        blockedBy: [],
      }),
      create: jest.fn().mockResolvedValue({
        roomId: "opened-room",
        participants: ["caller", "callee"],
        blockedBy: [],
      }),
    },
    redis: {
      publish: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue("OK"),
      eval: jest.fn().mockResolvedValue(1),
    },
    livekit: {
      mintToken: jest
        .fn()
        .mockResolvedValue({ url: "ws://livekit", token: "tk" }),
    },
    friendshipRepo: { areFriends: jest.fn().mockResolvedValue(true) },
    getCallPrivacy: jest.fn().mockResolvedValue({
      whoCanCallMe: overrides.whoCanCallMe ?? "FRIENDS",
      allowedUserIds: overrides.allowedUserIds ?? [],
    }),
    getUserSnapshot: jest
      .fn()
      .mockResolvedValue({ displayName: "Alice", avatarUrl: "" }),
  };
  const service = new CallService(
    stubs.callRepo as never,
    stubs.privateRoomRepo as never,
    stubs.redis as never,
    stubs.livekit as never,
    stubs.friendshipRepo as never,
    stubs.getCallPrivacy,
    stubs.getUserSnapshot
  );
  return { service, stubs };
}

const params = {
  callerId: "caller",
  calleeId: "callee",
  type: "AUDIO",
  privateRoomId: "room-1",
};

describe("CallService.initiateCall gate", () => {
  it("POSITIVE: friends + FRIENDS → creates call, mints tokens", async () => {
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });
    const result = await service.initiateCall(params);
    expect(result.livekit).toEqual({ url: "ws://livekit", token: "tk" });
    expect(stubs.callRepo.create).toHaveBeenCalledTimes(1);
    expect(stubs.livekit.mintToken).toHaveBeenCalledTimes(2); // caller + callee
    expect(stubs.callRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ privateRoomId: "room-1" })
    );
    // Callee gets their token via self:<calleeId> (not user: — presence-safe).
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "self:callee",
      expect.stringContaining("call:incoming")
    );
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "self:caller",
      expect.stringContaining("call:outgoing_mirror")
    );
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "self:caller",
      expect.stringContaining('"calleeName":"Alice"')
    );
  });

  // Regression: initiateCall used to be fully re-entrant. Two rapid initiates from
  // the same caller interleaved, and one request's self-cleanup — which runs before
  // its own row exists — flipped the row the other had just created to ENDED. The
  // victim kept going and rang the callee for a call already dead in the DB.
  it("holds a per-caller lock: a contended initiate is rejected before any write", async () => {
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });
    stubs.redis.set.mockResolvedValue(null); // SET NX lost — another initiate holds it

    await expect(service.initiateCall(params)).rejects.toThrow(
      /CALL_ALREADY_IN_CALL/
    );

    expect(stubs.redis.set).toHaveBeenCalledWith(
      "lock:call-initiate:caller",
      expect.any(String),
      "PX",
      expect.any(Number),
      "NX"
    );
    expect(stubs.callRepo.findCallerRinging).not.toHaveBeenCalled();
    expect(stubs.callRepo.create).not.toHaveBeenCalled();
    expect(stubs.livekit.mintToken).not.toHaveBeenCalled();
  });

  it("releases the caller lock once the call row is created", async () => {
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });

    await service.initiateCall(params);

    expect(stubs.redis.eval).toHaveBeenCalledTimes(1);
    // Self-cleanup must never be able to reach rings newer than this request.
    expect(stubs.callRepo.findCallerRinging).toHaveBeenCalledWith(
      "caller",
      expect.any(Date)
    );
  });

  it("persists the derived canonical room when privateRoomId is omitted", async () => {
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });

    await service.initiateCall({ ...params, privateRoomId: undefined });

    expect(stubs.privateRoomRepo.findByParticipantsKey).toHaveBeenCalled();
    expect(stubs.callRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ privateRoomId: "derived-room" })
    );
  });

  it("NEGATIVE: not friends → FRIENDSHIP_REQUIRED, no call row, no mint", async () => {
    const { service, stubs } = buildService();
    stubs.friendshipRepo.areFriends.mockResolvedValue(false);
    await expect(service.initiateCall(params)).rejects.toThrow(
      /FRIENDSHIP_REQUIRED/
    );
    expect(stubs.callRepo.create).not.toHaveBeenCalled();
    expect(stubs.livekit.mintToken).not.toHaveBeenCalled();
    expect(stubs.privateRoomRepo.create).not.toHaveBeenCalled();
    // Rejected BEFORE the privacy lookup — friendship is unconditional now, so
    // no scope can change the answer and the gRPC hop is pointless work.
    expect(stubs.getCallPrivacy).not.toHaveBeenCalled();
    // …and above all: nothing was published, so the callee is never rung and
    // never pushed for a call attempt that was refused.
    expect(stubs.redis.publish).not.toHaveBeenCalled();
  });

  it("NEGATIVE: the callee's account is deleted → CALL_USER_UNAVAILABLE", async () => {
    const { service, stubs } = buildService();
    stubs.getUserSnapshot.mockResolvedValue({
      displayName: "Deleted Account",
      avatarUrl: "",
      isDeleted: true,
    });
    await expect(service.initiateCall(params)).rejects.toThrow(
      /CALL_USER_UNAVAILABLE/
    );
    expect(stubs.callRepo.create).not.toHaveBeenCalled();
    expect(stubs.livekit.mintToken).not.toHaveBeenCalled();
  });

  // The race in the requirement: A taps Video Call while B unfriends. The
  // up-front gate passes, then the relationship dies before the row is written.
  it("RACE: an unfriend landing after the first check still blocks the create", async () => {
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });
    stubs.friendshipRepo.areFriends
      .mockResolvedValueOnce(true) // up-front gate
      .mockResolvedValue(false); // re-check inside the caller lock

    await expect(service.initiateCall(params)).rejects.toThrow(
      /FRIENDSHIP_REQUIRED/
    );
    expect(stubs.callRepo.create).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
  });

  it("NEGATIVE: whoCanCallMe=NO_ONE → PRIVACY_BLOCKED", async () => {
    const { service, stubs } = buildService({ whoCanCallMe: "NO_ONE" });
    await expect(service.initiateCall(params)).rejects.toThrow(
      /PRIVACY_BLOCKED/
    );
    expect(stubs.callRepo.create).not.toHaveBeenCalled();
    expect(stubs.livekit.mintToken).not.toHaveBeenCalled();
  });

  it("POSITIVE: SELECTED_FRIENDS with caller in allow-list → passes", async () => {
    const { service } = buildService({
      whoCanCallMe: "SELECTED_FRIENDS",
      allowedUserIds: ["caller"],
    });
    await expect(service.initiateCall(params)).resolves.toMatchObject({
      livekit: { url: "ws://livekit", token: "tk" },
    });
  });

  it("NEGATIVE: SELECTED_FRIENDS without caller in allow-list → PRIVACY_BLOCKED", async () => {
    const { service, stubs } = buildService({
      whoCanCallMe: "SELECTED_FRIENDS",
      allowedUserIds: ["someone-else"],
    });
    await expect(service.initiateCall(params)).rejects.toThrow(
      /PRIVACY_BLOCKED/
    );
    expect(stubs.callRepo.create).not.toHaveBeenCalled();
  });

  // `whoCanCallMe` may only NARROW the friendship rule, never widen it. EVERYONE
  // used to waive the friendship gate outright — and since it is also the column
  // DEFAULT, that waiver applied to essentially every account on the platform,
  // which is exactly how a non-friend could ring anyone.
  describe("whoCanCallMe=EVERYONE no longer waives friendship", () => {
    it("REGRESSION: a NON-FRIEND is rejected even under EVERYONE", async () => {
      const { service, stubs } = buildService({ whoCanCallMe: "EVERYONE" });
      stubs.friendshipRepo.areFriends.mockResolvedValue(false);

      await expect(service.initiateCall(params)).rejects.toThrow(
        /FRIENDSHIP_REQUIRED/
      );
      expect(stubs.callRepo.create).not.toHaveBeenCalled();
      expect(stubs.livekit.mintToken).not.toHaveBeenCalled();
      expect(stubs.redis.publish).not.toHaveBeenCalled();
    });

    it("never opens a DM room for a stranger — no room means no call", async () => {
      const { service, stubs } = buildService({ whoCanCallMe: "EVERYONE" });
      stubs.friendshipRepo.areFriends.mockResolvedValue(false);
      stubs.privateRoomRepo.findByRoomId.mockResolvedValue(null);
      stubs.privateRoomRepo.findByParticipantsKey.mockResolvedValue(null);

      await expect(
        service.initiateCall({ ...params, privateRoomId: null })
      ).rejects.toThrow(/FRIENDSHIP_REQUIRED/);
      expect(stubs.privateRoomRepo.create).not.toHaveBeenCalled();
    });

    it("POSITIVE: a FRIEND still calls normally under EVERYONE", async () => {
      const { service, stubs } = buildService({ whoCanCallMe: "EVERYONE" });
      stubs.friendshipRepo.areFriends.mockResolvedValue(true);

      await expect(service.initiateCall(params)).resolves.toBeDefined();
      expect(stubs.callRepo.create).toHaveBeenCalled();
      expect(stubs.privateRoomRepo.create).not.toHaveBeenCalled();
    });
  });

  it("REGRESSION: a non-friend is rejected under EVERY scope", async () => {
    for (const whoCanCallMe of [
      "EVERYONE",
      "FRIENDS",
      "SELECTED_FRIENDS",
    ] as const) {
      const { service, stubs } = buildService({
        whoCanCallMe,
        // Allow-listed, to prove the friendship check is what rejects here.
        allowedUserIds: ["caller"],
      });
      stubs.friendshipRepo.areFriends.mockResolvedValue(false);
      await expect(service.initiateCall(params)).rejects.toThrow(
        /FRIENDSHIP_REQUIRED/
      );
      expect(stubs.privateRoomRepo.create).not.toHaveBeenCalled();
    }
  });

  it("NEGATIVE: caller=callee → CALL_SELF_NOT_ALLOWED (never touches privacy)", async () => {
    const { service, stubs } = buildService();
    await expect(
      service.initiateCall({ ...params, calleeId: "caller" })
    ).rejects.toThrow(/CALL_SELF_NOT_ALLOWED/);
    expect(stubs.friendshipRepo.areFriends).not.toHaveBeenCalled();
    expect(stubs.getCallPrivacy).not.toHaveBeenCalled();
  });

  // Both directions. Being blocked BY the callee used to sail past this gate —
  // only the caller's own block was checked.
  it.each(["caller", "callee"])(
    "SECURITY: block gate fires when room.blockedBy contains %s",
    async (blocker) => {
      const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });
      stubs.privateRoomRepo.findByRoomId.mockResolvedValue({
        participants: ["caller", "callee"],
        blockedBy: [blocker],
      });
      await expect(service.initiateCall(params)).rejects.toThrow(
        /CALL_BLOCKED/
      );
      expect(stubs.callRepo.create).not.toHaveBeenCalled();
    }
  );
});

describe("CallService.initiateGroupCall — whoCanCallMe=NO_ONE opt-out", () => {
  /** `buildService` stubs plus a group-member repo (arg 10). */
  function buildGroupService(privacyByUser: Record<string, string>): {
    service: CallService;
    stubs: Stubs;
  } {
    const { stubs } = buildService();
    stubs.getCallPrivacy.mockImplementation(async (userId: string) => ({
      whoCanCallMe: (privacyByUser[userId] ?? "FRIENDS") as never,
      allowedUserIds: [],
    }));
    stubs.callRepo.findActiveByGroup = jest.fn().mockResolvedValue(null);
    const groupMemberRepo = {
      findActiveByRoomAndUser: jest
        .fn()
        .mockResolvedValue({ userId: "caller" }),
      findActiveMembers: jest
        .fn()
        .mockResolvedValue([
          { userId: "caller" },
          { userId: "m1" },
          { userId: "m2" },
        ]),
    };
    const service = new CallService(
      stubs.callRepo as never,
      stubs.privateRoomRepo as never,
      stubs.redis as never,
      stubs.livekit as never,
      stubs.friendshipRepo as never,
      stubs.getCallPrivacy,
      stubs.getUserSnapshot,
      undefined,
      undefined,
      groupMemberRepo as never
    );
    return { service, stubs };
  }

  const groupParams = { callerId: "caller", groupId: "grp-1", type: "AUDIO" };

  it("does not ring a member who chose NO_ONE, but rings the rest", async () => {
    const { service, stubs } = buildGroupService({ m1: "NO_ONE" });

    await service.initiateGroupCall(groupParams);

    expect(stubs.callRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ calleeIds: ["m2"] })
    );
    expect(stubs.redis.publish).not.toHaveBeenCalledWith(
      "self:m1",
      expect.anything()
    );
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "self:m2",
      expect.stringContaining("call:incoming")
    );
  });

  it("rings everyone when nobody opted out", async () => {
    const { service, stubs } = buildGroupService({});
    await service.initiateGroupCall(groupParams);
    expect(stubs.callRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ calleeIds: ["m1", "m2"] })
    );
  });

  it("EDGE: every member opted out → no call at all", async () => {
    const { service, stubs } = buildGroupService({
      m1: "NO_ONE",
      m2: "NO_ONE",
    });
    await expect(service.initiateGroupCall(groupParams)).rejects.toThrow(
      /CALL_SELF_NOT_ALLOWED/
    );
    expect(stubs.callRepo.create).not.toHaveBeenCalled();
  });

  it("FAIL-OPEN: a privacy lookup error must not silence the group call", async () => {
    const { service, stubs } = buildGroupService({});
    stubs.getCallPrivacy.mockRejectedValue(new Error("user-service down"));
    await service.initiateGroupCall(groupParams);
    expect(stubs.callRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ calleeIds: ["m1", "m2"] })
    );
  });
});

describe("CallService.initiateCall busy gate", () => {
  it("BUSY: callee already IN_PROGRESS → CALL_USER_BUSY, no call row", async () => {
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });
    stubs.callRepo.findActiveByParticipant.mockResolvedValue([
      {
        callId: "live",
        callerId: "callee",
        calleeId: "other",
        status: "IN_PROGRESS",
      },
    ]);
    await expect(service.initiateCall(params)).rejects.toThrow(
      /CALL_USER_BUSY/
    );
    expect(stubs.callRepo.create).not.toHaveBeenCalled();
    expect(stubs.livekit.mintToken).not.toHaveBeenCalled();
  });

  it("BUSY: callee has a FRESH incoming ring → CALL_USER_BUSY", async () => {
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });
    stubs.callRepo.findActiveByParticipant.mockResolvedValue([
      {
        callId: "ring",
        callerId: "someone",
        calleeId: "callee",
        status: "RINGING",
      },
    ]);
    await expect(service.initiateCall(params)).rejects.toThrow(
      /CALL_USER_BUSY/
    );
    expect(stubs.callRepo.create).not.toHaveBeenCalled();
  });

  it("ANTI-REGRESSION: STALE ringing (excluded by freshCutoff query) → NOT busy, call proceeds", async () => {
    // The freshness bound lives in the repo query; the service trusts its
    // result. A stale RINGING row is simply absent from findActiveByParticipant,
    // so the gate passes and the call is created normally.
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });
    stubs.callRepo.findActiveByParticipant.mockResolvedValue([]);
    const result = await service.initiateCall(params);
    expect(result.livekit).toEqual({ url: "ws://livekit", token: "tk" });
    expect(stubs.callRepo.create).toHaveBeenCalledTimes(1);
    // Both states must be time-bounded: RINGING by the freshness cutoff and
    // IN_PROGRESS by the max-duration cutoff. An unbounded IN_PROGRESS makes a
    // crashed call block both parties forever.
    expect(stubs.callRepo.findActiveByParticipant).toHaveBeenCalledWith(
      ["caller", "callee"],
      expect.any(Date),
      expect.any(Date)
    );
  });

  it("SELF-CLEANUP: caller's own prior ring is cancelled and does not block", async () => {
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });
    stubs.callRepo.findCallerRinging.mockResolvedValue([
      {
        callId: "old-out",
        callerId: "caller",
        calleeId: "old-callee",
        status: "RINGING",
      },
    ]);
    // After cleanup the gate sees nobody busy (default []), so the call proceeds.
    const result = await service.initiateCall(params);
    expect(result.livekit).toEqual({ url: "ws://livekit", token: "tk" });
    // Old outbound ring was transitioned RINGING → ENDED...
    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "old-out",
      "RINGING",
      expect.objectContaining({ status: "ENDED", endedBy: "caller" })
    );
    // ...and the old callee's ring was cancelled.
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "self:old-callee",
      expect.stringContaining("call:cancelled")
    );
    expect(stubs.callRepo.create).toHaveBeenCalledTimes(1);
  });

  it("GLARE: reciprocal with a SMALLER callId → this (larger) call loses, throws busy", async () => {
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });
    // Force this call's generated id to be lexicographically larger than the
    // reciprocal so it is the deterministic loser.
    stubs.callRepo.create.mockResolvedValue({
      callId: "zzz-loser",
      callerId: "caller",
      calleeId: "callee",
      status: "RINGING",
      type: "AUDIO",
    });
    stubs.callRepo.findActiveBetween.mockResolvedValue({
      callId: "aaa-winner",
      callerId: "callee",
      calleeId: "caller",
      status: "RINGING",
    });
    await expect(service.initiateCall(params)).rejects.toThrow(
      /CALL_USER_BUSY/
    );
    // Loser cancels its OWN freshly-created row...
    expect(stubs.callRepo.claimStatusTransition).toHaveBeenCalledWith(
      "zzz-loser",
      "RINGING",
      expect.objectContaining({ status: "ENDED" })
    );
    // ...and never publishes an incoming ring for it.
    expect(stubs.redis.publish).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("call:incoming")
    );
  });

  it("GLARE: reciprocal with a LARGER callId → this (smaller) call wins, proceeds", async () => {
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });
    stubs.callRepo.create.mockResolvedValue({
      callId: "aaa-winner",
      callerId: "caller",
      calleeId: "callee",
      status: "RINGING",
      type: "AUDIO",
    });
    stubs.callRepo.findActiveBetween.mockResolvedValue({
      callId: "zzz-loser",
      callerId: "callee",
      calleeId: "caller",
      status: "RINGING",
    });
    const result = await service.initiateCall(params);
    expect(result.livekit).toEqual({ url: "ws://livekit", token: "tk" });
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "self:callee",
      expect.stringContaining("call:incoming")
    );
  });
});

describe("CallService.initiateCall — platform-wide calling kill-switch", () => {
  /** Same stubs as `buildService`, plus an injectable `callFlags` (arg 9). */
  function buildWithFlags(isCallingEnabled: jest.Mock): {
    service: CallService;
    stubs: Stubs;
  } {
    const { stubs } = buildService({ whoCanCallMe: "FRIENDS" });
    const service = new CallService(
      stubs.callRepo as never,
      stubs.privateRoomRepo as never,
      stubs.redis as never,
      stubs.livekit as never,
      stubs.friendshipRepo as never,
      stubs.getCallPrivacy,
      stubs.getUserSnapshot,
      undefined,
      { isCallingEnabled } as never
    );
    return { service, stubs };
  }

  it("DISABLED: calling switched off → CALLING_DISABLED before any other gate runs", async () => {
    const { service, stubs } = buildWithFlags(
      jest.fn().mockResolvedValue(false)
    );

    await expect(service.initiateCall(params)).rejects.toThrow(
      /CALLING_DISABLED/
    );
    // Gate 0 short-circuits everything downstream — no friendship/privacy
    // lookup, no call row, no LiveKit token minted.
    expect(stubs.friendshipRepo.areFriends).not.toHaveBeenCalled();
    expect(stubs.getCallPrivacy).not.toHaveBeenCalled();
    expect(stubs.callRepo.create).not.toHaveBeenCalled();
    expect(stubs.livekit.mintToken).not.toHaveBeenCalled();
  });

  it("ENABLED: calling switched on → call proceeds normally", async () => {
    const { service, stubs } = buildWithFlags(
      jest.fn().mockResolvedValue(true)
    );

    const result = await service.initiateCall(params);

    expect(result.livekit).toEqual({ url: "ws://livekit", token: "tk" });
    expect(stubs.callRepo.create).toHaveBeenCalledTimes(1);
  });

  it("FAIL-OPEN: a flag service that resolves true on error never blocks calls", async () => {
    // CallFlagService.isCallingEnabled swallows its own errors and returns
    // true; this asserts CallService honours that contract rather than
    // treating a degraded flag lookup as "disabled".
    const { service, stubs } = buildWithFlags(
      jest.fn().mockResolvedValue(true)
    );

    await expect(service.initiateCall(params)).resolves.toMatchObject({
      livekit: { url: "ws://livekit", token: "tk" },
    });
    expect(stubs.callRepo.create).toHaveBeenCalledTimes(1);
  });

  it("BACKWARD-COMPAT: no flag service injected → calling enabled", async () => {
    // Every pre-existing call site constructs CallService without arg 9.
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });

    await expect(service.initiateCall(params)).resolves.toMatchObject({
      livekit: { url: "ws://livekit", token: "tk" },
    });
    expect(stubs.callRepo.create).toHaveBeenCalledTimes(1);
  });
});

describe("CallService.answerCall busy gate (cross-caller race)", () => {
  // Build a service + stub an existing RINGING call that can be answered.
  function buildAnswerService() {
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });

    // The call being answered — RINGING, callee = "callee".
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      callerId: "caller",
      calleeId: "callee",
      calleeIds: [],
      status: "RINGING",
      type: "AUDIO",
    });
    stubs.livekit.mintToken.mockResolvedValue({ url: "ws://lk", token: "tk" });
    stubs.callRepo.claimStatusTransition.mockResolvedValue({ won: true });
    // Default: callee has no other active call.
    stubs.callRepo.findActiveByParticipant.mockResolvedValue([]);

    return { service, stubs };
  }

  it("allows answer when callee has no other active call", async () => {
    const { service } = buildAnswerService();
    await expect(
      service.answerCall({ callId: "c1", calleeId: "callee" })
    ).resolves.toMatchObject({ livekit: { url: "ws://lk", token: "tk" } });
  });

  it("BUSY: callee already IN_PROGRESS on a DIFFERENT call → CALL_USER_BUSY", async () => {
    const { service, stubs } = buildAnswerService();
    // Simulate the cross-caller race: callee answered another call first.
    stubs.callRepo.findActiveByParticipant.mockResolvedValue([
      {
        callId: "c2", // different call — the one being answered is "c1"
        callerId: "caller2",
        calleeId: "callee",
        status: "IN_PROGRESS",
      },
    ]);

    await expect(
      service.answerCall({ callId: "c1", calleeId: "callee" })
    ).rejects.toThrow(/CALL_USER_BUSY/);
  });

  it("ANTI-REGRESSION: callee IN_PROGRESS on the SAME call → idempotent re-answer succeeds", async () => {
    // This is the reconnect / second-device case. The busy guard must skip the
    // call being answered (same id), not treat it as a blocking concurrent call.
    const { service, stubs } = buildAnswerService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      callerId: "caller",
      calleeId: "callee",
      calleeIds: [],
      status: "IN_PROGRESS", // already answered
      type: "AUDIO",
    });
    // No other active call — the findActiveByParticipant result with c1 excluded
    // is empty, so the guard passes, and the idempotent IN_PROGRESS early-return fires.
    stubs.callRepo.findActiveByParticipant.mockResolvedValue([
      {
        callId: "c1", // same call being answered — excluded by the busy guard
        callerId: "caller",
        calleeId: "callee",
        status: "IN_PROGRESS",
      },
    ]);

    await expect(
      service.answerCall({ callId: "c1", calleeId: "callee" })
    ).resolves.toMatchObject({ livekit: { url: "ws://lk", token: "tk" } });
  });

  // Answering a ring ESTABLISHES the call, so the friendship has to hold here
  // too — otherwise a ring already in flight when the relationship ended could
  // still be picked up.
  it("STALE RING: friendship ended while ringing → answer is refused", async () => {
    const { service, stubs } = buildAnswerService();
    stubs.friendshipRepo.areFriends.mockResolvedValue(false);

    await expect(
      service.answerCall({ callId: "c1", calleeId: "callee" })
    ).rejects.toThrow(/FRIENDSHIP_REQUIRED/);
    expect(stubs.callRepo.claimStatusTransition).not.toHaveBeenCalled();
  });

  // `answerCall` is a re-ENTRY point, not a teardown point: re-answering a call
  // that is already IN_PROGRESS (reconnect, retry) must stay idempotent rather
  // than start failing the moment the relationship ends. Actually ENDING such a
  // call is `endCallsBetween`'s job, driven by the friendship event — see
  // tests/calls/call-teardown-on-unfriend.test.ts.
  it("IN_PROGRESS: an established call is not refused when friendship ends", async () => {
    const { service, stubs } = buildAnswerService();
    stubs.friendshipRepo.areFriends.mockResolvedValue(false);
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c1",
      callerId: "caller",
      calleeId: "callee",
      calleeIds: [],
      status: "IN_PROGRESS",
      type: "AUDIO",
    });

    await expect(
      service.answerCall({ callId: "c1", calleeId: "callee" })
    ).resolves.toMatchObject({ livekit: { url: "ws://lk", token: "tk" } });
  });
});
