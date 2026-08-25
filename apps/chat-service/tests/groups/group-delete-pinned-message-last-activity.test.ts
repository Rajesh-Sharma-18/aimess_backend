/**
 * Group counterpart of tests/community/community-delete-pinned-message-last-activity.
 *
 * Deleting a PINNED group message for everyone must tombstone the
 * "<actor> pinned a message" SYSTEM line the pin created, and the room's
 * last-message snapshot must roll back to the newest STILL VISIBLE message —
 * never to the retracted pin line.
 *
 * Regression: the pin hook and the last-message recalculation both ran
 * detached (`void ...`), so the recalc could read `findPreviousVisible` while
 * the pin line was still alive and persist it as the room's last message. The
 * list then previewed a tombstone, and a reload served the same wrong row.
 */
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));

import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const ROOM = "r".repeat(24);
const MSG = "m".repeat(24);
const SYS_PIN = "s".repeat(24);
const PREV = "p".repeat(24);
const BASE = "/api/chat/groups";

let app: import("express").Express;
let mocks: BuiltMocks;

/** Drains the fire-and-forget recalc chain the delete handler kicks off. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  jest.clearAllMocks();
  ({ app, mocks } = buildApp());
});

describe("DELETE forEveryone on a PINNED group message", () => {
  let sysPinDeleted: boolean;

  beforeEach(() => {
    sysPinDeleted = false;

    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: ROOM,
      userId: TEST_USER_ID,
      role: "ADMIN",
      status: "active",
    });
    mocks.groupMessageRepo.findById.mockImplementation(async (id: string) => ({
      id,
      roomId: ROOM,
      senderId: TEST_USER_ID,
      messageType: "TEXT",
      content: { text: "Hello everyone" },
      createdAt: new Date(),
    }));
    mocks.groupMessageRepo.deleteForEveryone.mockImplementation(
      async (id: string) => {
        if (id === SYS_PIN) sysPinDeleted = true;
        return {
          id,
          roomId: ROOM,
          sequenceNumber: 9,
          createdAt: new Date(),
          deletedAt: new Date(),
          deletedType: "SELF_DELETE",
        };
      }
    );
    mocks.groupRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      // The pin line is what the room currently previews.
      lastMessageId: SYS_PIN,
    });
    mocks.groupRoomRepo.setLastMessage.mockResolvedValue(true);
    // Answers the way the real query does: the pin line disappears from
    // "previous visible" only once it has actually been tombstoned.
    mocks.groupMessageRepo.findPreviousVisible.mockImplementation(async () =>
      sysPinDeleted
        ? {
            id: PREV,
            senderId: "sender-2",
            senderName: "Prev Sender",
            content: { text: "older" },
            messageType: "TEXT",
            createdAt: new Date(),
            clientMessageId: null,
            sequenceNumber: 7,
            revision: 3,
          }
        : {
            id: SYS_PIN,
            senderId: "",
            senderName: "",
            content: { text: "pinned a message" },
            messageType: "SYSTEM",
            createdAt: new Date(),
            clientMessageId: null,
            sequenceNumber: 8,
            revision: 4,
          }
    );
    // The active pin's back-reference to its own system line — the only
    // reliable link between the original message and the pin event.
    mocks.groupMessagePinRepo.findActivePinByMessageId.mockResolvedValue({
      id: "pin-1",
      roomId: ROOM,
      messageId: MSG,
      pinSystemMessageId: SYS_PIN,
    });
    mocks.groupMessagePinRepo.markPinnedMessageDeleted.mockResolvedValue([]);
    mocks.groupMessagePinRepo.softDeletePin.mockResolvedValue({ id: "pin-1" });
  });

  it("retracts the pin system line and rolls the room snapshot back to the previous visible message", async () => {
    const res = await request(app)
      .delete(`${BASE}/messages/${MSG}?type=forEveryone`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(200);
    await settle();

    // Tombstoned by its STORED id, never by matching the rendered text.
    expect(mocks.groupMessageRepo.deleteForEveryone).toHaveBeenCalledWith(
      SYS_PIN,
      ROOM,
      TEST_USER_ID,
      "ADMIN_DELETE"
    );
    const setLast = mocks.groupRoomRepo.setLastMessage.mock.calls.at(-1);
    expect(setLast?.[1]).toMatchObject({ id: PREV });
  });

  it("leaves unrelated pin lines alone when the deleted message has no active pin", async () => {
    mocks.groupMessagePinRepo.findActivePinByMessageId.mockResolvedValue(null);

    const res = await request(app)
      .delete(`${BASE}/messages/${MSG}?type=forEveryone`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(200);
    await settle();

    expect(mocks.groupMessageRepo.deleteForEveryone).not.toHaveBeenCalledWith(
      SYS_PIN,
      ROOM,
      TEST_USER_ID,
      "ADMIN_DELETE"
    );
  });
});
