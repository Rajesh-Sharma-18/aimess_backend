/**
 * Call activity in the Notification Center (Notifications → Friends).
 *
 * Three contracts, one per layer:
 *   1. PRESENTATION — `buildCallActivityText` maps the canonical
 *      CallTimelineStatus + the reader's direction to the line they see. No
 *      second call-state enum, no fabricated duration.
 *   2. ROUTING — a `call.*` row belongs to FRIENDS (and therefore ALL), and
 *      never to COMMUNITIES or SYSTEM.
 *   3. PROJECTION — CallService publishes exactly one `call.activity` event per
 *      TERMINAL transition of a PRIVATE call, carrying the call row's own
 *      status/type/duration. Never while ringing, never for a group call.
 */
import {
  buildCallActivityText,
  formatCallDuration,
  isUnreadCallActivity,
} from "@aimess/constants";

import {
  categorize,
  categoryWhere,
} from "../../src/lib/notification-category.js";
import { CallService } from "../../src/services/call.service.js";
import { publishCallActivitySafe } from "../../src/events/publish-call-incoming.js";

jest.mock("../../src/events/publish-call-incoming.js", () => ({
  publishCallIncomingSafe: jest.fn(),
  publishCallMissedSafe: jest.fn(),
  publishCallCancelSafe: jest.fn(),
  publishCallHandledPushSafe: jest.fn(),
  publishCallActivitySafe: jest.fn(),
}));

