import { PrivateRoomRepository } from "../../src/repositories/private-room.repository.js";
import { UnreadSummaryService } from "../../src/services/unread-summary.service.js";

/**
 * The nav badge and the Unread tab must count the SAME set. The badge counts
 * the CONVERSATIONS `countUnreadForUser` reports; the tab filters inbox rows
 * on `unreadCount`, which
 * InboxService.toPrivateItem reads as `unreadCountByUser[me]`. These pin that
 * they stay one number under the same visibility rule, and that the chat badge
 * never borrows from (or leaks into) the Community one.
 */
const ME = "me";

interface RoomFixture {
  roomId: string;
  lastMessageAt: Date | null;
  deletedFor: Record<string, unknown>;
  unreadCountByUser: Record<string, number>;
  lastReadMessageIdByUser?: Record<string, string | null>;
  hasUnreadByUser?: Record<string, boolean>;
  /**
   * How many countable unread messages this user actually HAS in the room.
   * `countUnreadForUser` verifies the stored counter against a recount, so a
   * fixture has to say what the messages would report. Defaults to the stored
   * counter (a room in agreement with itself), which is what every assertion
   * about plain summing wants.
   */
  truth?: number;
}

function repoWith(rooms: RoomFixture[]) {
  const stored = new Map(
    rooms.map((r) => [
      r.roomId,
      {
        ...r,
        truth: r.truth ?? (r.unreadCountByUser[ME] ?? 0),
      } as RoomFixture & { truth: number },
    ])
  );
  const prisma = {
    privateRoom: {
      findMany: jest.fn(async () => [...stored.values()]),
      findUnique: jest.fn(
        async ({ where }: { where: { roomId: string } }) =>
          stored.get(where.roomId) ?? null
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { roomId: string };
          data: Record<string, unknown>;
        }) => {
          const row = stored.get(where.roomId)!;
          Object.assign(row, data);
          return row;
        }
      ),
    },
    privateMessage: {
      // No fixture stores a resolvable read pointer, so every recount runs from
      // sequence 0 — the "never read this room" case.
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
      // Two callers, two pipeline shapes: the bulk recount matches `roomId: {$in}`
      // and `$group`s per room; countRemainingUnread matches one roomId and `$count`s.
      aggregateRaw: jest.fn(
        async ({ pipeline }: { pipeline: Array<Record<string, never>> }) => {
          const match = (pipeline[0] as unknown as { $match: Record<string, unknown> })
            .$match;
          const roomId = match.roomId;
          if (typeof roomId === "string") {
            return [{ total: stored.get(roomId)?.truth ?? 0 }];
          }
          return ((roomId as { $in: string[] }).$in ?? [])
            .map((id) => ({ _id: id, total: stored.get(id)?.truth ?? 0 }))
            .filter((r) => r.total > 0);
        }
      ),
    },
  };
  const repo = new PrivateRoomRepository(
    prisma as unknown as ConstructorParameters<typeof PrivateRoomRepository>[0]
  );
  return { repo, prisma, stored };
}

