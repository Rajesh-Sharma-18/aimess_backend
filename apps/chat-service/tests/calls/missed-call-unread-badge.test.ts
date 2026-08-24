/**
 * The nav badge (GET /chat/unread-summary → sumUnreadForUser) and the Unread
 * tab (per-row `unreadCount`) read the SAME number: `unreadCountByUser[me]`.
 * They can therefore only disagree when that number holds a unit no recount can
 * reproduce — and a private call row was exactly that: a MISSED transition
 * credited the callee's counter, while every recount
 * (countRemainingUnread) excludes any row carrying a `systemEvent`. Once the
 * callee had read past the RINGING card the MISSED transition rewrites in
 * place, the forward-only read pointer meant no read could ever recount it
 * again: badge 3, Unread tab empty, forever.
 *
 * Two halves are pinned here — the write that must not happen, and the recount
 * that heals rooms already carrying one.
 */
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/events/publish-message-sent.js", () => ({
  publishMessageSentSafe: jest.fn(),
}));

import { CallChatMessageService } from "../../src/services/call-chat-message.service.js";
import { PrivateRoomRepository } from "../../src/repositories/private-room.repository.js";

const CREATED_AT = new Date("2026-08-21T10:00:00.000Z");
const ROOM = "room-1";
const CALLEE = "callee";
/** Real ObjectIds — the repo rejects anything else as an optimistic id. */
const CALL_ROW_ID = "64b7f0c2e13b4a0012345678";
const NEWER_ID = "64b7f0c2e13b4a0012345679";

function buildCallService() {
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
        roomId: ROOM,
        participants: ["caller", CALLEE],
        lastMessageId: "message-1",
      }),
      findByParticipantsKey: jest.fn().mockResolvedValue({
        roomId: ROOM,
        participants: ["caller", CALLEE],
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
  return { service, stubs };
}

const base = {
  callId: "call-1",
  callerId: "caller",
  calleeId: CALLEE,
  privateRoomId: ROOM,
  callType: "VIDEO",
  endedAt: CREATED_AT,
  endedBy: "caller",
};

/** An already-persisted RINGING row, the state a MISSED call transitions from. */
const ringingRow = {
  id: "message-1",
  roomId: ROOM,
  sequenceNumber: 7,
  createdAt: CREATED_AT,
  content: {
    text: "",
    urls: [],
    files: [],
    call: {
      callId: "call-1",
      callType: "VIDEO",
      callStatus: "RINGING",
      outcome: "RINGING",
    },
  },
};

describe("S6 — a missed call never raises the chat badge", () => {
  it("does not increment the callee's unread counter on the MISSED transition", async () => {
    const { service, stubs } = buildCallService();
    stubs.messageRepo.findByClientMessageId.mockResolvedValue(ringingRow);

    await service.post({ ...base, outcome: "MISSED" });

    expect(stubs.roomRepo.updateRoomOnNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({ receiverId: CALLEE, unreadIncrement: 0 })
    );
    // …and the persisted row agrees, so no OTHER counter can pick it up either.
    expect(stubs.messageRepo.updateCallState).toHaveBeenCalledWith(
      expect.objectContaining({ countInUnread: false })
    );
  });

  it("still writes the card and bumps the list (the row itself is unchanged)", async () => {
    const { service, stubs } = buildCallService();
    stubs.messageRepo.findByClientMessageId.mockResolvedValue(ringingRow);

    await service.post({ ...base, outcome: "MISSED" });

    expect(stubs.messageRepo.updateCallState).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "message-1",
        messageType: "VIDEO_CALL",
        systemEvent: "CALL_ENDED",
      })
    );
    // message:edited to BOTH participants — the card must still appear.
    expect(stubs.redis.publish).toHaveBeenCalledTimes(2);
  });
});

/** Prisma double for the read-pointer path of PrivateRoomRepository. */
function buildRepo(room: Record<string, unknown>, remaining: number) {
  const update = jest.fn().mockImplementation(async ({ data }) => ({
    ...room,
    ...data,
  }));
  const seqById: Record<string, number> = {
    [CALL_ROW_ID]: 7,
    [NEWER_ID]: 9,
  };
  const prisma = {
    privateRoom: {
      findUnique: jest.fn().mockResolvedValue(room),
      update,
    },
    privateMessage: {
      findFirst: jest.fn().mockImplementation(async ({ where }) => {
        const seq = seqById[where.id as string];
        return seq === undefined ? null : { sequenceNumber: seq };
      }),
      findUnique: jest.fn().mockImplementation(async ({ where }) => {
        const seq = seqById[where.id as string];
        return seq === undefined ? null : { sequenceNumber: seq };
      }),
      aggregateRaw: jest
        .fn()
        .mockResolvedValue(remaining > 0 ? [{ total: remaining }] : []),
    },
  };
  const repo = new PrivateRoomRepository(
    prisma as unknown as ConstructorParameters<typeof PrivateRoomRepository>[0]
  );
  return { repo, prisma, update };
}

