/**
 * Integration tests — private-room pin/unpin now post a SYSTEM message and
 * gate the inbox lastActivity bump per subtype (pin bumps, unpin does not).
 * Private previously had NO system-message framework outside call lifecycle.
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
  });
  mocks.privateMessagePinRepo.countPinsByRoom.mockResolvedValue(0);
  mocks.privateMessageRepo.findMessageMeta.mockResolvedValue({
    id: MESSAGE_ID,
    senderId: PEER_ID,
    content: { text: "hi" },
    createdAt: new Date(),
  });
  mocks.privateMessagePinRepo.createPin.mockResolvedValue({
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
  });
});

describe("DELETE /api/chat/private/rooms/:roomId/messages/:messageId/pin", () => {
  it("POSITIVE: posts a MESSAGE_UNPINNED system message WITHOUT bumping lastActivity", async () => {
    mocks.privateMessagePinRepo.deletePin.mockResolvedValue({
      deletedCount: 1,
    });
    mocks.privateRoomRepo.incPinnedCount.mockResolvedValue({
      pinnedCount: 0,
    });

    const res = await request(app)
      .delete(`/api/chat/private/rooms/${ROOM}/messages/${MESSAGE_ID}/pin`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.privateMessageRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ systemEvent: "MESSAGE_UNPINNED" })
    );
    expect(mocks.privateRoomRepo.updateRoomOnNewMessage).not.toHaveBeenCalled();
  });
});
