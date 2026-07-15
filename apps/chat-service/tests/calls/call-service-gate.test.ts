/**
 * Unit tests — CallService.initiateCall friendship + whoCanCallMe gate.
 * See Docs/calls/CALLS-LIVEKIT.md §7 Phase 2.
 *
 * Direct service tests (no gRPC, no Express) — stubs LiveKit, friendship repo,
 * privacy lookup, and the room+call repos.
 */
import { CallService } from "../../src/services/call.service.js";
import type { CallPrivacy } from "../../src/grpc/user-snapshot.client.js";

type Redis = { publish: jest.Mock };

interface Stubs {
  callRepo: {
    create: jest.Mock;
    findByCallId: jest.Mock;
    updateStatus: jest.Mock;
    findByParticipant: jest.Mock;
  };
  privateRoomRepo: {
    findByRoomId: jest.Mock;
    findByParticipantsKey: jest.Mock;
  };
  redis: Redis;
  livekit: { mintToken: jest.Mock };
  friendshipRepo: { areFriends: jest.Mock };
  getCallPrivacy: jest.Mock<Promise<CallPrivacy>, [string]>;
  getUserSnapshot: jest.Mock<
    Promise<{ displayName: string; avatarUrl: string }>,
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
    },
    redis: { publish: jest.fn().mockResolvedValue(1) },
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
    // Callee gets their token via user:<calleeId> channel.
    expect(stubs.redis.publish).toHaveBeenCalledWith(
      "user:callee",
      expect.stringContaining("call:incoming")
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
    expect(stubs.getCallPrivacy).not.toHaveBeenCalled();
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

  it("NEGATIVE: caller=callee → CALL_SELF_NOT_ALLOWED (never touches privacy)", async () => {
    const { service, stubs } = buildService();
    await expect(
      service.initiateCall({ ...params, calleeId: "caller" })
    ).rejects.toThrow(/CALL_SELF_NOT_ALLOWED/);
    expect(stubs.friendshipRepo.areFriends).not.toHaveBeenCalled();
    expect(stubs.getCallPrivacy).not.toHaveBeenCalled();
  });

  it("SECURITY: existing block gate still fires when room.blockedBy contains caller", async () => {
    const { service, stubs } = buildService({ whoCanCallMe: "FRIENDS" });
    stubs.privateRoomRepo.findByRoomId.mockResolvedValue({
      participants: ["caller", "callee"],
      blockedBy: ["caller"],
    });
    await expect(service.initiateCall(params)).rejects.toThrow(/CALL_BLOCKED/);
    expect(stubs.callRepo.create).not.toHaveBeenCalled();
  });
});
