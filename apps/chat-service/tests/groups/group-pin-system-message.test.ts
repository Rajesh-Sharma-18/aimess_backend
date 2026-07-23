/**
 * Integration tests — group pin/unpin now post a SYSTEM message and gate the
 * inbox lastActivity bump per subtype (pin bumps, unpin does not), matching
 * Community's SYSTEM_MESSAGE_BUMPS_ACTIVITY policy.
 * Routes (apps/chat-service/src/api/routes/group-message.routes.ts):
 *   POST   /api/chat/groups/:roomId/messages/:messageId/pin
 *   DELETE /api/chat/groups/:roomId/messages/:messageId/pin
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_1";
const MESSAGE_ID = "msg_1";

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
    role: "OWNER",
  });
  mocks.groupMessagePinRepo.countPinsByRoom.mockResolvedValue(0);
  mocks.groupMessageRepo.findById.mockResolvedValue({
    id: MESSAGE_ID,
    roomId: ROOM,
    senderId: "someone",
    content: { text: "hi" },
    createdAt: new Date(),
  });
  mocks.groupMessagePinRepo.createPin.mockResolvedValue({
    pinnedAt: new Date(),
  });
  mocks.groupRoomRepo.incPinnedCount.mockResolvedValue({ pinnedCount: 1 });
  mocks.groupRoomRepo.allocateSequence.mockResolvedValue(1);
  mocks.groupMessageRepo.create.mockResolvedValue({
    id: "sysmsg_1",
    senderId: TEST_USER_ID,
    senderName: "",
    messageType: "SYSTEM",
    content: { text: "pinned" },
    createdAt: new Date(),
  });
  mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
    roomId: ROOM,
    name: "Devs",
  });
  mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([]);
});

describe("POST /api/chat/groups/:roomId/messages/:messageId/pin", () => {
  it("POSITIVE: posts a MESSAGE_PINNED system message and bumps lastActivity", async () => {
    const res = await request(app)
      .post(`/api/chat/groups/${ROOM}/messages/${MESSAGE_ID}/pin`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(201);
    expect(mocks.groupMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ systemEvent: "MESSAGE_PINNED" })
    );
    // Pin is bump-eligible — the room's lastActivity/preview must move.
    expect(mocks.groupRoomRepo.updateLastMessage).toHaveBeenCalled();
  });
});

describe("DELETE /api/chat/groups/:roomId/messages/:messageId/pin", () => {
  it("POSITIVE: posts a MESSAGE_UNPINNED system message WITHOUT bumping lastActivity", async () => {
    mocks.groupMessagePinRepo.deletePin.mockResolvedValue({ deletedCount: 1 });
    mocks.groupRoomRepo.incPinnedCount.mockResolvedValue({ pinnedCount: 0 });

    const res = await request(app)
      .delete(`/api/chat/groups/${ROOM}/messages/${MESSAGE_ID}/pin`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.groupMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ systemEvent: "MESSAGE_UNPINNED" })
    );
    // Unpin is a low-signal action — Telegram parity: it must NOT reorder the
    // inbox (mirrors Community's UNPINNED_MESSAGE: false).
    expect(mocks.groupRoomRepo.updateLastMessage).not.toHaveBeenCalled();
  });
});
