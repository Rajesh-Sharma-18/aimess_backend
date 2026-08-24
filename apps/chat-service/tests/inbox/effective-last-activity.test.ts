/**
 * Telegram-style EFFECTIVE (per-viewer) lastActivity on the conversation lists.
 *
 * The room-level `lastMessageAt` is a SHARED snapshot and is what the repository
 * queries page on, so it cannot be rewritten per viewer without breaking the
 * cursor. But after a delete-for-me / clear-chat the list already swaps in a
 * per-viewer PREVIEW — with no matching timestamp. That left a client holding
 * the timestamp of a message it is no longer being shown: the row kept its old
 * position (or stayed pinned to the top with an empty preview) until a reload,
 * and the reload showed the same wrong thing because REST disagreed with the
 * `conv:updated` socket bump that had the right value.
 *
 * `lastActivity` / `lastActivityAt` is that missing per-viewer value. It is now
 * on GROUP rows too (it used to be PRIVATE-only, hardcoded null on the inbox),
 * and `dateTime === 0` means "this viewer has nothing visible left here".
 */
import request from "supertest";

import {
  buildApp,
  mockGroupMemberships,
  type BuiltMocks,
} from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const PEER = "peer-1";
const ROOM = "prv_1";
const GROUP = "grp_1";

/** 10:00 / 10:05 / 10:10 — the scenario from the spec. */
const T_10_00 = new Date("2026-08-10T10:00:00.000Z");
const T_10_05 = new Date("2026-08-10T10:05:00.000Z");
const T_10_10 = new Date("2026-08-10T10:10:00.000Z");

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

/** A private room whose SHARED last message is the 10:10 one. */
function privateRoom(over: Record<string, unknown> = {}) {
  return {
    roomId: ROOM,
    participants: [TEST_USER_ID, PEER],
    lastMessageAt: T_10_10,
    lastMessageId: "m3",
    lastMessage: {
      content: { text: "How are you?" },
      senderId: TEST_USER_ID,
      messageType: "TEXT",
      createdAt: T_10_10.toISOString(),
      messageId: "m3",
      clientMessageId: null,
      seq: 3,
      revision: 3,
    },
    unreadCountByUser: {},
    mutedBy: {},
    pinnedCount: 0,
    ...over,
  };
}

function listPrivate() {
  return request(app)
    .get("/api/chat/private/conversations")
    .set(bearer(makeAccessToken()));
}

