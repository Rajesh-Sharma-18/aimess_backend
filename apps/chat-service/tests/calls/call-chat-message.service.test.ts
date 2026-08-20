/**
 * ONE CALL === ONE ROW. The row is created when the call starts ringing and
 * then transitions IN PLACE through every later state, keyed on
 * `clientMessageId = "call:<callId>"`. These tests pin the two halves of that:
 * the insert (message:new) and the transition (message:edited, same row/id/ts),
 * plus the invariant that the kind is VOICE_CALL / VIDEO_CALL at every state.
 */
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));

// Mocked so the "no chat push" guard below can assert it is never reached. This
// service must not push at all — see that test for why.
jest.mock("../../src/events/publish-message-sent.js", () => ({
  publishMessageSentSafe: jest.fn(),
}));

import { CallChatMessageService } from "../../src/services/call-chat-message.service.js";
import { publishConvUpdatedSafe } from "../../src/events/publish-conv-updated.js";
import { publishMessageSentSafe } from "../../src/events/publish-message-sent.js";

const listBump = publishConvUpdatedSafe as jest.Mock;
const publishMessageSent = publishMessageSentSafe as jest.Mock;

beforeEach(() => {
  listBump.mockClear();
  publishMessageSent.mockClear();
});

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
  /**
   * A call row never advances its timestamp, so anything sent mid-call is
   * NEWER than every transition that follows. The snapshot write already
   * refuses to rewind the room; the socket bump has to obey the same rule or it
   * tells every list client to replace a newer preview with an older one.
   */
  it("does NOT bump the list when a real message landed mid-call", async () => {
    const { service, stubs } = buildService();
    stubs.messageRepo.findByClientMessageId.mockResolvedValue(
      existingRow("ANSWERED")
    );
    // A text message became the room's last message while the call was up.
    stubs.roomRepo.findByRoomId.mockResolvedValue({
      roomId: "room-1",
      participants: ["caller", "callee"],
      lastMessageId: "some-newer-text",
    });

    await service.post({ ...base, outcome: "ENDED", durationSec: 42 });

    // The card itself still updates in every open transcript...
    const events = stubs.redis.publish.mock.calls.map(
      (c) => JSON.parse(c[1] as string).event
    );
    expect(events).toContain("message:edited");
    // ...but the room snapshot and the list bump both stand down.
    expect(stubs.roomRepo.updateRoomOnNewMessage).not.toHaveBeenCalled();
    expect(listBump).not.toHaveBeenCalled();
  });

  it("bumps the list while the call row IS still the room's last message", async () => {
    const { service, stubs } = buildService();
    stubs.messageRepo.findByClientMessageId.mockResolvedValue(
      existingRow("ANSWERED")
    );
    stubs.roomRepo.findByRoomId.mockResolvedValue({
      roomId: "room-1",
      participants: ["caller", "callee"],
      lastMessageId: "message-1",
    });

    await service.post({ ...base, outcome: "ENDED", durationSec: 42 });

    expect(stubs.roomRepo.updateRoomOnNewMessage).toHaveBeenCalled();
    expect(listBump).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room-1",
        lastMessageAt: CREATED_AT.getTime(),
        // The identity/freshness quartet every other send path supplies —
        // without it a client cannot tie-break this bump against a same-ms row.
        preview: expect.objectContaining({
          clientMessageId: "call:call-1",
          seq: 7,
          createdAt: CREATED_AT.getTime(),
        }),
      })
    );
  });

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
          text: "Voice Call 02:05",
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
          text: "Voice call was not answered",
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
          text: "Video call was not answered",
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

  // This service writes the card and bumps the conversation. It does NOT push.
  //
  // A MISSED transition used to also publish `chat.message_sent` as a "push
  // fallback", but the only caller that reaches here with MISSED is
  // `fanOutUnansweredRing`, which already fires the dedicated missed-call push
  // for the same callee. Different queues, different collapse keys — so neither
  // replaced the other and one missed call produced TWO lock-screen banners.
  it("publishes no chat message push on ANY outcome — the call push owns that", async () => {
    for (const outcome of ["RINGING", "MISSED", "ENDED", "DECLINED"]) {
      const { service, stubs } = buildService();
      publishMessageSent.mockClear();
      stubs.messageRepo.findByClientMessageId.mockResolvedValue(
        outcome === "RINGING" ? null : existingRow("RINGING")
      );

      await service.post({ ...base, outcome: outcome as never });

      expect(publishMessageSent).not.toHaveBeenCalled();
    }
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
