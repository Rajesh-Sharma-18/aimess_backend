/**
 * AIMESS-43: every settled 1:1 card carries the spec's `endReason`, so all
 * clients render the same caller/callee perspective from one field.
 */
import {
  buildCallListPreviewText,
  normalizeCallEndReason,
  resolveCallEndReason,
} from "@aimess/constants";
import { CallStatus } from "../../src/types/enums.js";
import { CallService } from "../../src/services/call.service.js";

jest.mock("../../src/events/publish-call-incoming.js", () => ({
  publishCallIncomingSafe: jest.fn(),
  publishCallMissedSafe: jest.fn(),
  publishCallCancelSafe: jest.fn(),
  publishCallHandledPushSafe: jest.fn(),
  publishCallActivitySafe: jest.fn(),
}));

const CALLER = "caller-1";
const CALLEE = "callee-1";

function buildService() {
  const stubs = {
    callRepo: {
      findByCallId: jest.fn(),
      claimStatusTransition: jest.fn().mockResolvedValue({ won: true }),
      claimForMissed: jest.fn().mockResolvedValue({ won: true }),
    },
    redis: { publish: jest.fn().mockResolvedValue(1), set: jest.fn(), get: jest.fn(), del: jest.fn() },
    livekit: { deleteRoom: jest.fn().mockResolvedValue(undefined) },
    callChatMessages: { post: jest.fn().mockResolvedValue(null) },
  };
  const service = new CallService(
    stubs.callRepo as never,
    { findByRoomId: jest.fn() } as never,
    stubs.redis as never,
    stubs.livekit as never,
    { findFriendship: jest.fn() } as never,
    jest.fn().mockResolvedValue({ whoCanCallMe: "EVERYONE" }),
    jest.fn().mockResolvedValue({ displayName: "Peter", avatarUrl: "" }),
    stubs.callChatMessages as never,
    { isCallingEnabled: jest.fn().mockResolvedValue(true) } as never,
    { findActiveByRoomAndUser: jest.fn(), findActiveMembers: jest.fn().mockResolvedValue([]) } as never,
    { postOrUpdateCall: jest.fn() } as never
  );
  return { service, stubs };
}

const ringing = (ringSec: number) => ({
  callId: "call-1",
  callerId: CALLER,
  calleeId: CALLEE,
  calleeIds: [],
  groupId: null,
  privateRoomId: "room-1",
  type: "AUDIO",
  status: CallStatus.RINGING,
  answeredAt: null,
  durationSec: 0,
  initiatedAt: new Date(Date.now() - ringSec * 1000),
});

const lastCard = (stubs: ReturnType<typeof buildService>["stubs"]) =>
  stubs.callChatMessages.post.mock.calls.at(-1)?.[0] as {
    outcome: string;
    endReason?: string;
  };

describe("endReason on the settled card", () => {
  it("caller hanging up a short ring is canceled", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringing(3));
    await service.endCall({ callId: "call-1", userId: CALLER });
    expect(lastCard(stubs).endReason).toBe("canceled");
  });

  it("caller ring timeout is no_answer", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringing(60));
    await service.endCall({ callId: "call-1", userId: CALLER, reason: "NO_ANSWER" });
    expect(lastCard(stubs)).toMatchObject({ outcome: "MISSED", endReason: "no_answer" });
  });

  it("callee hanging up the ring is declined", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringing(5));
    await service.endCall({ callId: "call-1", userId: CALLEE });
    expect(lastCard(stubs).endReason).toBe("declined");
  });

  it("media failure while ringing is failed and still a missed ring for the callee", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue(ringing(5));
    await service.endCall({ callId: "call-1", userId: CALLER, reason: "FAILED" });
    expect(lastCard(stubs)).toMatchObject({ outcome: "MISSED", endReason: "failed" });
  });

  it("failure after a connected call with duration reads completed", async () => {
    const { service, stubs } = buildService();
    stubs.callRepo.findByCallId.mockResolvedValue({
      ...ringing(10),
      status: CallStatus.IN_PROGRESS,
      answeredAt: new Date(Date.now() - 30_000),
    });
    await service.endCall({ callId: "call-1", userId: CALLER, reason: "FAILED" });
    expect(lastCard(stubs)).toMatchObject({ outcome: "ENDED", endReason: "completed" });
  });
});

describe("constants", () => {
  it("resolves the status-derived reason", () => {
    expect(resolveCallEndReason({ status: "RINGING" })).toBeNull();
    expect(resolveCallEndReason({ status: "ENDED", durationSec: 5 })).toBe("completed");
    expect(resolveCallEndReason({ status: "ENDED", durationSec: 0 })).toBe("failed");
    expect(resolveCallEndReason({ status: "ENDED", durationSec: 9, endedBy: "SYSTEM_LIVEKIT" })).toBe("dropped");
    expect(resolveCallEndReason({ status: "BUSY" })).toBe("busy");
  });

  it("normalizes dropped by duration", () => {
    expect(normalizeCallEndReason("dropped", 1)).toBe("completed");
    expect(normalizeCallEndReason("dropped", 0)).toBe("failed");
  });

  it("list preview is per viewer and never shows duration", () => {
    const base = { callType: "AUDIO", durationSec: 0, locale: "en" as const };
    expect(buildCallListPreviewText({ ...base, endReason: "declined", viewerIsCaller: true })).toBe("Voice call");
    expect(buildCallListPreviewText({ ...base, endReason: "declined", viewerIsCaller: false })).toBe("Missed voice call");
    expect(buildCallListPreviewText({ ...base, callType: "VIDEO", endReason: "completed", durationSec: 90, viewerIsCaller: false })).toBe("Video call");
  });
});