const publishActivity = publishCallActivitySafe as jest.Mock;

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
    privateRoomRepo: { findByRoomId: jest.fn() },
    redis: {
      publish: jest.fn().mockResolvedValue(1),
      set: jest.fn(),
      del: jest.fn(),
    },
    livekit: { deleteRoom: jest.fn().mockResolvedValue(undefined) },
    friendshipRepo: { findFriendship: jest.fn() },
    getCallPrivacy: jest.fn().mockResolvedValue({ whoCanCallMe: "EVERYONE" }),
    getUserSnapshot: jest.fn().mockImplementation((userId: string) =>
      Promise.resolve({
        displayName: `name-${userId}`,
        avatarUrl: `a-${userId}`,
      })
    ),
    callChatMessages: { post: jest.fn().mockResolvedValue(null) },
    callFlags: { isCallingEnabled: jest.fn().mockResolvedValue(true) },
    groupMemberRepo: {
      findActiveByRoomAndUser: jest.fn(),
      findActiveMembers: jest.fn().mockResolvedValue([]),
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

const privateCall = {
  callId: "c-1",
  callerId: "caller",
  calleeId: "callee",
  calleeIds: [],
  groupId: null,
  privateRoomId: "room-1",
  type: "AUDIO",
  status: "IN_PROGRESS",
  answeredAt: new Date(1_000_000 - 300_000),
};

beforeEach(() => publishActivity.mockClear());

describe("buildCallActivityText", () => {
  const voice = { callType: "AUDIO" as const };
  const video = { callType: "VIDEO" as const };

  it("renders an unanswered ring as MISSED for the callee and OUTGOING for the caller", () => {
    expect(
      buildCallActivityText({
        ...voice,
        status: "MISSED",
        direction: "INCOMING",
      })
    ).toBe("Missed voice call");
    expect(
      buildCallActivityText({
        ...video,
        status: "MISSED",
        direction: "INCOMING",
      })
    ).toBe("Missed video call");
    expect(
      buildCallActivityText({
        ...voice,
        status: "MISSED",
        direction: "OUTGOING",
      })
    ).toBe("Outgoing voice call");
  });

  it("renders a caller-abandoned ring as CANCELLED outgoing and MISSED incoming", () => {
    expect(
      buildCallActivityText({
        ...voice,
        status: "CANCELLED",
        direction: "OUTGOING",
      })
    ).toBe("Cancelled voice call");
    // The callee cannot tell a timeout from a caller hang-up — both are missed.
    expect(
      buildCallActivityText({
        ...video,
        status: "CANCELLED",
        direction: "INCOMING",
      })
    ).toBe("Missed video call");
  });

  it("renders a live ring by direction", () => {
    expect(
      buildCallActivityText({
        ...voice,
        status: "RINGING",
        direction: "INCOMING",
      })
    ).toBe("Incoming voice call");
    expect(
      buildCallActivityText({
        ...video,
        status: "RINGING",
        direction: "OUTGOING",
      })
    ).toBe("Outgoing video call");
  });

  it("renders declined and failed the same for both sides — they describe the call", () => {
    for (const direction of ["INCOMING", "OUTGOING"] as const) {
      expect(
        buildCallActivityText({ ...voice, status: "DECLINED", direction })
      ).toBe("Declined voice call");
      expect(
        buildCallActivityText({ ...video, status: "FAILED", direction })
      ).toBe("Failed video call");
    }
  });

  it("shows the canonical duration for a completed call", () => {
    expect(
      buildCallActivityText({
        ...voice,
        status: "ENDED",
        direction: "OUTGOING",
        durationSec: 734,
      })
    ).toBe(`Voice call • ${formatCallDuration(734)}`);
    expect(
      buildCallActivityText({
        ...video,
        status: "ENDED",
        direction: "INCOMING",
        durationSec: 65,
      })
    ).toBe("Video call • 01:05");
  });

  it("never invents a duration when none was recorded", () => {
    expect(
      buildCallActivityText({
        ...voice,
        status: "ENDED",
        direction: "INCOMING",
      })
    ).toBe("Voice call");
    expect(
      buildCallActivityText({
        ...video,
        status: "ENDED",
        direction: "INCOMING",
        durationSec: 0,
      })
    ).toBe("Video call");
  });

  it("localizes per reader — the stored English line is only a fallback", () => {
    expect(
      buildCallActivityText({
        ...voice,
        status: "MISSED",
        direction: "INCOMING",
        locale: "vi",
      })
    ).toBe("Cuộc gọi thoại nhỡ");
  });
});

describe("isUnreadCallActivity", () => {
  it("badges only a call the reader never answered", () => {
    expect(isUnreadCallActivity("MISSED", "INCOMING")).toBe(true);
    expect(isUnreadCallActivity("CANCELLED", "INCOMING")).toBe(true);
    expect(isUnreadCallActivity("DECLINED", "INCOMING")).toBe(true);
    expect(isUnreadCallActivity("ENDED", "INCOMING")).toBe(false);
    expect(isUnreadCallActivity("FAILED", "INCOMING")).toBe(false);
  });

  it("never badges your own outgoing call", () => {
    for (const status of [
      "MISSED",
      "CANCELLED",
      "ENDED",
      "DECLINED",
      "FAILED",
    ]) {
      expect(isUnreadCallActivity(status, "OUTGOING")).toBe(false);
    }
  });
});

describe("notification tab routing for call rows", () => {
  it("routes call activity to FRIENDS, including the legacy CALL_MISSED type", () => {
    expect(categorize("call.activity")).toBe("FRIENDS");
    expect(categorize("CALL_MISSED")).toBe("FRIENDS");
  });

  it("selects call rows in the FRIENDS filter and nowhere else", () => {
    const friends = JSON.stringify(categoryWhere("FRIENDS"));
    expect(friends).toContain("call.");
    expect(JSON.stringify(categoryWhere("COMMUNITIES"))).not.toContain("call.");
    expect(JSON.stringify(categoryWhere("MENTIONS"))).not.toContain("call.");
    expect(JSON.stringify(categoryWhere("SYSTEM"))).not.toContain("call.");
  });

  it("leaves ALL unrestricted, so a call row appears there too", () => {
    expect(categoryWhere("ALL")).toEqual({});
  });
});

describe("CallService call-activity projection", () => {
  it("publishes once per terminal transition with the call's own status and duration", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(privateCall);

    await service.endCall({ callId: "c-1", userId: "caller" });

    expect(publishActivity).toHaveBeenCalledTimes(1);
    expect(publishActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "c-1",
        callerId: "caller",
        calleeId: "callee",
        callType: "AUDIO",
        status: "ENDED",
        privateRoomId: "room-1",
        callerName: "name-caller",
        calleeName: "name-callee",
      })
    );
    expect(publishActivity.mock.calls[0][0].durationSec).toBeGreaterThan(0);
  });

  it("publishes a MISSED projection when the sweep reaps an unanswered ring", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findStuckRinging.mockResolvedValue([
      { ...privateCall, status: "RINGING", answeredAt: null },
    ]);

    await service.sweepMissedCalls(new Date(1_000_000), 60, 50);

    expect(publishActivity).toHaveBeenCalledTimes(1);
    expect(publishActivity).toHaveBeenCalledWith(
      expect.objectContaining({ status: "MISSED", durationSec: 0 })
    );
  });

  it("publishes a DECLINED projection when the callee rejects the call", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      ...privateCall,
      status: "RINGING",
      answeredAt: null,
    });

    await service.declineCall({ callId: "c-1", calleeId: "callee" });

    expect(publishActivity).toHaveBeenCalledWith(
      expect.objectContaining({ status: "DECLINED", durationSec: 0 })
    );
  });

  it("never projects a group call into friend activity", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      ...privateCall,
      groupId: "grp-1",
      calleeId: "",
      calleeIds: ["u2"],
      privateRoomId: null,
    });

    await service.endCall({ callId: "c-1", userId: "caller" });

    expect(publishActivity).not.toHaveBeenCalled();
    expect(stubs.groupSystemMessages.postOrUpdateCall).toHaveBeenCalled();
  });
});
