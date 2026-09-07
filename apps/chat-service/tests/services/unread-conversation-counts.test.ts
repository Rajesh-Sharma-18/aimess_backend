/**
 * The nav badge counts CONVERSATIONS, so each surface's countUnreadForUser
 * must report a room with many unread messages as ONE conversation, and skip
 * rooms whose count is 0 entirely.
 */
import { GroupRoomService } from "../../src/services/group-room.service.js";
import { CommunityMessageService } from "../../src/services/community-message.service.js";

describe("countUnreadForUser — messages vs conversations", () => {
  it("groups: 100 + 25 unread across two rooms is 2 conversations", async () => {
    const memberRepo = {
      getActiveMemberships: jest.fn().mockResolvedValue([
        { roomId: "g1", clearedAt: null, unreadCount: 100 },
        { roomId: "g2", clearedAt: null, unreadCount: 25 },
        { roomId: "g3", clearedAt: null, unreadCount: 0 },
      ]),
    };
    const roomRepo = {
      findLastMessageAtForRooms: jest.fn().mockResolvedValue([
        { roomId: "g1", lastMessageAt: new Date("2026-09-01T10:00:00.000Z") },
        { roomId: "g2", lastMessageAt: new Date("2026-09-01T11:00:00.000Z") },
        { roomId: "g3", lastMessageAt: new Date("2026-09-01T12:00:00.000Z") },
      ]),
    };
    const service = new GroupRoomService(
      roomRepo as never,
      memberRepo as never,
      null as never,
      null as never,
      null as never,
      null as never
    );

    await expect(service.countUnreadForUser("me")).resolves.toEqual({
      messages: 125,
      conversations: 2,
    });
  });

  it("groups: no memberships is all zeros", async () => {
    const service = new GroupRoomService(
      { findLastMessageAtForRooms: jest.fn() } as never,
      { getActiveMemberships: jest.fn().mockResolvedValue([]) } as never,
      null as never,
      null as never,
      null as never,
      null as never
    );

    await expect(service.countUnreadForUser("me")).resolves.toEqual({
      messages: 0,
      conversations: 0,
    });
  });

  it("communities: 500 unread in one community is 1 conversation", async () => {
    const memberRepo = {
      findActiveByUser: jest
        .fn()
        .mockResolvedValue([
          { roomId: "c1", lastReadAt: null },
          { roomId: "c2", lastReadAt: null },
        ]),
    };
    const messageRepo = {
      countUnreadBulk: jest.fn().mockResolvedValue({
        c1: { count: 500, firstUnreadMessageId: "m1" },
        c2: { count: 0, firstUnreadMessageId: "" },
      }),
    };
    const service = new CommunityMessageService(
      messageRepo as never,
      null as never,
      memberRepo as never,
      null as never,
      null as never
    );

    await expect(service.countUnreadForUser("me")).resolves.toEqual({
      messages: 500,
      conversations: 1,
    });
  });
});
