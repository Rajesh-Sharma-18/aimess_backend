/**
 * Delete-for-SELF of a PINNED community message must hide the
 * "<actor> pinned a message" SYSTEM line for THAT USER ONLY and roll their own
 * `lastActivity` back to the newest message they can still see.
 *
 * Regression: `unpinAfterDelete`'s forMe branch only announced the pin banner's
 * removal. The pin line — a real room message, and (because PINNED_MESSAGE
 * bumps activity) usually the room's current last one — stayed visible to the
 * deleting user, so their transcript kept announcing a pin they no longer had
 * and their community row kept previewing it, across reloads too because the
 * self-preview overlay was never written.
 *
 * Timeline under test:
 *   msg-prev  ← must become the deleting user's lastActivity
 *   msg-c1    ← pinned, then deleted FOR SELF
 *   sys-pin   ← "pinned a message" line, currently the room's last message
 *
 * The delete is per-user throughout: the pin row is NOT soft-deleted, the
 * system line is NOT tombstoned for everyone, and the shared room snapshot is
 * untouched — every other member keeps message, pin and line.
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
import { publishCommunityUpdatedSafe } from "../../src/events/publish-conv-updated.js";

const reconcileClient = getCommunityReconcileClient as jest.Mock;
const communityUpdated = publishCommunityUpdatedSafe as jest.Mock;
const updateMessageActivity = jest.fn(async () => true);

const ROOM = "room-1";
const MSG = "msg-c1";
const SYS_PIN = "sys-pin";
const PREV = "msg-prev";
const BASE = "/api/chat/community";

// sequenceNumber is the ordering authority: the pin line is NEWER than the
// message it announces, which is exactly why the effective-last decision must
// be made on the line, not on the deleted message.
const PREV_SEQ = 10;
const MSG_SEQ = 11;
const SYS_PIN_SEQ = 12;

let app: import("express").Express;
let mocks: BuiltMocks;

function seedPinnedMessageScenario(opts: { pinned?: boolean } = {}) {
  const pinned = opts.pinned ?? true;
  const hiddenForUser = new Set<string>();

  mocks.generalRoomMessageRepo.findById.mockImplementation(
    async (id: string) => ({
      id,
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      messageType: id === SYS_PIN ? "system" : "text",
      sequenceNumber:
        id === SYS_PIN ? SYS_PIN_SEQ : id === PREV ? PREV_SEQ : MSG_SEQ,
      deletedForAll: false,
      deletedBy: hiddenForUser.has(id) ? [TEST_USER_ID] : [],
      createdAt: new Date(),
    })
  );
  mocks.generalRoomMessageRepo.deleteForUser.mockImplementation(
    async (id: string) => {
      hiddenForUser.add(id);
    }
  );
  mocks.generalRoomRepo.findRoomById.mockResolvedValue({
    id: ROOM,
    status: "active",
    // The pin line is what the room currently previews.
    lastMessageId: SYS_PIN,
  });

  // Answers the way the real per-user query does: the pin line is this user's
  // last visible row until THEY hide it, then the older message is.
  mocks.generalRoomMessageRepo.findPreviousVisibleForUser.mockImplementation(
    async () =>
      hiddenForUser.has(SYS_PIN)
        ? {
            id: PREV,
            sentBy: "sender-2",
            senderName: "Prev Sender",
            message: "older",
            messageType: "text",
            sequenceNumber: PREV_SEQ,
            revision: 1,
            clientMessageId: null,
            createdAt: new Date(),
          }
        : {
            id: SYS_PIN,
            sentBy: "",
            senderName: "",
            message: "pinned a message",
            messageType: "system",
            sequenceNumber: SYS_PIN_SEQ,
            revision: 1,
            clientMessageId: null,
            createdAt: new Date(),
          }
  );

  // The active pin carries the back-reference to its own system line — the
  // ONLY reliable link between the original message and the pin event.
  mocks.communityMessagePinRepo.findActivePinByMessageId.mockResolvedValue(
    pinned
      ? {
          id: "pin-1",
          roomId: ROOM,
          communityId: ROOM,
          messageId: MSG,
          pinSystemMessageId: SYS_PIN,
        }
      : null
  );
  mocks.communityMessagePinRepo.markPinnedMessageDeleted.mockResolvedValue([]);
  mocks.communityMessagePinRepo.softDeletePin.mockResolvedValue({ id: "pin-1" });
}

const deleteForMe = () =>
  request(app)
    .delete(`${BASE}/messages/${MSG}?type=forMe`)
    .set(bearer(makeAccessToken()));

const publishedTo = (channel: string, event: string) =>
  (mocks.redis.publish.mock.calls as Array<[string, string]>).filter(
    ([ch, payload]) =>
      ch === channel && (JSON.parse(payload) as { event: string }).event === event
  );

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

describe("DELETE forMe on a PINNED community message", () => {
  it("hides the pin system line for the deleting user only", async () => {
    seedPinnedMessageScenario();

    const res = await deleteForMe();

    expect(res.status).toBe(200);
    // Per-user hide of the line, addressed by its stored id — never by text.
    expect(mocks.generalRoomMessageRepo.deleteForUser).toHaveBeenCalledWith(
      SYS_PIN,
      TEST_USER_ID
    );
    // ...and NEVER the global retraction: the line survives for everyone else.
    expect(mocks.generalRoomMessageRepo.deleteForAll).not.toHaveBeenCalledWith(
      SYS_PIN,
      expect.anything()
    );
    // The pin row itself is untouched — other members keep the pinned banner.
    expect(mocks.communityMessagePinRepo.softDeletePin).not.toHaveBeenCalled();
  });

  it("tombstones the hidden line on the user's OWN channel, not the community's", async () => {
    seedPinnedMessageScenario();

    await deleteForMe();

    const personal = publishedTo(
      `user:${TEST_USER_ID}`,
      "community:message:deleted"
    );
    expect(personal).toHaveLength(1);
    expect(
      (JSON.parse(personal[0][1]) as { data: Record<string, unknown> }).data
    ).toMatchObject({
      messageId: SYS_PIN,
      roomId: ROOM,
      deleteType: "forMe",
      deletedBy: TEST_USER_ID,
      deletedForEveryone: false,
    });
    // Nothing about the system line reaches the room-wide channel.
    const roomWide = publishedTo(
      `community:${ROOM}`,
      "community:message:deleted"
    ).map(([, p]) => (JSON.parse(p) as { data: { messageId: string } }).data.messageId);
    expect(roomWide).toEqual([MSG]);
  });

  it("rolls the deleting user's lastActivity back to their previous visible message", async () => {
    seedPinnedMessageScenario();

    await deleteForMe();

    // Self-overlay only — the canonical shared lastActivity is NOT rewritten.
    expect(updateMessageActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: ROOM,
        selfUserId: TEST_USER_ID,
        selfPreview: "older",
      })
    );
    const bump = communityUpdated.mock.calls.at(-1)?.[0] as {
      lastMessageId: string;
      deleteRecalc?: boolean;
    };
    expect(bump).toMatchObject({ lastMessageId: PREV, deleteRecalc: true });
  });

  it("leaves an UNPINNED message's delete-for-me untouched", async () => {
    seedPinnedMessageScenario({ pinned: false });

    const res = await deleteForMe();

    expect(res.status).toBe(200);
    expect(mocks.generalRoomMessageRepo.deleteForUser).not.toHaveBeenCalledWith(
      SYS_PIN,
      TEST_USER_ID
    );
    expect(
      publishedTo(`user:${TEST_USER_ID}`, "community:message:deleted")
    ).toHaveLength(0);
  });
});
