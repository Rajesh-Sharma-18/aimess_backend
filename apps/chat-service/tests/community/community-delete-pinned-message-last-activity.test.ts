/**
 * Delete-for-everyone of a PINNED community message must also remove the
 * "<actor> pinned a message" SYSTEM line AND leave `lastActivity` pointing at
 * the newest message that is still visible.
 *
 * Regression: the pin hook (`unpinAfterDelete`, which retracts that system
 * line) used to run detached (`void ...`) and AFTER the lastActivity
 * recalculation. The recalc therefore re-pinned the room snapshot to the pin
 * line milliseconds before that line was tombstoned, so every community list
 * kept previewing a message that no longer existed — and a reload returned the
 * same stale row, because the DB snapshot itself was wrong.
 *
 * Timeline under test (the ticket's Scenario 1):
 *   msg-prev  ← must become lastActivity
 *   msg-c1    ← pinned, then deleted for everyone
 *   sys-pin   ← "pinned a message" line, currently the room's last message
 */

// All jest.mock() hoisting must happen before any imports.
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));
jest.mock("../../src/grpc/community.client.js", () => ({
  getCommunityReconcileClient: jest.fn(() => ({
    listCommunities: jest.fn(async () => ({
      communities: [],
      nextAfterId: "",
      hasMore: false,
    })),
    updateReactionActivity: jest.fn(async () => true),
    updateMessageActivity: jest.fn(async () => true),
  })),
}));

import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { getCommunityReconcileClient } from "../../src/grpc/community.client.js";

const reconcileClient = getCommunityReconcileClient as jest.Mock;
const updateMessageActivity = jest.fn(async () => true);

const ROOM = "room-1";
const MSG = "msg-c1";
const SYS_PIN = "sys-pin";
const PREV = "msg-prev";
const BASE = "/api/chat/community";

let app: import("express").Express;
let mocks: BuiltMocks;

/**
 * Wires the repo mocks so that the pin line is the room's last message until it
 * is tombstoned — i.e. "previous visible" answers the way the real query does,
 * which is what makes the ORDER of retraction vs. recalculation observable.
 */
function seedPinnedMessageScenario() {
  let sysPinDeleted = false;

  mocks.generalRoomMessageRepo.findById.mockImplementation(
    async (id: string) => ({
      id,
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      messageType: "text",
      deletedForAll: false,
    })
  );
  mocks.generalRoomMessageRepo.deleteForAll.mockImplementation(
    async (id: string) => {
      if (id === SYS_PIN) sysPinDeleted = true;
      return { id, roomId: ROOM, createdAt: new Date() };
    }
  );
  mocks.generalRoomRepo.findRoomById.mockResolvedValue({
    id: ROOM,
    status: "active",
    // The pin line is what the room currently previews.
    lastMessageId: SYS_PIN,
  });
  mocks.generalRoomMessageRepo.findPreviousVisibleMessage.mockImplementation(
    async () =>
      sysPinDeleted
        ? {
            id: PREV,
            sentBy: "sender-2",
            senderName: "Prev Sender",
            message: "older",
            messageType: "text",
            createdAt: new Date(),
          }
        : {
            id: SYS_PIN,
            sentBy: "",
            senderName: "",
            message: "pinned a message",
            messageType: "system",
            createdAt: new Date(),
          }
  );

  // The active pin carries the back-reference to its own system line — the
  // ONLY reliable link between the original message and the pin event.
  mocks.communityMessagePinRepo.findActivePinByMessageId.mockResolvedValue({
    id: "pin-1",
    roomId: ROOM,
    communityId: ROOM,
    messageId: MSG,
    pinSystemMessageId: SYS_PIN,
  });
  mocks.communityMessagePinRepo.markPinnedMessageDeleted.mockResolvedValue([]);
  mocks.communityMessagePinRepo.softDeletePin.mockResolvedValue({
    id: "pin-1",
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  updateMessageActivity.mockClear().mockResolvedValue(true);
  reconcileClient.mockReturnValue({
    listCommunities: jest.fn(),
    updateReactionActivity: jest.fn(async () => true),
    updateMessageActivity,
  });
  ({ app, mocks } = buildApp());
  mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
    status: "active",
    role: "admin",
  });
});

describe("DELETE forEveryone on a PINNED community message", () => {
  it("retracts the pin system line and rolls lastActivity back to the previous visible message", async () => {
    seedPinnedMessageScenario();

    const res = await request(app)
      .delete(`${BASE}/messages/${MSG}?type=forEveryone`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);

    // 1. The pin system line is tombstoned — by its stored id, never by text.
    expect(mocks.generalRoomMessageRepo.deleteForAll).toHaveBeenCalledWith(
      SYS_PIN,
      expect.anything()
    );

    // 2. The persisted room snapshot points at the previous VISIBLE message,
    //    not at the retracted pin line.
    const setLast = mocks.generalRoomRepo.setLastMessage.mock.calls.at(-1);
    expect(setLast?.[1]).toMatchObject({ id: PREV });

    // 3. community-service's canonical lastActivity agrees.
    expect(updateMessageActivity).toHaveBeenCalledWith(
      expect.objectContaining({ communityId: ROOM, lastMessageId: PREV })
    );
    expect(updateMessageActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ lastMessageId: SYS_PIN })
    );
  });

  it("leaves an UNRELATED message's pin line alone (only the deleted message's pin is cleared)", async () => {
    seedPinnedMessageScenario();
    // This message has no active pin of its own — Scenario 3: deleting B must
    // not touch the pin lines of A and C.
    mocks.communityMessagePinRepo.findActivePinByMessageId.mockResolvedValue(
      null
    );

    const res = await request(app)
      .delete(`${BASE}/messages/${MSG}?type=forEveryone`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.generalRoomMessageRepo.deleteForAll).not.toHaveBeenCalledWith(
      SYS_PIN,
      expect.anything()
    );
  });
});
