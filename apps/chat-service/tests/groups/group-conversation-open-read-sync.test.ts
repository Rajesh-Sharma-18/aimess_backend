/**
 * Opening a group transcript (GET .../conversation) advances the read pointer
 * and zeroes the stored unread counter. It must also push the nav badge and
 * `read_sync` to the reader's other devices — otherwise the list re-fetches 0
 * while the badge keeps the pre-read total.
 */
jest.mock("../../src/events/unread-summary-bridge.js", () => ({
  notifyUnreadChanged: jest.fn(),
}));
jest.mock("../../src/lib/account-chat-settings.js", () => ({
  mayBroadcastReadReceipts: jest.fn().mockResolvedValue(true),
}));

import { GroupMessageService } from "../../src/services/group-message.service.js";
import { notifyUnreadChanged } from "../../src/events/unread-summary-bridge.js";

const ROOM = "grp_room_1";
const ME = "user_me";
const newest = {
  id: "665f00000000000000000001",
  createdAt: new Date("2026-09-01T10:00:00.000Z"),
  sequenceNumber: 42,
};

function makeService(member: { unreadCount: number }, afterUnread: number) {
  const redis = { publish: jest.fn().mockResolvedValue(1) };
  const memberRepo = {
    findActiveByRoomAndUser: jest.fn().mockResolvedValue({
      roomId: ROOM,
      userId: ME,
      clearedAt: null,
      clearChatAt: null,
      ...member,
    }),
    advanceReadPointer: jest
      .fn()
      .mockResolvedValue({ unreadCount: afterUnread }),
  };
  const messageRepo = {
    listConversationMessages: jest.fn().mockResolvedValue([newest]),
    countConversation: jest.fn().mockResolvedValue(1),
    countUnreadAfter: jest.fn().mockResolvedValue(afterUnread),
  };
  const service = new GroupMessageService(
    messageRepo as any,
    {} as any,
    memberRepo as any,
    {} as any,
    {} as any,
    undefined,
    redis as any
  );
  return { service, redis };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("GroupMessageService.getConversation — implicit read sync", () => {
  beforeEach(() => (notifyUnreadChanged as jest.Mock).mockClear());

  it("unread dropped: pushes the badge and read_sync with the remaining count", async () => {
    const { service, redis } = makeService({ unreadCount: 7 }, 0);
    await service.getConversation({
      roomId: ROOM,
      userId: ME,
      pageNumber: 1,
      limit: 20,
    });
    await flush();

    expect(notifyUnreadChanged).toHaveBeenCalledWith(ME);
    expect(redis.publish).toHaveBeenCalledWith(
      `user:${ME}`,
      JSON.stringify({
        event: "read_sync",
        data: {
          conversationId: ROOM,
          readerId: ME,
          read_to_seq: 42,
          unreadCount: 0,
          conversationType: "GROUP",
        },
      })
    );
  });

  it("nothing changed (already read): no badge push, no read_sync", async () => {
    const { service, redis } = makeService({ unreadCount: 0 }, 0);
    await service.getConversation({
      roomId: ROOM,
      userId: ME,
      pageNumber: 1,
      limit: 20,
    });
    await flush();

    expect(notifyUnreadChanged).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });
});
