/**
 * AIMESS-369: the reaction overlay on the private + group list rows carries a
 * typed `activityKind`/`reaction` beside its preview, and the preview line is
 * rendered in the reader's language (x-lang) instead of the stored English.
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
const T_10_10 = new Date("2026-08-10T10:10:00.000Z");
const REACTED = new Date("2026-08-10T10:12:00.000Z");

const overlay = {
  reactionActivityAt: REACTED,
  reactionActivityMessageId: "m3",
  reactionActivityEmoji: "👍",
  reactionActivityActorId: TEST_USER_ID,
  reactionActivityActorPreview: 'You reacted 👍 to "QA sync test"',
  reactionActivityTargetId: PEER,
  reactionActivityTargetPreview: 'Rajesh reacted 👍 to "QA sync test"',
};

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("reaction overlay on list rows (AIMESS-369)", () => {
  it("PRIVATE: typed reaction fields, preview in the reader's language", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      {
        roomId: "prv_1",
        participants: [TEST_USER_ID, PEER],
        lastMessageAt: T_10_10,
        lastMessageId: "m3",
        lastMessage: {
          content: { text: "QA sync test" },
          senderId: PEER,
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
        ...overlay,
      },
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(1);
    mocks.privateMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());

    const res = await request(app)
      .get("/api/chat/private/conversations")
      .set(bearer(makeAccessToken()))
      .set("x-lang", "vi");

    const last = res.body.data.data[0].lastActivity;
    expect(last.type).toBe("message");
    expect(last.contentType).toBe("SYSTEM");
    expect(last.activityKind).toBe("reaction");
    expect(last.reaction).toEqual({ emoji: "👍", actorId: TEST_USER_ID, targetMessageId: "m3" });
    expect(last.preview).toBe('Bạn đã thả 👍 cho "QA sync test"');
  });

  it("GROUP: the target owner gets the typed line in their language", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(0);
    mockGroupMemberships(mocks, [
      { roomId: "grp_1", role: "MEMBER", status: "ACTIVE", unreadCount: 0, notificationSettings: {} },
    ]);
    mocks.groupMemberRepo.getActiveRoomIds.mockResolvedValue(["grp_1"]);
    mocks.groupRoomRepo.getInboxGroups.mockResolvedValue([
      {
        roomId: "grp_1",
        name: "Devs",
        avatar: "",
        description: "",
        memberCount: 3,
        lastMessageAt: T_10_10,
        lastMessageId: "m3",
        lastMessagePreview: {
          text: "QA sync test",
          senderId: TEST_USER_ID,
          senderName: "Me",
          messageType: "TEXT",
          createdAt: T_10_10,
          messageId: "m3",
          clientMessageId: null,
          seq: 3,
          revision: 3,
        },
        pinnedCount: 0,
        ...overlay,
        reactionActivityActorId: PEER,
        reactionActivityTargetId: TEST_USER_ID,
      },
    ]);
    mocks.groupRoomRepo.countUserGroups.mockResolvedValue(1);
    mocks.groupRoomRepo.findLastMessageAtForRooms.mockResolvedValue([
      { roomId: "grp_1", lastMessageAt: T_10_10 },
    ]);
    mocks.groupMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());

    const res = await request(app)
      .get("/api/chat/inbox")
      .set(bearer(makeAccessToken()))
      .set("x-lang", "vi");

    const last = res.body.data.data[0].lastActivity;
    expect(last.activityKind).toBe("reaction");
    expect(last.reaction).toEqual({ emoji: "👍", actorId: PEER, targetMessageId: "m3" });
    expect(last.preview).toBe('Rajesh đã thả 👍 cho "QA sync test"');
    // A reaction is not conversation activity: the row keeps its own time.
    expect(last.dateTime).toBe(T_10_10.getTime());
  });
});
