/**
 * ONE CALL === ONE ROW. The row is created when the call starts ringing and
 * then transitions IN PLACE through every later state, keyed on
 * `clientMessageId = "call:<callId>"`. These tests pin the two halves of that:
 * the insert (message:new) and the transition (message:edited, same row/id/ts),
 * plus the invariant that the kind is VOICE_CALL / VIDEO_CALL at every state.
 */
import { CallChatMessageService } from "../../src/services/call-chat-message.service.js";

const CREATED_AT = new Date("2026-07-15T10:00:00.000Z");

function buildService() {
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
        createdAt: data.createdAt ?? CREATED_AT,
      })),
      updateCallState: jest.fn().mockImplementation(async (data) => ({
        id: data.messageId,
        ...data,
        createdAt: CREATED_AT,
        sequenceNumber: 7,
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
  return { service, stubs, pipeline, now: CREATED_AT };
}

/** An already-persisted call row sitting in `status`. */
function existingRow(status: string, callType = "AUDIO") {
  return {
    id: "message-1",
    roomId: "room-1",
    sequenceNumber: 7,
    createdAt: CREATED_AT,
    content: {
      text: "",
      urls: [],
      files: [],
      call: { callId: "call-1", callType, callStatus: status, outcome: status },
    },
  };
}

const base = {
  callId: "call-1",
  callerId: "caller",
  calleeId: "callee",
  privateRoomId: "room-1",
  callType: "AUDIO",
  endedAt: CREATED_AT,
  endedBy: "caller",
};

describe("CallChatMessageService — row creation", () => {
  it("opens a voice call as a VOICE_CALL row keyed on call:<callId>", async () => {
    const { service, stubs } = buildService();

    await service.post({ ...base, outcome: "RINGING" });

    expect(stubs.messageRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room-1",
        // Sender-less: nobody "sent" a call — direction rides content.call.callerId.
        senderId: "",
        receiverId: "callee",
        messageType: "VOICE_CALL",
        systemEvent: "CALL_STARTED",
        // Stable across the WHOLE lifecycle — it is the upsert key.
        clientMessageId: "call:call-1",
        sequenceNumber: 7,
        // A ringing card must never inflate a counter.
        countInUnread: false,
        content: expect.objectContaining({
          call: expect.objectContaining({
            callId: "call-1",
            callType: "AUDIO",
            callStatus: "RINGING",
            callerId: "caller",
          }),
        }),
      })
    );
    const livePayload = JSON.parse(stubs.redis.publish.mock.calls[0]![1]);
    expect(livePayload).toMatchObject({
      event: "message:new",
      data: { contentType: "VOICE_CALL", systemEvent: "CALL_STARTED" },
    });
  });

  it("opens a video call as a VIDEO_CALL row", async () => {
    const { service, stubs } = buildService();

    await service.post({ ...base, callType: "VIDEO", outcome: "RINGING" });

    expect(stubs.messageRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: "VIDEO_CALL",
        content: expect.objectContaining({
          call: expect.objectContaining({ callType: "VIDEO" }),
        }),
      })
    );
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

describe("CallChatMessageService — in-place transitions", () => {
  it("rewrites the SAME row on end and fans out message:edited, not a second card", async () => {
    const { service, stubs } = buildService();
    stubs.messageRepo.findByClientMessageId.mockResolvedValue(
      existingRow("ANSWERED")
    );

    await service.post({ ...base, outcome: "ENDED", durationSec: 125 });

    expect(stubs.messageRepo.createMessage).not.toHaveBeenCalled();
    // No new sequence number — the card keeps its place in the timeline.
    expect(stubs.roomRepo.allocateSequence).not.toHaveBeenCalled();
    expect(stubs.messageRepo.updateCallState).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "message-1",
        roomId: "room-1",
        messageType: "VOICE_CALL",
        systemEvent: "CALL_ENDED",
        countInUnread: false,
        content: expect.objectContaining({
          text: "Voice call lasted 02:05",
          call: expect.objectContaining({
            callStatus: "ENDED",
            durationSec: 125,
          }),
        }),
      })
    );
    const livePayload = JSON.parse(stubs.redis.publish.mock.calls[0]![1]);
    expect(livePayload).toMatchObject({
      event: "message:edited",
      data: {
        id: "message-1",
        contentType: "VOICE_CALL",
        systemEvent: "CALL_ENDED",
        // Original ring time, not hang-up time.
        serverTs: CREATED_AT.getTime(),
        sequenceNumber: 7,
      },
    });
  });

  it("keeps the kind on a declined call and does not raise a badge", async () => {
    const { service, stubs } = buildService();
    stubs.messageRepo.findByClientMessageId.mockResolvedValue(
      existingRow("RINGING")
    );

    await service.post({ ...base, outcome: "DECLINED", endedBy: "callee" });

    expect(stubs.messageRepo.updateCallState).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: "VOICE_CALL",
        systemEvent: "CALL_ENDED",
        countInUnread: false,
        content: expect.objectContaining({
          text: "Voice call declined",
          call: expect.objectContaining({ callStatus: "DECLINED" }),
        }),
      })
    );
  });

  it("keeps the kind on a cancelled video call", async () => {
    const { service, stubs } = buildService();
    stubs.messageRepo.findByClientMessageId.mockResolvedValue(
      existingRow("RINGING", "VIDEO")
    );

    await service.post({
      ...base,
      callType: "VIDEO",
      outcome: "CANCELLED",
    });

    expect(stubs.messageRepo.updateCallState).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: "VIDEO_CALL",
        content: expect.objectContaining({
          text: "Video call cancelled",
          call: expect.objectContaining({ callStatus: "CANCELLED" }),
        }),
      })
    );
  });

  it("MISSED is the one transition that raises the callee's badge", async () => {
    const { service, stubs } = buildService();
    stubs.messageRepo.findByClientMessageId.mockResolvedValue(
      existingRow("RINGING")
    );
    stubs.roomRepo.findByRoomId.mockResolvedValue({
      roomId: "room-1",
      participants: ["caller", "callee"],
      lastMessageId: "message-1",
    });

    await service.post({ ...base, outcome: "MISSED" });

    expect(stubs.messageRepo.updateCallState).toHaveBeenCalledWith(
      expect.objectContaining({ countInUnread: true })
    );
    expect(stubs.roomRepo.updateRoomOnNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({ unreadIncrement: 1 })
    );
  });
});

describe("CallChatMessageService — terminal is terminal", () => {
  it("ignores a late duplicate of the same state", async () => {
    const { service, stubs } = buildService();
    const row = existingRow("ENDED");
    stubs.messageRepo.findByClientMessageId.mockResolvedValue(row);

    const result = await service.post({ ...base, outcome: "ENDED" });

    expect(result).toBe(row);
    expect(stubs.messageRepo.updateCallState).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
  });

  it("refuses to rewrite an already-terminal row with a different outcome", async () => {
    const { service, stubs } = buildService();
    // Racing LiveKit webhook arriving after the user's own decline.
    stubs.messageRepo.findByClientMessageId.mockResolvedValue(
      existingRow("DECLINED")
    );

    await service.post({ ...base, outcome: "CANCELLED" });

    expect(stubs.messageRepo.updateCallState).not.toHaveBeenCalled();
    expect(stubs.redis.publish).not.toHaveBeenCalled();
  });
});