describe("PRIVATE conversation list — effective lastActivity", () => {
  it("delete-for-me on the latest message: the row falls back to the 10:05 message, timestamp included", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      privateRoom(),
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(1);
    // The viewer hid the shared last (m3); their previous visible is the 10:05 one.
    mocks.privateMessageRepo.filterHiddenFromUser.mockResolvedValue(
      new Set(["m3"])
    );
    mocks.privateMessageRepo.findPreviousVisibleForUser.mockResolvedValue({
      id: "m2",
      senderId: PEER,
      content: { text: "Hi" },
      messageType: "TEXT",
      createdAt: T_10_05,
      clientMessageId: null,
      sequenceNumber: 2,
      revision: 2,
    });

    const res = await listPrivate();

    expect(res.status).toBe(200);
    const row = res.body.data.data[0];
    expect(row.lastActivity.preview).toBe("Hi");
    // The whole point: the TIMESTAMP moves back with the preview.
    expect(row.lastActivityAt).toBe(T_10_05.getTime());
    expect(row.lastActivity.dateTime).toBe(T_10_05.getTime());
  });

  it("cleared conversation: preview empties AND lastActivityAt drops to 0 instead of inheriting the shared lastMessageAt", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      // Cleared at 10:11 — after the room's only message.
      privateRoom({
        clearFor: { [TEST_USER_ID]: "2026-08-10T10:11:00.000Z" },
      }),
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(1);
    mocks.privateMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());

    const res = await listPrivate();

    expect(res.status).toBe(200);
    const row = res.body.data.data[0];
    expect(row.lastActivity.preview).toBe("");
    expect(row.lastActivityAt).toBe(0);
  });

  it("REGRESSION: a reaction overlay from BEFORE the clear does not resurrect the emptied row", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      privateRoom({
        clearFor: { [TEST_USER_ID]: "2026-08-10T10:11:00.000Z" },
        // The viewer reacted at 10:09 — before their 10:11 clear.
        reactionActivityAt: new Date("2026-08-10T10:09:00.000Z"),
        reactionActivityMessageId: "m3",
        reactionActivityEmoji: "🔥",
        reactionActivityActorId: TEST_USER_ID,
        reactionActivityActorPreview: 'You reacted 🔥 to "How are you?"',
        reactionActivityTargetId: PEER,
        reactionActivityTargetPreview: 'reacted 🔥 to "How are you?"',
      }),
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(1);
    mocks.privateMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());

    const res = await listPrivate();

    expect(res.status).toBe(200);
    const row = res.body.data.data[0];
    expect(row.lastActivity.preview).toBe("");
    expect(row.lastActivity.dateTime).toBe(0);
    expect(row.lastActivityAt).toBe(0);
  });

  it("a reaction made AFTER the clear still previews, but never advances the row's timestamp", async () => {
    const reactedAt = new Date("2026-08-10T10:12:00.000Z");
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      privateRoom({
        clearFor: { [TEST_USER_ID]: "2026-08-10T10:11:00.000Z" },
        reactionActivityAt: reactedAt,
        reactionActivityMessageId: "m3",
        reactionActivityEmoji: "🔥",
        reactionActivityActorId: TEST_USER_ID,
        reactionActivityActorPreview: 'You reacted 🔥 to "How are you?"',
        reactionActivityTargetId: PEER,
        reactionActivityTargetPreview: 'reacted 🔥 to "How are you?"',
      }),
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(1);
    mocks.privateMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());

    const res = await listPrivate();

    const row = res.body.data.data[0];
    expect(row.lastActivity.preview).toBe('You reacted 🔥 to "How are you?"');
    // The overlay replaces the PREVIEW TEXT and nothing else. `dateTime` is what
    // the inbox exposes as `lastActivityAt` and what both the server and the
    // client order the list by, so a reaction — which is not conversation
    // activity — must leave it exactly where it was. Here the viewer cleared the
    // chat, so "where it was" is 0.
    expect(row.lastActivity.dateTime).toBe(0);
    expect(reactedAt.getTime()).toBeGreaterThan(0);
  });

  it("viewer hid EVERY message: lastActivityAt 0, empty preview", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      privateRoom(),
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(1);
    mocks.privateMessageRepo.filterHiddenFromUser.mockResolvedValue(
      new Set(["m3"])
    );
    mocks.privateMessageRepo.findPreviousVisibleForUser.mockResolvedValue(null);

    const res = await listPrivate();

    expect(res.status).toBe(200);
    expect(res.body.data.data[0].lastActivityAt).toBe(0);
    expect(res.body.data.data[0].lastActivity.preview).toBe("");
  });

  it("REGRESSION: a legacy row with no stored lastMessage JSON still reports the shared lastMessageAt", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      privateRoom({ lastMessage: null }),
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(1);
    mocks.privateMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());

    const res = await listPrivate();

    expect(res.body.data.data[0].lastActivityAt).toBe(T_10_10.getTime());
  });
});

/** A group room whose SHARED last message is the 10:10 one. */
function groupRoom(over: Record<string, unknown> = {}) {
  return {
    roomId: GROUP,
    name: "Devs",
    avatar: "",
    description: "",
    memberCount: 3,
    lastMessageAt: T_10_10,
    lastMessageId: "g3",
    lastMessagePreview: {
      text: "Message 3",
      senderId: "member-c",
      senderName: "C",
      messageType: "TEXT",
      createdAt: T_10_10,
      messageId: "g3",
      clientMessageId: null,
      seq: 3,
      revision: 3,
    },
    pinnedCount: 0,
    ...over,
  };
}

function mockGroupSide(rooms: unknown[], membership: Record<string, unknown>) {
  mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([]);
  mocks.privateRoomRepo.countConversations.mockResolvedValue(0);
  mockGroupMemberships(mocks, [
    { roomId: GROUP, role: "MEMBER", status: "ACTIVE", ...membership },
  ]);
  mocks.groupMemberRepo.getActiveRoomIds.mockResolvedValue([GROUP]);
  mocks.groupRoomRepo.getInboxGroups.mockResolvedValue(rooms);
  mocks.groupRoomRepo.countUserGroups.mockResolvedValue(rooms.length);
  mocks.groupRoomRepo.findLastMessageAtForRooms.mockResolvedValue(
    rooms.map(() => ({ roomId: GROUP, lastMessageAt: T_10_10 }))
  );
}

function inbox(query = "") {
  return request(app)
    .get(`/api/chat/inbox${query}`)
    .set(bearer(makeAccessToken()));
}