describe("S5 — a repeat read heals a counter the pointer already passed", () => {
  const stuckRoom = {
    roomId: ROOM,
    unreadCountByUser: { [CALLEE]: 3 },
    hasUnreadByUser: { [CALLEE]: true },
    lastReadMessageIdByUser: { [CALLEE]: CALL_ROW_ID },
    lastReadAtByUser: { [CALLEE]: CREATED_AT.toISOString() },
    lastUnreadMessageIdByUser: { [CALLEE]: CALL_ROW_ID },
    firstUnreadMessageIdByUser: { [CALLEE]: CALL_ROW_ID },
    lastUnreadPreviewByUser: { [CALLEE]: { text: "Video Call" } },
  };

  it("recounts and clears when nothing countable remains", async () => {
    const { repo, update } = buildRepo(stuckRoom, 0);

    // Same boundary the reader already holds — the forward-only guard refuses
    // to move the pointer, which is precisely when the old code returned early.
    const result = await repo.markReadUpTo({
      roomId: ROOM,
      userId: CALLEE,
      upToMessageId: CALL_ROW_ID,
      givesReceipts: true,
    });

    expect(update).toHaveBeenCalledTimes(1);
    const data = update.mock.calls[0]![0].data as Record<
      string,
      Record<string, unknown>
    >;
    expect(data.unreadCountByUser[CALLEE]).toBe(0);
    expect(data.hasUnreadByUser[CALLEE]).toBe(false);
    // Preview hints go with it, same as the advancing path.
    expect(data.lastUnreadPreviewByUser[CALLEE]).toBeNull();
    // The pointer itself is untouched — no receipt regression on the peer.
    expect(data.lastReadMessageIdByUser).toBeUndefined();
    expect((result?.unreadCountByUser as Record<string, number>)[CALLEE]).toBe(
      0
    );
  });

  it("leaves a genuinely unread room alone (real messages still pending)", async () => {
    const { repo, update } = buildRepo(stuckRoom, 3);

    await repo.markReadUpTo({
      roomId: ROOM,
      userId: CALLEE,
      upToMessageId: CALL_ROW_ID,
      givesReceipts: true,
    });

    expect(update).not.toHaveBeenCalled();
  });

  it("writes nothing when the counter is already zero", async () => {
    const { repo, update, prisma } = buildRepo(
      { ...stuckRoom, unreadCountByUser: { [CALLEE]: 0 } },
      0
    );

    await repo.markReadUpTo({
      roomId: ROOM,
      userId: CALLEE,
      upToMessageId: CALL_ROW_ID,
      givesReceipts: true,
    });

    expect(update).not.toHaveBeenCalled();
    // …and does not even pay for the recount.
    expect(prisma.privateMessage.aggregateRaw).not.toHaveBeenCalled();
  });
});

describe("S4 — an advancing read still sets the counter to what remains", () => {
  it("advances the pointer and stores the recounted remainder", async () => {
    const { repo, update } = buildRepo(
      {
        roomId: ROOM,
        unreadCountByUser: { [CALLEE]: 5 },
        hasUnreadByUser: { [CALLEE]: true },
        lastReadMessageIdByUser: { [CALLEE]: CALL_ROW_ID },
        lastReadAtByUser: {},
      },
      2
    );

    await repo.markReadUpTo({
      roomId: ROOM,
      userId: CALLEE,
      upToMessageId: NEWER_ID,
      givesReceipts: true,
    });

    const data = update.mock.calls[0]![0].data as Record<
      string,
      Record<string, unknown>
    >;
    expect(data.unreadCountByUser[CALLEE]).toBe(2);
    expect(data.hasUnreadByUser[CALLEE]).toBe(true);
    expect(data.lastReadMessageIdByUser[CALLEE]).toBe(NEWER_ID);
  });
});
