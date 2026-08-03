import { CallChatMessageService } from "../../src/services/call-chat-message.service.js";

function buildService() {
  const now = new Date("2026-07-15T10:00:00.000Z");
  const pipeline = {
    publish: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };
  const stubs = {
    messageRepo: {
      findByClientMessageId: jest.fn().mockResolvedValue(null),
      createMessage: jest.fn().mockImplementation(async (data) => ({
        id: "message-1",
        ...data,
        createdAt: data.createdAt ?? now,
      })),
    },
    roomRepo: {
      findByRoomId: jest.fn().mockResolvedValue({
        roomId: "room-1",
        participants: ["caller", "callee"],
      }),
      findByParticipantsKey: jest.fn().mockResolvedValue({
        roomId: "room-1",
        participants: ["caller", "callee"],
      }),
      allocateSequence: jest.fn().mockResolvedValue(7),
      updateRoomOnNewMessage: jest.fn().mockResolvedValue({}),
    },
    redis: {
      publish: jest.fn().mockResolvedValue(1),
      pipeline: jest.fn(() => pipeline),
    },
    getUserSnapshot: jest
      .fn()
      .mockResolvedValue({ displayName: "Caller", avatarUrl: "" }),
  };
  const service = new CallChatMessageService(
    stubs.messageRepo as never,
    stubs.roomRepo as never,
    stubs.redis as never,
    stubs.getUserSnapshot
  );
  return { service, stubs, pipeline, now };
}

const base = {
  callId: "call-1",
  callerId: "caller",
  calleeId: "callee",
  privateRoomId: "room-1",
  callType: "AUDIO",
  endedAt: new Date("2026-07-15T10:00:00.000Z"),
  endedBy: "caller",
};

describe("CallChatMessageService", () => {
  it("persists a completed call as a non-unread SYSTEM duration audit row", async () => {
    const { service, stubs } = buildService();

    await service.post({
      ...base,
      outcome: "ENDED",
      durationSec: 125,
    });

    expect(stubs.messageRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room-1",
        senderId: "",
        receiverId: "callee",
        messageType: "SYSTEM",
        systemEvent: "CALL_ENDED",
        systemData: expect.objectContaining({
          callId: "call-1",
          durationSec: 125,
        }),
        countInUnread: false,
        clientMessageId: "call:call-1:ended",
        sequenceNumber: 7,
        content: expect.objectContaining({ text: "Voice call lasted 02:05" }),
      })
    );
    expect(stubs.roomRepo.updateRoomOnNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({ unreadIncrement: 0 })
    );
    const livePayload = JSON.parse(stubs.redis.publish.mock.calls[0]![1]);
    expect(livePayload).toMatchObject({
      event: "message:new",
      data: {
        contentType: "SYSTEM",
        systemEvent: "CALL_ENDED",
        countInUnread: false,
      },
    });
  });

  it("persists a timed-out call as a normal countable TEXT message", async () => {
    const { service, stubs } = buildService();

    await service.post({
      ...base,
      callType: "VIDEO",
      outcome: "MISSED",
    });

    expect(stubs.messageRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: "caller",
        receiverId: "callee",
        messageType: "TEXT",
        systemEvent: null,
        countInUnread: true,
        clientMessageId: "call:call-1:missed",
        content: expect.objectContaining({
          text: "Video call was not answered",
        }),
      })
    );
    expect(stubs.roomRepo.updateRoomOnNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({ unreadIncrement: 1 })
    );
    expect(stubs.getUserSnapshot).toHaveBeenCalledWith("caller");
  });

  it("persists a declined call as a non-unread SYSTEM row naming the callee as endedBy", async () => {
    const { service, stubs } = buildService();

    await service.post({
      ...base,
      outcome: "DECLINED",
      endedBy: "callee",
    });

    expect(stubs.messageRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: "",
        receiverId: "callee",
        messageType: "SYSTEM",
        systemEvent: "CALL_ENDED",
        systemData: expect.objectContaining({
          callId: "call-1",
          status: "DECLINED",
          durationSec: 0,
          endedBy: "callee",
        }),
        countInUnread: false,
        clientMessageId: "call:call-1:declined",
        content: expect.objectContaining({
          text: "Voice call declined",
          call: expect.objectContaining({ outcome: "DECLINED" }),
        }),
      })
    );
    expect(stubs.roomRepo.updateRoomOnNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({ unreadIncrement: 0 })
    );
    // Sender-less rows never fan out a message:sent push — only the caller-visible
    // MISSED row does. Confirming this here catches a stray push notification
    // regression if the `!isSystemOutcome` gate is ever narrowed by mistake.
    expect(stubs.getUserSnapshot).not.toHaveBeenCalled();
  });

  it("persists a cancelled (pre-answer abandon) call as a non-unread SYSTEM row", async () => {
    const { service, stubs } = buildService();

    await service.post({
      ...base,
      callType: "VIDEO",
      outcome: "CANCELLED",
      endedBy: "caller",
    });

    expect(stubs.messageRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: "",
        messageType: "SYSTEM",
        systemEvent: "CALL_ENDED",
        systemData: expect.objectContaining({
          status: "CANCELLED",
          durationSec: 0,
        }),
        countInUnread: false,
        clientMessageId: "call:call-1:cancelled",
        content: expect.objectContaining({
          text: "Video call cancelled",
          call: expect.objectContaining({ outcome: "CANCELLED" }),
        }),
      })
    );
  });

  it("deduplicates a retry before allocating another sequence or broadcasting", async () => {
    const { service, stubs } = buildService();
    stubs.messageRepo.findByClientMessageId.mockResolvedValue({
      id: "existing",
    });

    const result = await service.post({ ...base, outcome: "ENDED" });

    expect(result).toEqual({ id: "existing" });
    expect(stubs.roomRepo.allocateSequence).not.toHaveBeenCalled();
    expect(stubs.messageRepo.createMessage).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
  });

  it("skips safely when the authorized private room is unavailable", async () => {
    const { service, stubs } = buildService();
    stubs.roomRepo.findByRoomId.mockResolvedValue(null);

    await expect(
      service.post({ ...base, outcome: "MISSED" })
    ).resolves.toBeNull();
    expect(stubs.messageRepo.createMessage).not.toHaveBeenCalled();
  });
});
