/**
 * Unit coverage for UnreadSummaryService — the Chats/Community nav-badge
 * aggregate. Pure composition over each module's already-maintained
 * sumUnreadForUser(), so mocking those three methods directly (rather than
 * the full DI graph) is enough to pin the combination logic:
 *   chatUnread = privateUnread + groupUnread (community stays separate).
 */
import { UnreadSummaryService } from "../../src/services/unread-summary.service.js";

function fakeServices(counts: {
  privateUnread: number;
  groupUnread: number;
  communityUnread: number;
}) {
  const privateRoomService = {
    sumUnreadForUser: jest.fn().mockResolvedValue(counts.privateUnread),
  };
  const groupRoomService = {
    sumUnreadForUser: jest.fn().mockResolvedValue(counts.groupUnread),
  };
  const communityMessageService = {
    sumUnreadForUser: jest.fn().mockResolvedValue(counts.communityUnread),
  };
  return { privateRoomService, groupRoomService, communityMessageService };
}

describe("UnreadSummaryService.getUnreadSummary", () => {
  it("combines private + group + community into the badge totals", async () => {
    const { privateRoomService, groupRoomService, communityMessageService } =
      fakeServices({ privateUnread: 7, groupUnread: 5, communityUnread: 3 });
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
    });
    expect(privateRoomService.sumUnreadForUser).toHaveBeenCalledWith("user-1");
    expect(groupRoomService.sumUnreadForUser).toHaveBeenCalledWith("user-1");
    expect(communityMessageService.sumUnreadForUser).toHaveBeenCalledWith(
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
    });
  });

  it("sums private-only and group-only unread correctly into chatUnread", async () => {
    const { privateRoomService, groupRoomService, communityMessageService } =
      fakeServices({ privateUnread: 4, groupUnread: 0, communityUnread: 0 });
    const service = new UnreadSummaryService(
      privateRoomService as never,
      groupRoomService as never,
      communityMessageService as never
    );

    expect(await service.getUnreadSummary("user-3")).toMatchObject({
      chatUnread: 4,
    });
  });
});