describe("GROUP inbox rows — effective lastActivity", () => {
  it("carries lastActivity at all (it used to be hardcoded null for GROUP)", async () => {
    mockGroupSide([groupRoom()], { unreadCount: 0, notificationSettings: {} });
    mocks.groupMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());

    const res = await inbox();

    expect(res.status).toBe(200);
    const row = res.body.data.data[0];
    expect(row.type).toBe("GROUP");
    expect(row.lastActivity).toMatchObject({
      preview: "Message 3",
      dateTime: T_10_10.getTime(),
      contentType: "TEXT",
    });
  });

  it("delete-for-me on the group's latest message: activity falls back to 10:05 for THIS member only", async () => {
    mockGroupSide([groupRoom()], { unreadCount: 0, notificationSettings: {} });
    mocks.groupMessageRepo.filterHiddenFromUser.mockResolvedValue(
      new Set(["g3"])
    );
    mocks.groupMessageRepo.findPreviousVisibleForUser.mockResolvedValue({
      id: "g2",
      senderId: "member-b",
      senderName: "B",
      content: { text: "Message 2" },
      messageType: "TEXT",
      createdAt: T_10_05,
      clientMessageId: null,
      sequenceNumber: 2,
      revision: 2,
    });

    const res = await inbox();

    const row = res.body.data.data[0];
    expect(row.lastActivity.preview).toBe("Message 2");
    expect(row.lastActivity.dateTime).toBe(T_10_05.getTime());
  });

  it("clear-chat: preview empties AND the effective timestamp drops to 0", async () => {
    mockGroupSide([groupRoom()], {
      unreadCount: 0,
      notificationSettings: {},
      clearChatAt: new Date("2026-08-10T10:11:00.000Z"),
    });
    mocks.groupMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());

    const res = await inbox();

    const row = res.body.data.data[0];
    expect(row.lastMessage).toBeNull();
    expect(row.lastActivity.dateTime).toBe(0);
    expect(row.lastActivity.preview).toBe("");
  });

  it("REGRESSION: a legacy row with no stored lastMessagePreview still reports the shared lastMessageAt", async () => {
    mockGroupSide([groupRoom({ lastMessagePreview: null })], {
      unreadCount: 0,
      notificationSettings: {},
    });
    mocks.groupMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());

    const res = await inbox();

    expect(res.body.data.data[0].lastActivity.dateTime).toBe(T_10_10.getTime());
  });
});

/**
 * The inbox DTO used to publish only `lastMessageAt` (the shared snapshot) as a
 * top-level timestamp, even though `lastActivity.dateTime` right next to it was
 * the per-viewer one. Clients rendered the top-level field, so a group row
 * showed the shared time beside its per-viewer preview: "2:12 PM" next to a
 * preview of yesterday's message. `lastActivityAt` is the epoch-ms mirror that
 * closes that gap — it must always equal `lastActivity.dateTime`.
 */
describe("Inbox rows carry lastActivityAt (the per-viewer render/sort key)", () => {
  it("GROUP: mirrors lastActivity.dateTime, NOT the shared lastMessageAt, after a delete-for-me", async () => {
    mockGroupSide([groupRoom()], { unreadCount: 0, notificationSettings: {} });
    mocks.groupMessageRepo.filterHiddenFromUser.mockResolvedValue(
      new Set(["g3"])
    );
    mocks.groupMessageRepo.findPreviousVisibleForUser.mockResolvedValue({
      id: "g2",
      senderId: "member-b",
      senderName: "B",
      content: { text: "Message 2" },
      messageType: "TEXT",
      createdAt: T_10_05,
      clientMessageId: null,
      sequenceNumber: 2,
      revision: 2,
    });

    const res = await inbox();

    const row = res.body.data.data[0];
    expect(row.lastActivityAt).toBe(T_10_05.getTime());
    expect(row.lastActivityAt).toBe(row.lastActivity.dateTime);
    // The shared snapshot is still the newer one — that is the whole point.
    expect(row.lastMessageAt).toBe(T_10_10.getTime());
  });

  it("GROUP: 0 when the viewer cleared the chat (never falls back to lastMessageAt)", async () => {
    mockGroupSide([groupRoom()], {
      unreadCount: 0,
      notificationSettings: {},
      clearChatAt: new Date("2026-08-10T10:11:00.000Z"),
    });
    mocks.groupMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());

    const res = await inbox();

    expect(res.body.data.data[0].lastActivityAt).toBe(0);
  });

  it("PRIVATE: mirrors lastActivity.dateTime", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      privateRoom(),
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(1);
    mocks.privateMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());
    mocks.privateMessageRepo.findManyByIds.mockResolvedValue([]);
    mockGroupMemberships(mocks, []);
    mocks.groupMemberRepo.getActiveRoomIds.mockResolvedValue([]);
    mocks.groupRoomRepo.getInboxGroups.mockResolvedValue([]);
    mocks.groupRoomRepo.countUserGroups.mockResolvedValue(0);

    const res = await inbox();

    const row = res.body.data.data[0];
    expect(row.type).toBe("PRIVATE");
    expect(row.lastActivityAt).toBe(row.lastActivity.dateTime);
    expect(row.lastActivityAt).toBe(T_10_10.getTime());
  });
});

