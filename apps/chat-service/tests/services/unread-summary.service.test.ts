/**
 * Unit coverage for UnreadSummaryService — the Chats/Community nav-badge
 * aggregate. Pure composition over each module's already-maintained
 * countUnreadForUser(), so mocking those three methods directly (rather than
 * the full DI graph) is enough to pin the combination logic: chatUnread sums
 * MESSAGES, chatUnreadConversations sums CONVERSATIONS (private + group),
 * community stays on its own fields.
 */
import { UnreadSummaryService } from "../../src/services/unread-summary.service.js";

function fakeServices(counts: {
  privateUnread: number;
  groupUnread: number;
  communityUnread: number;
  privateConversations?: number;
  groupConversations?: number;
  communityConversations?: number;
}) {
  const stats = (messages: number, conversations?: number) => ({
    messages,
    conversations: conversations ?? (messages > 0 ? 1 : 0),
  });
  const privateRoomService = {
    countUnreadForUser: jest
      .fn()
      .mockResolvedValue(
        stats(counts.privateUnread, counts.privateConversations)
      ),
  };
  const groupRoomService = {
    countUnreadForUser: jest
      .fn()
      .mockResolvedValue(stats(counts.groupUnread, counts.groupConversations)),
  };
  const communityMessageService = {
    countUnreadForUser: jest
      .fn()
      .mockResolvedValue(
        stats(counts.communityUnread, counts.communityConversations)
      ),
  };
  return { privateRoomService, groupRoomService, communityMessageService };
}

describe("UnreadSummaryService.getUnreadSummary", () => {
  it("combines private + group + community into the badge totals", async () => {
    const { privateRoomService, groupRoomService, communityMessageService } =
      fakeServices({
        privateUnread: 7,
        groupUnread: 5,
        communityUnread: 3,
        privateConversations: 2,
        groupConversations: 1,
        communityConversations: 1,
      });
    const service = new UnreadSummaryService(
      privateRoomService as never,
      groupRoomService as never,
      communityMessageService as never
    );

    const summary = await service.getUnreadSummary("user-1");

    expect(summary).toEqual({
      privateUnread: 7,
      groupUnread: 5,
      communityUnread: 3,
      chatUnread: 12,
      privateUnreadConversations: 2,
      groupUnreadConversations: 1,
      communityUnreadConversations: 1,
      chatUnreadConversations: 3,
    });
    expect(privateRoomService.countUnreadForUser).toHaveBeenCalledWith(
      "user-1"
    );
    expect(groupRoomService.countUnreadForUser).toHaveBeenCalledWith("user-1");
    expect(communityMessageService.countUnreadForUser).toHaveBeenCalledWith(
      "user-1"
    );
  });

  it("returns all zeros — and no badge — when nothing is unread", async () => {
    const { privateRoomService, groupRoomService, communityMessageService } =
      fakeServices({ privateUnread: 0, groupUnread: 0, communityUnread: 0 });
    const service = new UnreadSummaryService(
      privateRoomService as never,
      groupRoomService as never,
      communityMessageService as never
    );

    const summary = await service.getUnreadSummary("user-2");

    expect(summary).toEqual({
      privateUnread: 0,
      groupUnread: 0,
      communityUnread: 0,
      chatUnread: 0,
      privateUnreadConversations: 0,
      groupUnreadConversations: 0,
      communityUnreadConversations: 0,
      chatUnreadConversations: 0,
    });
  });

  it("counts conversations, not messages, for the nav badge", async () => {
    // 100 + 50 unread messages across 2 private rooms and 1 group ⇒ badge 3.
    const { privateRoomService, groupRoomService, communityMessageService } =
      fakeServices({
        privateUnread: 150,
        groupUnread: 25,
        communityUnread: 500,
        privateConversations: 2,
        groupConversations: 1,
        communityConversations: 1,
      });
    const service = new UnreadSummaryService(
      privateRoomService as never,
      groupRoomService as never,
      communityMessageService as never
    );

    expect(await service.getUnreadSummary("user-3")).toMatchObject({
      chatUnread: 175,
      chatUnreadConversations: 3,
      communityUnreadConversations: 1,
    });
  });
});
