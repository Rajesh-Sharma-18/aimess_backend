/**
 * Integration tests — group pin posts a SYSTEM message and bumps the inbox
 * lastActivity (parity with Community: pin posts a line, unpin does NOT post
 * a line — it retracts the original pin's line instead).
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
  mocks.groupMessagePinRepo.findActivePinByRoom.mockResolvedValue(null);
  mocks.groupMessagePinRepo.runTransaction.mockImplementation(
    async (fn: (tx: unknown) => unknown) => fn({})
  );
  mocks.groupMessageRepo.findById.mockResolvedValue({
    id: MESSAGE_ID,
    roomId: ROOM,
    senderId: "someone",
    content: { text: "hi" },
    createdAt: new Date(),
  });
  mocks.groupMessagePinRepo.createPin.mockResolvedValue({
    id: "pin_1",
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
    expect(
      mocks.groupMessagePinRepo.setPinSystemMessageId
    ).toHaveBeenCalledWith("pin_1", "sysmsg_1");
  });
});

describe("DELETE /api/chat/groups/:roomId/messages/:messageId/pin", () => {
  it("POSITIVE: retracts the pin's system line WITHOUT posting a MESSAGE_UNPINNED message (parity with Community)", async () => {
    mocks.groupMessagePinRepo.findActivePinByMessageId.mockResolvedValue({
      id: "pin_1",
      roomId: ROOM,
      messageId: MESSAGE_ID,
      pinSystemMessageId: "sysmsg_1",
    });
    mocks.groupMessagePinRepo.softDeletePin.mockResolvedValue({
      id: "pin_1",
      roomId: ROOM,
      messageId: MESSAGE_ID,
      unpinnedAt: new Date(),
    });
    mocks.groupRoomRepo.incPinnedCount.mockResolvedValue({ pinnedCount: 0 });
    mocks.groupMessageRepo.deleteForEveryone.mockResolvedValue({
      id: "sysmsg_1",
      roomId: ROOM,
      sequenceNumber: 1,
    });

    const res = await request(app)
      .delete(`/api/chat/groups/${ROOM}/messages/${MESSAGE_ID}/pin`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    // No new MESSAGE_UNPINNED system message — the original pin's line is
    // retracted (hard-deleted) instead, same as Community's "no unpin message" rule.
    expect(mocks.groupMessageRepo.create).not.toHaveBeenCalled();
    expect(mocks.groupMessageRepo.deleteForEveryone).toHaveBeenCalledWith(
      "sysmsg_1",
      ROOM,
      TEST_USER_ID,
      "ADMIN_DELETE"
    );
    // Unpin is a low-signal action — Telegram parity: it must NOT reorder the
    // inbox (mirrors Community's UNPINNED_MESSAGE: false).
    expect(mocks.groupRoomRepo.updateLastMessage).not.toHaveBeenCalled();
  });
});