describe("Unified inbox ordering", () => {
  it("orders by the EFFECTIVE timestamp: a room whose latest message the viewer deleted drops below a newer one", async () => {
    // Private room's shared last is 10:10 (newest) but the viewer hid it and
    // their previous visible is 10:00 — so it must sort BELOW the 10:05 group.
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      privateRoom(),
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(1);
    mocks.privateMessageRepo.filterHiddenFromUser.mockResolvedValue(
      new Set(["m3"])
    );
    mocks.privateMessageRepo.findPreviousVisibleForUser.mockResolvedValue({
      id: "m1",
      senderId: PEER,
      content: { text: "Hello" },
      messageType: "TEXT",
      createdAt: T_10_00,
      clientMessageId: null,
      sequenceNumber: 1,
      revision: 1,
    });

    mockGroupMemberships(mocks, [
      {
        roomId: GROUP,
        role: "MEMBER",
        status: "ACTIVE",
        unreadCount: 0,
        notificationSettings: {},
      },
    ]);
    mocks.groupMemberRepo.getActiveRoomIds.mockResolvedValue([GROUP]);
    mocks.groupRoomRepo.getInboxGroups.mockResolvedValue([
      groupRoom({
        lastMessageAt: T_10_05,
        lastMessageId: "g2",
        lastMessagePreview: {
          text: "Message 2",
          senderId: "member-b",
          senderName: "B",
          messageType: "TEXT",
          createdAt: T_10_05,
          messageId: "g2",
          clientMessageId: null,
          seq: 2,
          revision: 2,
        },
      }),
    ]);
    mocks.groupRoomRepo.countUserGroups.mockResolvedValue(1);
    mocks.groupRoomRepo.findLastMessageAtForRooms.mockResolvedValue([
      { roomId: GROUP, lastMessageAt: T_10_05 },
    ]);
    mocks.groupMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());

    const res = await inbox();

    const items = res.body.data.data;
    expect(items.map((i: { roomId: string }) => i.roomId)).toEqual([
      GROUP,
      ROOM,
    ]);
  });

  it("the page cursor stays on the SHARED timestamp, so re-sorting can never skip an unseen row", async () => {
    // One private row whose effective activity is 10:00 while its shared
    // snapshot is 10:10; hasMore is forced by asking for limit=1 with 2 rows.
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      privateRoom(),
      privateRoom({ roomId: "prv_2", lastMessageAt: T_10_05 }),
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(2);
    mocks.privateMessageRepo.filterHiddenFromUser.mockResolvedValue(
      new Set(["m3"])
    );
    mocks.privateMessageRepo.findPreviousVisibleForUser.mockResolvedValue({
      id: "m1",
      senderId: PEER,
      content: { text: "Hello" },
      messageType: "TEXT",
      createdAt: T_10_00,
      clientMessageId: null,
      sequenceNumber: 1,
      revision: 1,
    });
    mockGroupMemberships(mocks, []);
    mocks.groupMemberRepo.getActiveRoomIds.mockResolvedValue([]);
    mocks.groupRoomRepo.countUserGroups.mockResolvedValue(0);

    const res = await inbox("?limit=1");

    expect(res.body.data.pagination.hasMore).toBe(true);
    // AUDIT-111 — the cursor is the compound "<ms>_<roomId>" token on every
    // page now, so a client echoing it back always carries the tiebreaker.
    const [ms, boundaryRoomId] = String(
      res.body.data.pagination.nextCursor
    ).split(/_(.*)/s);
    // NOT 10:00 (the effective value) — that would jump the next page's bound
    // past the 10:05 row that was never returned.
    expect(Number(ms)).toBe(T_10_10.getTime());
    expect(boundaryRoomId).toBe("prv_1");
  });
});

// The clear → conv:updated bump is asserted in ./clear-conversation-bump.test.ts,
// which has to jest.mock the publisher module (publishConvUpdated writes through
// a redis PIPELINE, which the shared redis test double does not implement).
