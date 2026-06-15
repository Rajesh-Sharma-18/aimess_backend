/**
 * Unit tests — private-message clientMessageId idempotency under concurrency.
 *
 * The send/forward paths pre-check `findByClientMessageId`, but concurrent
 * requests with the SAME clientMessageId all pass that check and race to the
 * insert. The partial-unique index `private_messages_idempotency_idx`
 * (roomId, senderId, clientMessageId) lets exactly one win; the losers get a
 * duplicate-key error (Mongo E11000 / Prisma P2002). The service must treat that
 * as the idempotent case and return the winning row — NOT surface a 500 /
 * SERVICE_ERROR (the `chaos.duplicateConcurrent` scenario).
 *
 * The private send path is gRPC/socket-only (no REST route), so we exercise the
 * service directly with mock repositories rather than through supertest.
 */
import { PrivateMessageService } from "../../src/services/private-message.service.js";

const ROOM = "prv_room_1";
const SENDER = "user_sender";
const RECEIVER = "user_receiver";
const CMID = "client-msg-id-123";

function buildService() {
  const messageRepo = {
    findByClientMessageId: jest.fn(),
    createMessage: jest.fn(),
    createForwardedMessage: jest.fn(),
    findById: jest.fn(),
  };
  const roomRepo = {
    allocateSequence: jest.fn(async () => 7),
    updateRoomOnNewMessage: jest.fn(async () => undefined),
    // forwardMessage now unconditionally binds the caller to the SOURCE message's
    // ACTUAL room (closes the gRPC/socket read-IDOR, H-1). This idempotency-race
    // test is about P2002 collapse, not authz, so make SENDER a participant of the
    // source room (ROOM) the mocked source message lives in.
    findByRoomId: jest.fn(async () => ({
      roomId: ROOM,
      participants: [SENDER, RECEIVER],
    })),
  };
  const cacheRepo = {};
  const userSnapshotService = { getUserSnapshotsMap: jest.fn() };
  const userServiceClient = { checkFriendship: jest.fn(async () => true) };
  const reportRepo = {};

  const service = new PrivateMessageService(
    messageRepo as never,
    roomRepo as never,
    cacheRepo as never,
    userSnapshotService as never,
    userServiceClient as never,
    reportRepo as never
  );
  return { service, messageRepo, roomRepo, userServiceClient };
}

const sendParams = {
  roomId: ROOM,
  senderId: SENDER,
  receiverId: RECEIVER,
  content: { text: "hi" },
  messageType: "TEXT",
  clientMessageId: CMID,
};

describe("PrivateMessageService.sendMessage — concurrent clientMessageId race", () => {
  it("collapses a Prisma P2002 duplicate to the existing message (already_sent)", async () => {
    const { service, messageRepo } = buildService();
    const winner = { id: "winner_msg_id", createdAt: new Date(1000) };
    // Pre-send dedup misses (the race), then the insert loses to the winner,
    // then the post-conflict re-read finds the committed winner.
    messageRepo.findByClientMessageId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    messageRepo.createMessage.mockRejectedValue({ code: "P2002" });

    const result = await service.sendMessage(sendParams);

    expect(result).toBe(winner);
    expect(messageRepo.createMessage).toHaveBeenCalledTimes(1);
    expect(messageRepo.findByClientMessageId).toHaveBeenCalledTimes(2);
  });

  it("collapses a raw Mongo E11000 duplicate to the existing message", async () => {
    const { service, messageRepo } = buildService();
    const winner = { id: "winner_msg_id", createdAt: new Date(1000) };
    messageRepo.findByClientMessageId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    messageRepo.createMessage.mockRejectedValue(
      Object.assign(new Error("E11000 duplicate key error collection: ..."), {
        code: 11000,
      })
    );

    const result = await service.sendMessage(sendParams);

    expect(result).toBe(winner);
  });

  it("rethrows when the duplicate winner cannot be re-read (no silent data loss)", async () => {
    const { service, messageRepo } = buildService();
    messageRepo.findByClientMessageId
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce(null); // re-read also misses
    const dupErr = { code: "P2002" };
    messageRepo.createMessage.mockRejectedValue(dupErr);

    await expect(service.sendMessage(sendParams)).rejects.toBe(dupErr);
  });

  it("does NOT swallow a non-duplicate insert error", async () => {
    const { service, messageRepo } = buildService();
    messageRepo.findByClientMessageId.mockResolvedValueOnce(null);
    const boom = Object.assign(new Error("connection reset"), {
      code: "P1001",
    });
    messageRepo.createMessage.mockRejectedValue(boom);

    await expect(service.sendMessage(sendParams)).rejects.toBe(boom);
    // The duplicate-only re-read must not run for a non-dup error.
    expect(messageRepo.findByClientMessageId).toHaveBeenCalledTimes(1);
  });

  it("returns the freshly created message on the happy (non-racing) path", async () => {
    const { service, messageRepo } = buildService();
    messageRepo.findByClientMessageId.mockResolvedValueOnce(null);
    const created = { id: "new_msg_id", createdAt: new Date(2000) };
    messageRepo.createMessage.mockResolvedValue(created);

    const result = await service.sendMessage(sendParams);

    expect(result).toBe(created);
    expect(messageRepo.findByClientMessageId).toHaveBeenCalledTimes(1);
  });
});

describe("PrivateMessageService.forwardMessage — concurrent clientMessageId race", () => {
  const forwardParams = {
    sourceMessageId: "src_msg_id",
    targetRoomId: "prv_target_room",
    senderId: SENDER,
    receiverId: RECEIVER,
    clientMessageId: CMID,
  };

  it("collapses a P2002 duplicate to the existing forwarded message", async () => {
    const { service, messageRepo } = buildService();
    const winner = { id: "fwd_winner_id", createdAt: new Date(3000) };
    messageRepo.findByClientMessageId
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce(winner); // post-conflict re-read
    messageRepo.findById.mockResolvedValue({
      id: "src_msg_id",
      roomId: ROOM,
      senderId: "someone",
      messageType: "TEXT",
      content: { text: "fwd" },
      isDeleted: false,
      createdAt: new Date(10),
    });
    messageRepo.createForwardedMessage.mockRejectedValue({ code: "P2002" });

    const result = await service.forwardMessage(forwardParams);

    expect(result).toBe(winner);
    expect(messageRepo.createForwardedMessage).toHaveBeenCalledTimes(1);
  });
});
