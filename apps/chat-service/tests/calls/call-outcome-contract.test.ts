/** Contract §9 call outcomes at the service layer. */
import { CallService } from "../../src/services/call.service.js";
import { publishCallActivitySafe } from "../../src/events/publish-call-incoming.js";
import { withLocalizedSystemPreview } from "../../src/lib/localize-system-preview.js";

jest.mock("../../src/events/publish-call-incoming.js", () => ({
  publishCallIncomingSafe: jest.fn(),
  publishCallMissedSafe: jest.fn(),
  publishCallCancelSafe: jest.fn(),
  publishCallHandledPushSafe: jest.fn(),
  publishCallActivitySafe: jest.fn(),
}));

const activity = publishCallActivitySafe as jest.Mock;

function buildService() {
  const stubs = {
    callRepo: {
      create: jest.fn(),
      findByCallId: jest.fn(),
      findCallerRinging: jest.fn().mockResolvedValue([]),
      findActiveByParticipant: jest.fn().mockResolvedValue([]),
      findActiveBetween: jest.fn().mockResolvedValue(null),
      findAllActiveBetween: jest.fn().mockResolvedValue([]),
      claimStatusTransition: jest.fn().mockResolvedValue({ won: true }),
      claimForMissed: jest.fn().mockResolvedValue({ won: true }),
      removeGroupCallee: jest.fn(),
    },
    privateRoomRepo: {
      findByRoomId: jest.fn().mockResolvedValue({
        roomId: "room-1",
        participants: ["caller", "callee"],
        blockedBy: [],
      }),
      findByParticipantsKey: jest.fn(),
      create: jest.fn(),
    },
    redis: {
      publish: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue("OK"),
      get: jest.fn(),
      del: jest.fn(),
      eval: jest.fn().mockResolvedValue(1),
    },
    livekit: { mintToken: jest.fn(), deleteRoom: jest.fn().mockResolvedValue(undefined) },
    friendshipRepo: {
      areFriends: jest.fn().mockResolvedValue(true),
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      findFriendship: jest.fn(),
    },
    callChatMessages: { post: jest.fn().mockResolvedValue(null) },
    groupSystemMessages: { postOrUpdateCall: jest.fn().mockResolvedValue(undefined) },
  };
  const service = new CallService(
    stubs.callRepo as never,
    stubs.privateRoomRepo as never,
    stubs.redis as never,
    stubs.livekit as never,
    stubs.friendshipRepo as never,
    jest.fn().mockResolvedValue({ whoCanCallMe: "EVERYONE", allowedUserIds: [] }),
    jest.fn().mockResolvedValue({ displayName: "Peter", avatarUrl: "" }),
    stubs.callChatMessages as never,
    { isCallingEnabled: jest.fn().mockResolvedValue(true) } as never,
    { findActiveByRoomAndUser: jest.fn().mockResolvedValue({ role: "MEMBER" }), findActiveMembers: jest.fn().mockResolvedValue([]) } as never,
    stubs.groupSystemMessages as never
  );
  return { service, stubs };
}

const ringing = {
  callId: "call-1",
  callerId: "caller",
  calleeId: "callee",
  calleeIds: [],
  groupId: null,
  privateRoomId: "room-1",
  type: "AUDIO",
  status: "RINGING",
  answeredAt: null,
  durationSec: 0,
  initiatedAt: new Date(Date.now() - 5000),
};

beforeEach(() => activity.mockClear());

describe("busy callee", () => {
  it("projects a BUSY call-history row (the consumer pushes it as missed)", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findActiveByParticipant.mockResolvedValue([
      { callId: "live", callerId: "callee", calleeId: "other", status: "IN_PROGRESS" },
    ]);
    await expect(
      service.initiateCall({ callerId: "caller", calleeId: "callee", type: "AUDIO", privateRoomId: "room-1" })
    ).rejects.toThrow(/CALL_USER_BUSY/);
    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "BUSY", endReason: "busy" })
    );
    expect(activity).toHaveBeenCalledTimes(1);
    expect(activity.mock.calls[0][0]).toMatchObject({
      callerId: "caller",
      calleeId: "callee",
      status: "BUSY",
      endReason: "busy",
    });
  });
});

describe("callee rejecting", () => {
  it("ending the ring as callee projects endReason declined", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringing);
    await service.endCall({ callId: "call-1", userId: "callee" });
    expect(activity.mock.calls[0][0]).toMatchObject({ status: "CANCELLED", endReason: "declined" });
  });

  it("declineCall projects DECLINED without a session to exclude (no push follows)", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringing);
    await service.declineCall({ callId: "call-1", calleeId: "callee", sessionId: "s1" });
    expect(activity.mock.calls[0][0]).toMatchObject({ status: "DECLINED" });
    expect(activity.mock.calls[0][0].excludeSessionId).toBeUndefined();
  });
});

describe("group decliners", () => {
  it("the final group card carries every member who declined", async () => {
    const { service, stubs } = buildService();
    const group = { ...ringing, calleeId: "", calleeIds: ["m1"], groupId: "g1", privateRoomId: null };
    stubs.callRepo.findByCallId.mockResolvedValue(group);
    stubs.callRepo.removeGroupCallee.mockResolvedValue({ ...group, calleeIds: [], declinedBy: ["m2", "m1"] });
    await service.declineCall({ callId: "call-1", calleeId: "m1" });
    const card = stubs.groupSystemMessages.postOrUpdateCall.mock.calls.at(-1)[0];
    expect(card.systemData).toMatchObject({ status: "DECLINED", declinedBy: ["m2", "m1"] });
    expect(card.contentExtra.call.declinedBy).toEqual(["m2", "m1"]);
    expect(activity).not.toHaveBeenCalled();
  });
});

describe("REST inbox call preview", () => {
  const preview = {
    messageType: "VOICE_CALL",
    systemEvent: "CALL_ENDED",
    systemData: { callType: "AUDIO", status: "BUSY", callerId: "caller", endReason: "busy" },
    content: { text: "Voice call was not answered" },
  };
  it("is per viewer in English and localized", () => {
    expect(withLocalizedSystemPreview(preview, "PRIVATE", "caller", "en")?.content).toMatchObject({ text: "No answer" });
    expect(withLocalizedSystemPreview(preview, "PRIVATE", "callee", "en")?.content).toMatchObject({ text: "Missed voice call" });
    expect(withLocalizedSystemPreview(preview, "PRIVATE", "callee", "th")?.content).toMatchObject({ text: "สายสนทนาที่ไม่ได้รับ" });
    expect(withLocalizedSystemPreview(preview, "PRIVATE", "caller", "vi")?.content).toMatchObject({ text: "Không trả lời" });
  });
});
