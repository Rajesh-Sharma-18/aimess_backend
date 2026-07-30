/**
 * Integration tests — private-room pin posts a SYSTEM message and bumps the
 * inbox lastActivity (parity with Community: pin posts a line, unpin does
 * NOT post a line — it retracts the original pin's line instead).
 * Routes (apps/chat-service/src/api/routes/private-message.routes.ts):
 *   POST   /api/chat/private/rooms/:roomId/messages/:messageId/pin
 *   DELETE /api/chat/private/rooms/:roomId/messages/:messageId/pin
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "priv_room_1";
const MESSAGE_ID = "msg_1";
const PEER_ID = "peer-1";

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
    roomId: ROOM,
    participants: [TEST_USER_ID, PEER_ID],
    pinnedCount: 0,
  });
  mocks.privateMessagePinRepo.findActivePinByRoom.mockResolvedValue(null);
  mocks.privateMessagePinRepo.runTransaction.mockImplementation(
    async (fn: (tx: unknown) => unknown) => fn({})
  );
  mocks.privateMessageRepo.findMessageMeta.mockResolvedValue({
    id: MESSAGE_ID,
    senderId: PEER_ID,
    content: { text: "hi" },
    createdAt: new Date(),
  });
  mocks.privateMessagePinRepo.createPin.mockResolvedValue({
    id: "pin_1",
    pinnedAt: new Date(),
  });
  mocks.privateRoomRepo.incPinnedCount.mockResolvedValue({ pinnedCount: 1 });
  mocks.privateRoomRepo.allocateSequence.mockResolvedValue(1);
  mocks.privateMessageRepo.createMessage.mockResolvedValue({
    id: "sysmsg_1",
    content: { text: "pinned" },
    createdAt: new Date(),
  });
});

describe("POST /api/chat/private/rooms/:roomId/messages/:messageId/pin", () => {
  it("POSITIVE: posts a MESSAGE_PINNED system message and bumps lastActivity", async () => {
    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/${MESSAGE_ID}/pin`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(201);
    expect(mocks.privateMessageRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ systemEvent: "MESSAGE_PINNED" })
    );
    expect(mocks.privateRoomRepo.updateRoomOnNewMessage).toHaveBeenCalled();
    expect(
      mocks.privateMessagePinRepo.setPinSystemMessageId
    ).toHaveBeenCalledWith("pin_1", "sysmsg_1");
  });
});

describe("DELETE /api/chat/private/rooms/:roomId/messages/:messageId/pin", () => {
  it("POSITIVE: retracts the pin's system line WITHOUT posting a MESSAGE_UNPINNED message (parity with Community)", async () => {
    mocks.privateMessagePinRepo.findActivePinByMessageId.mockResolvedValue({
      id: "pin_1",
      roomId: ROOM,
      messageId: MESSAGE_ID,
      pinSystemMessageId: "sysmsg_1",
    });
    mocks.privateMessagePinRepo.softDeletePin.mockResolvedValue({
      id: "pin_1",
      roomId: ROOM,
      messageId: MESSAGE_ID,
      unpinnedAt: new Date(),
    });
    mocks.privateRoomRepo.incPinnedCount.mockResolvedValue({
      pinnedCount: 0,
    });
    mocks.privateMessageRepo.deleteForEveryone.mockResolvedValue({
      id: "sysmsg_1",
      roomId: ROOM,
      sequenceNumber: 1,
    });

    const res = await request(app)
      .delete(`/api/chat/private/rooms/${ROOM}/messages/${MESSAGE_ID}/pin`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    // No new MESSAGE_UNPINNED system message — the original pin's line is
    // retracted (hard-deleted) instead, same as Community's "no unpin message" rule.
    expect(mocks.privateMessageRepo.createMessage).not.toHaveBeenCalled();
    expect(mocks.privateMessageRepo.deleteForEveryone).toHaveBeenCalledWith(
      "sysmsg_1",
      ROOM,
      TEST_USER_ID
    );
    expect(mocks.privateRoomRepo.updateRoomOnNewMessage).not.toHaveBeenCalled();
  });
});