describe("S1/S10 — the badge is the sum of the rows the Unread tab lists", () => {
  it("is 0 when no row carries unread", async () => {
    const { repo } = repoWith([
      {
        roomId: "r1",
        lastMessageAt: new Date("2026-08-21T10:00:00.000Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 0, peer: 4 },
      },
    ]);

    await expect(repo.countUnreadForUser(ME)).resolves.toEqual({
      messages: 0,
      conversations: 0,
    });
  });

  it("sums this user's own bucket across rooms — never the peer's", async () => {
    const { repo } = repoWith([
      {
        roomId: "r1",
        lastMessageAt: new Date("2026-08-21T10:00:00.000Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 2, peer: 9 },
      },
      {
        roomId: "r2",
        lastMessageAt: new Date("2026-08-21T11:00:00.000Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 3 },
      },
    ]);

    await expect(repo.countUnreadForUser(ME)).resolves.toEqual({
      messages: 5,
      conversations: 2,
    });
  });

  it("excludes a room this user deleted for themselves — the list hides that row too", async () => {
    const { repo } = repoWith([
      {
        // Deleted AFTER the last message ⇒ nothing visible ⇒ no row, no badge.
        roomId: "r1",
        lastMessageAt: new Date("2026-08-21T10:00:00.000Z"),
        deletedFor: { [ME]: "2026-08-21T12:00:00.000Z" },
        unreadCountByUser: { [ME]: 7 },
      },
      {
        roomId: "r2",
        lastMessageAt: new Date("2026-08-21T10:00:00.000Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 1 },
      },
    ]);

    await expect(repo.countUnreadForUser(ME)).resolves.toEqual({
      messages: 1,
      conversations: 1,
    });
  });

  it("counts a 50-unread room as ONE conversation", async () => {
    const { repo } = repoWith([
      {
        roomId: "r1",
        lastMessageAt: new Date("2026-08-21T10:00:00.000Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 50 },
      },
    ]);

    await expect(repo.countUnreadForUser(ME)).resolves.toEqual({
      messages: 50,
      conversations: 1,
    });
  });

  it("costs no message query at all when nothing claims unread", async () => {
    const { repo, prisma } = repoWith([
      {
        roomId: "r1",
        lastMessageAt: new Date("2026-08-21T10:00:00.000Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 0 },
      },
    ]);

    await repo.countUnreadForUser(ME);
    expect(prisma.privateMessage.aggregateRaw).not.toHaveBeenCalled();
    expect(prisma.privateRoom.update).not.toHaveBeenCalled();
  });
});

describe("S11 — chat and community badges stay independent", () => {
  it("chatUnread is private + group only; community rides its own field", async () => {
    const service = new UnreadSummaryService(
      {
        countUnreadForUser: jest
          .fn()
          .mockResolvedValue({ messages: 2, conversations: 2 }),
      } as never,
      {
        countUnreadForUser: jest
          .fn()
          .mockResolvedValue({ messages: 1, conversations: 1 }),
      } as never,
      {
        countUnreadForUser: jest
          .fn()
          .mockResolvedValue({ messages: 40, conversations: 3 }),
      } as never
    );

    await expect(service.getUnreadSummary(ME)).resolves.toEqual({
      privateUnread: 2,
      groupUnread: 1,
      communityUnread: 40,
      chatUnread: 3,
      privateUnreadConversations: 2,
      groupUnreadConversations: 1,
      communityUnreadConversations: 3,
      chatUnreadConversations: 3,
    });
  });
});

/**
 * The reported bug: the Chats icon showed a badge with nothing unread anywhere.
 * `unreadCountByUser` is a counter, and the badge used to trust it — so a room
 * whose counter was credited for something no recount classifies as countable
 * unread contributed one unread conversation for good. It could only ever be
 * cleared by opening that specific chat, which is why a reload never helped.
 */
describe("a stored counter with nothing behind it cannot reach the badge", () => {
  it("reports 0 and writes the ghost counter down to 0", async () => {
    const { repo, stored } = repoWith([
      {
        roomId: "ghost",
        lastMessageAt: new Date("2026-07-13T06:35:18.730Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 2 },
        hasUnreadByUser: { [ME]: true },
        // Both messages are non-countable (the invite rows persisted with
        // `countInUnread: false` that produced the reported badge).
        truth: 0,
      },
    ]);

    await expect(repo.countUnreadForUser(ME)).resolves.toEqual({
      messages: 0,
      conversations: 0,
    });
    // Healed in place, so the LIST ROW stops showing it too.
    expect(stored.get("ghost")!.unreadCountByUser[ME]).toBe(0);
    expect(stored.get("ghost")!.hasUnreadByUser![ME]).toBe(false);
  });

  it("stays 0 on a second read and stops writing once healed", async () => {
    const { repo, prisma } = repoWith([
      {
        roomId: "ghost",
        lastMessageAt: new Date("2026-07-13T06:35:18.730Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 2 },
        truth: 0,
      },
    ]);

    await repo.countUnreadForUser(ME);
    const writesAfterHeal = prisma.privateRoom.update.mock.calls.length;
    await expect(repo.countUnreadForUser(ME)).resolves.toEqual({
      messages: 0,
      conversations: 0,
    });
    expect(prisma.privateRoom.update.mock.calls.length).toBe(writesAfterHeal);
  });

  it("drops only the ghost, keeping the rooms that really are unread", async () => {
    const { repo } = repoWith([
      {
        roomId: "ghost",
        lastMessageAt: new Date("2026-07-13T06:35:18.730Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 2 },
        truth: 0,
      },
      {
        roomId: "real",
        lastMessageAt: new Date("2026-09-20T10:00:00.000Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 3 },
      },
    ]);

    await expect(repo.countUnreadForUser(ME)).resolves.toEqual({
      messages: 3,
      conversations: 1,
    });
  });

  it("corrects an inflated counter down to what the messages support", async () => {
    const { repo, stored } = repoWith([
      {
        roomId: "r1",
        lastMessageAt: new Date("2026-09-20T10:00:00.000Z"),
        deletedFor: {},
        unreadCountByUser: { [ME]: 17 },
        truth: 16,
      },
    ]);

    await expect(repo.countUnreadForUser(ME)).resolves.toEqual({
      messages: 16,
      conversations: 1,
    });
    expect(stored.get("r1")!.unreadCountByUser[ME]).toBe(16);
  });

  it("never RAISES a counter — a recount is not bounded by clear-chat", async () => {
    const { repo, stored } = repoWith([
      {
        roomId: "r1",
        lastMessageAt: new Date("2026-09-24T10:00:00.000Z"),
        deletedFor: {},
        // Already decremented for messages this viewer cleared; the recount
        // still sees them, so raising to 4 would resurrect cleared content.
        unreadCountByUser: { [ME]: 2 },
        truth: 4,
      },
    ]);

    await expect(repo.countUnreadForUser(ME)).resolves.toEqual({
      messages: 2,
      conversations: 1,
    });
    expect(stored.get("r1")!.unreadCountByUser[ME]).toBe(2);
  });
});
