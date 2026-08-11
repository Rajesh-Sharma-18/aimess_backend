/**
 * Settings → Chat → Read Receipt, applied to the GROUP inbox tick.
 *
 * The live `message:read` event is already gated at publish (chat-service) and
 * at delivery (the gateway, per viewer). The list tick is the other way the
 * same fact reaches the screen: `GroupRoomService.computeLastMessageReadStatuses`
 * derives READ from every other member's read cursor, so without the same gate
 * the blue tick the socket withheld comes straight back on the next refresh.
 *
 * Reciprocal, WhatsApp-style — both halves are pinned here:
 *   - viewer OFF  → no READ tick, whatever the members did.
 *   - member OFF  → that member gives no receipt, so "everyone has read it" can
 *                   never be satisfied.
 * The row itself, its unread count and its ordering are untouched either way —
 * this switch governs the tick, not delivery.
 */
import request from "supertest";

import {
  buildApp,
  mockGroupMemberships,
  type BuiltMocks,
} from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { invalidateAccountChatSettings } from "../../src/lib/account-chat-settings.js";
import { userGrpcClient } from "../../src/grpc/user-snapshot.client.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_receipt_1";
const PEER = "peer-read-1";
const LAST_MESSAGE_ID = "g_last";

/** Per-user switch table; anyone not listed keeps the ON default. */
function setReadReceiptsByUser(byUser: Record<string, boolean>): void {
  invalidateAccountChatSettings();
  (userGrpcClient.getChatSettings as jest.Mock).mockImplementation(
    async (userId: string) => ({
      autoDeleteTimer: "OFF",
      typingIndicators: true,
      readReceipts: byUser[userId] ?? true,
    })
  );
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());

  mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([]);
  mocks.privateRoomRepo.countConversations.mockResolvedValue(0);

  mockGroupMemberships(mocks, [
    {
      roomId: ROOM,
      role: "MEMBER",
      status: "ACTIVE",
      unreadCount: 0,
      notificationSettings: {},
    },
  ]);
  mocks.groupMemberRepo.getActiveRoomIds.mockResolvedValue([ROOM]);
  mocks.groupRoomRepo.countUserGroups.mockResolvedValue(1);
  mocks.groupRoomRepo.findLastMessageAtForRooms.mockResolvedValue([
    { roomId: ROOM, lastMessageAt: new Date(3000) },
  ]);
  mocks.groupRoomRepo.getInboxGroups.mockResolvedValue([
    {
      roomId: ROOM,
      name: "Devs",
      avatar: "",
      memberCount: 2,
      lastMessageAt: new Date(3000),
      lastMessageId: LAST_MESSAGE_ID,
      // The tick only exists when the CALLER sent the last message.
      lastMessagePreview: { senderId: TEST_USER_ID, messageType: "text" },
      pinnedCount: 0,
    },
  ]);
  // The peer's cursor is ON the last message — every read-side condition is met,
  // so anything short of READ in a test below is the privacy gate doing its job.
  mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
    { userId: TEST_USER_ID, lastReadMessageId: LAST_MESSAGE_ID },
    { userId: PEER, lastReadMessageId: LAST_MESSAGE_ID },
  ]);
  mocks.groupMessageRepo.findManyByIds.mockResolvedValue([
    { id: LAST_MESSAGE_ID, sequenceNumber: 7, deliveredTo: [PEER] },
  ]);

  setReadReceiptsByUser({});
});

afterEach(() => {
  invalidateAccountChatSettings();
});

const inboxGroupRow = async () => {
  const res = await request(app)
    .get("/api/chat/inbox")
    .set(bearer(makeAccessToken()));
  expect(res.status).toBe(200);
  return res.body.data.data.find((i: { type: string }) => i.type === "GROUP");
};

describe("group inbox read tick honours Settings → Chat → Read Receipt", () => {
  it("both sides ON → READ", async () => {
    expect((await inboxGroupRow()).lastMessageReadStatus).toBe("READ");
  });

  it("viewer OFF → falls back to DELIVERED, never READ", async () => {
    setReadReceiptsByUser({ [TEST_USER_ID]: false });
    const row = await inboxGroupRow();
    expect(row.lastMessageReadStatus).toBe("DELIVERED");
    // Delivery, unread and the row itself are untouched by a privacy switch.
    expect(row.roomId).toBe(ROOM);
    expect(row.unreadCount).toBe(0);
  });

  it("the OTHER member OFF → their read does not count, so no READ", async () => {
    setReadReceiptsByUser({ [PEER]: false });
    expect((await inboxGroupRow()).lastMessageReadStatus).toBe("DELIVERED");
  });

  it("fails OPEN — a user-service outage must not silently drop the tick", async () => {
    invalidateAccountChatSettings();
    (userGrpcClient.getChatSettings as jest.Mock).mockRejectedValue(
      new Error("user-service down")
    );
    expect((await inboxGroupRow()).lastMessageReadStatus).toBe("READ");
  });
});
