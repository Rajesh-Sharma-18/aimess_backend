/**
 * GROUP twin of the 1:1 call-card contract: ONE CALL === ONE ROW. The first
 * state inserts (message:new), every later state rewrites that same row
 * (message:edited, same id / seq / timestamp), and a terminal row is never
 * rewritten by a late duplicate.
 */
import { GroupSystemMessageService } from "../../src/services/group-system-message.service.js";

const CREATED_AT = new Date("2026-08-07T09:00:00.000Z");

function buildService() {
  const stubs = {
    messageRepo: {
      findByClientMessageId: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (data) => ({
        id: "msg-1",
        ...data,
        senderId: data.senderId ?? null,
        createdAt: CREATED_AT,
      })),
      updateCallState: jest.fn().mockImplementation(async (data) => ({
        id: data.messageId,
        ...data,
        createdAt: CREATED_AT,
      })),
    },
    roomRepo: {
      allocateSequence: jest.fn().mockResolvedValue(4),
      updateLastMessage: jest.fn().mockResolvedValue({}),
      findByRoomId: jest
        .fn()
        .mockResolvedValue({ roomId: "grp-1", lastMessageId: "msg-1" }),
    },
    memberRepo: {
      incUnreadForRoom: jest.fn().mockResolvedValue({}),
      findActiveMembers: jest
        .fn()
        .mockResolvedValue([{ userId: "u1" }, { userId: "u2" }]),
    },
    cacheRepo: {},
    userSnapshotService: {
      getUserSnapshotsMap: jest.fn().mockResolvedValue(new Map()),
    },
    redis: { publish: jest.fn().mockResolvedValue(1) },
  };
  const service = new GroupSystemMessageService(
    stubs.messageRepo as never,
    stubs.roomRepo as never,
    stubs.memberRepo as never,
    stubs.cacheRepo as never,
    stubs.userSnapshotService as never,
    stubs.redis as never
  );
  return { service, stubs };
}

const call = (status: string, durationSec = 0) => ({
  callId: "gc-1",
  roomId: "grp-1",
  actorId: null,
  systemEvent: (status === "RINGING" || status === "ANSWERED"
    ? "CALL_STARTED"
    : "CALL_ENDED") as never,
  messageType: "VOICE_CALL",
  systemData: { callId: "gc-1", callType: "AUDIO", status, durationSec },
  contentExtra: {
    call: {
      callId: "gc-1",
      callType: "AUDIO",
      callStatus: status,
      durationSec,
    },
  },
});

/** An already-persisted group call row sitting in `status`. */
const existingRow = (status: string) => ({
  id: "msg-1",
  roomId: "grp-1",
  sequenceNumber: 4,
  createdAt: CREATED_AT,
  content: { call: { callStatus: status } },
});

describe("GroupSystemMessageService.postOrUpdateCall", () => {
  it("inserts the ringing card keyed on call:<callId>", async () => {
    const { service, stubs } = buildService();

    await service.postOrUpdateCall(call("RINGING"));

    expect(stubs.messageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "grp-1",
        messageType: "VOICE_CALL",
        systemEvent: "CALL_STARTED",
        clientMessageId: "call:gc-1",
      })
    );
    const payload = JSON.parse(stubs.redis.publish.mock.calls[0]![1]);
    expect(payload.event).toBe("message:new");
    // Sender-less lifecycle row — never "Someone updated the group".
    expect(payload.data.content.text).toBe("Voice call ringing");
  });

  it("rewrites the SAME row on end and fans out message:edited", async () => {
    const { service, stubs } = buildService();
    stubs.messageRepo.findByClientMessageId.mockResolvedValue(
      existingRow("ANSWERED")
    );

    await service.postOrUpdateCall(call("ENDED", 125));

    expect(stubs.messageRepo.create).not.toHaveBeenCalled();
    expect(stubs.messageRepo.updateCallState).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-1",
        messageType: "VOICE_CALL",
        systemEvent: "CALL_ENDED",
        countInUnread: false,
      })
    );
    const payload = JSON.parse(stubs.redis.publish.mock.calls[0]![1]);
    expect(payload).toMatchObject({
      event: "message:edited",
      data: {
        id: "msg-1",
        contentType: "VOICE_CALL",
        // Original ring time and slot — the card does not jump.
        serverTs: CREATED_AT.getTime(),
        sequenceNumber: 4,
      },
    });
    expect(payload.data.content.text).toBe("Voice call lasted 02:05");
  });

  it("refuses to rewrite a terminal row (late racing webhook)", async () => {
    const { service, stubs } = buildService();
    stubs.messageRepo.findByClientMessageId.mockResolvedValue(
      existingRow("DECLINED")
    );

    await service.postOrUpdateCall(call("CANCELLED"));

    expect(stubs.messageRepo.updateCallState).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
  });

  it("does not rewind the inbox when a real message landed mid-call", async () => {
    const { service, stubs } = buildService();
    stubs.messageRepo.findByClientMessageId.mockResolvedValue(
      existingRow("RINGING")
    );
    stubs.roomRepo.findByRoomId.mockResolvedValue({
      roomId: "grp-1",
      lastMessageId: "some-newer-message",
    });

    await service.postOrUpdateCall(call("MISSED"));

    expect(stubs.messageRepo.updateCallState).toHaveBeenCalled();
    expect(stubs.roomRepo.updateLastMessage).not.toHaveBeenCalled();
  });
});
