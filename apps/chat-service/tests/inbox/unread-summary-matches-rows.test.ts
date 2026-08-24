import { PrivateRoomRepository } from "../../src/repositories/private-room.repository.js";
import { UnreadSummaryService } from "../../src/services/unread-summary.service.js";

/**
 * The nav badge and the Unread tab must count the SAME set. The badge is
 * `sumUnreadForUser`; the tab filters inbox rows on `unreadCount`, which
 * InboxService.toPrivateItem reads as `unreadCountByUser[me]`. These pin that
 * they stay one number under the same visibility rule, and that the chat badge
 * never borrows from (or leaks into) the Community one.
 */
const ME = "me";

function repoWith(rooms: Array<Record<string, unknown>>) {
  const prisma = {
    privateRoom: { findMany: jest.fn().mockResolvedValue(rooms) },
  };
  return new PrivateRoomRepository(
    prisma as unknown as ConstructorParameters<typeof PrivateRoomRepository>[0]
  );
}

describe("S1/S10 — the badge is the sum of the rows the Unread tab lists", () => {
  it("is 0 when no row carries unread", async () => {
    const repo = repoWith([
      {
        lastMessageAt: new Date("2026-08-21T10:00:00.000Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 0, peer: 4 },
      },
    ]);

    await expect(repo.sumUnreadForUser(ME)).resolves.toBe(0);
  });

  it("sums this user's own bucket across rooms — never the peer's", async () => {
    const repo = repoWith([
      {
        lastMessageAt: new Date("2026-08-21T10:00:00.000Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 2, peer: 9 },
      },
      {
        lastMessageAt: new Date("2026-08-21T11:00:00.000Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 3 },
      },
    ]);

    await expect(repo.sumUnreadForUser(ME)).resolves.toBe(5);
  });

  it("excludes a room this user deleted for themselves — the list hides that row too", async () => {
    const repo = repoWith([
      {
        // Deleted AFTER the last message ⇒ nothing visible ⇒ no row, no badge.
        lastMessageAt: new Date("2026-08-21T10:00:00.000Z"),
        deletedFor: { [ME]: "2026-08-21T12:00:00.000Z" },
        unreadCountByUser: { [ME]: 7 },
      },
      {
        lastMessageAt: new Date("2026-08-21T10:00:00.000Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 1 },
      },
    ]);

    await expect(repo.sumUnreadForUser(ME)).resolves.toBe(1);
  });
});

describe("S11 — chat and community badges stay independent", () => {
  it("chatUnread is private + group only; community rides its own field", async () => {
    const service = new UnreadSummaryService(
      { sumUnreadForUser: jest.fn().mockResolvedValue(2) } as never,
      { sumUnreadForUser: jest.fn().mockResolvedValue(1) } as never,
      { sumUnreadForUser: jest.fn().mockResolvedValue(40) } as never
    );

    await expect(service.getUnreadSummary(ME)).resolves.toEqual({
      privateUnread: 2,
      groupUnread: 1,
      communityUnread: 40,
      chatUnread: 3,
    });
  });
});
