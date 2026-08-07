/**
 * Call rows must be classified from the CALL's own metadata — never from the
 * rendered text, and never as a generic SYSTEM line. Covers the two halves of
 * that contract: the shared `callType -> contentType` mapping, and the group
 * call audit row CallService writes into the GroupMessage timeline.
 */
import { callContentType } from "@aimess/constants";
import { CallService } from "../../src/services/call.service.js";
import { shouldCountInUnread } from "../../src/lib/unread-count.js";

function buildService() {
  const stubs = {
    callRepo: {
      findByCallId: jest.fn(),
      claimStatusTransition: jest.fn().mockResolvedValue({ won: true }),
      findActiveByParticipant: jest.fn().mockResolvedValue([]),
      findStuckRinging: jest.fn().mockResolvedValue([]),
      findStuckInProgress: jest.fn().mockResolvedValue([]),
      claimForMissed: jest.fn().mockResolvedValue({ won: true }),
      removeGroupCallee: jest.fn(),
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
    callFlags: { isCallingEnabled: jest.fn().mockResolvedValue(true) },
    groupMemberRepo: {
      findActiveByRoomAndUser: jest.fn(),
      findActiveMembers: jest.fn(),
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

describe("callContentType", () => {
  it("maps the call's own type, case-insensitively", () => {
    expect(callContentType("VIDEO")).toBe("VIDEO_CALL");
    expect(callContentType("video")).toBe("VIDEO_CALL");
    expect(callContentType("AUDIO")).toBe("VOICE_CALL");
  });

  it("falls back to VOICE_CALL for an absent/unknown type (CallType.AUDIO default)", () => {
    expect(callContentType("")).toBe("VOICE_CALL");
    expect(callContentType(null)).toBe("VOICE_CALL");
    expect(callContentType(undefined)).toBe("VOICE_CALL");
  });
});

describe("shouldCountInUnread with call rows", () => {
  it("excludes a terminal call audit row even though its kind is not SYSTEM", () => {
    expect(
      shouldCountInUnread({
        messageType: "VOICE_CALL",
        systemEvent: "CALL_ENDED",
      })
    ).toBe(false);
    expect(
      shouldCountInUnread({
        messageType: "VIDEO_CALL",
        systemEvent: "CALL_ENDED",
      })
    ).toBe(false);
  });

  it("counts a MISSED call row via the explicit override, despite its systemEvent", () => {
    // Call rows are lifecycle rows and carry a systemEvent for their whole life,
    // so the ONLY thing that badges a missed call is the explicit flag
    // CallChatMessageService sets on the MISSED transition.
    expect(
      shouldCountInUnread({
        messageType: "VOICE_CALL",
        systemEvent: "CALL_ENDED",
        explicit: true,
      })
    ).toBe(true);
  });

  it("leaves ordinary messages and plain SYSTEM lines untouched", () => {
    expect(shouldCountInUnread({ messageType: "TEXT" })).toBe(true);
    expect(shouldCountInUnread({ messageType: "IMAGE" })).toBe(true);
    expect(
      shouldCountInUnread({
        messageType: "SYSTEM",
        systemEvent: "MEMBER_JOINED",
      })
    ).toBe(false);
  });
});

describe("CallService group call timeline row", () => {
  const groupCall = {
    callId: "gc-1",
    callerId: "u1",
    calleeId: "",
    calleeIds: ["u2", "u3"],
    groupId: "grp-1",
    privateRoomId: null,
    type: "VIDEO",
    status: "IN_PROGRESS",
    answeredAt: new Date(1_000_000 - 5_000),
  };

  it("posts a VIDEO_CALL row (not SYSTEM) with structured call metadata on end", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(groupCall);

    await service.endCall({ callId: "gc-1", userId: "u1" });

    expect(stubs.callChatMessages.post).not.toHaveBeenCalled();
    expect(stubs.groupSystemMessages.postOrUpdateCall).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "grp-1",
        actorId: null,
        systemEvent: "CALL_ENDED",
        messageType: "VIDEO_CALL",
        systemData: expect.objectContaining({
          callId: "gc-1",
          callType: "VIDEO",
          status: "ENDED",
          callerId: "u1",
        }),
        // This sub-object must match the one CallChatMessageService writes on a
        // 1:1 row: clients read the call card's state from
        // `content.call.callStatus` on both surfaces (`outcome` is the legacy
        // alias kept for pre-lifecycle clients).
        contentExtra: expect.objectContaining({
          call: expect.objectContaining({
            callId: "gc-1",
            callType: "VIDEO",
            callStatus: "ENDED",
            outcome: "ENDED",
          }),
        }),
      })
    );
  });

  it("posts a VOICE_CALL row when the last rung member declines, not one per member", async () => {
    const { service, stubs } = buildService();
    const ringing = { ...groupCall, type: "AUDIO", status: "RINGING" };
    stubs.callRepo.findByCallId.mockResolvedValue(ringing);
    // First decline leaves one member still ringing → no timeline row yet.
    stubs.callRepo.removeGroupCallee.mockResolvedValueOnce({
      ...ringing,
      calleeIds: ["u3"],
    });

    await service.declineCall({ callId: "gc-1", calleeId: "u2" });
    expect(stubs.groupSystemMessages.postOrUpdateCall).not.toHaveBeenCalled();

    stubs.callRepo.removeGroupCallee.mockResolvedValueOnce({
      ...ringing,
      calleeIds: [],
    });
    await service.declineCall({ callId: "gc-1", calleeId: "u3" });

    expect(stubs.groupSystemMessages.postOrUpdateCall).toHaveBeenCalledTimes(1);
    expect(stubs.groupSystemMessages.postOrUpdateCall).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: "VOICE_CALL",
        systemEvent: "CALL_ENDED",
        systemData: expect.objectContaining({ status: "DECLINED" }),
      })
    );
  });

  it("posts a VOICE_CALL row for a group call swept to MISSED", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findStuckRinging.mockResolvedValue([
      { ...groupCall, type: "AUDIO", status: "RINGING", answeredAt: null },
    ]);

    await service.sweepMissedCalls(new Date(1_000_000), 60, 50);

    expect(stubs.groupSystemMessages.postOrUpdateCall).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "grp-1",
        messageType: "VOICE_CALL",
        systemData: expect.objectContaining({ status: "MISSED" }),
      })
    );
  });

  it("keeps 1:1 calls on the private writer and never touches the group one", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      callId: "c-1",
      callerId: "u1",
      calleeId: "u2",
      calleeIds: [],
      groupId: null,
      privateRoomId: "r1",
      type: "AUDIO",
      status: "IN_PROGRESS",
      answeredAt: new Date(1_000_000 - 5_000),
    });

    await service.endCall({ callId: "c-1", userId: "u1" });

    expect(stubs.groupSystemMessages.postOrUpdateCall).not.toHaveBeenCalled();
    expect(stubs.callChatMessages.post).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "c-1", outcome: "ENDED" })
    );
  });
});
