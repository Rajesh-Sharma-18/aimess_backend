/**
 * Private Delete Conversation hides the room from the DELETER's list until a
 * message newer than their delete arrives (Telegram-style) — on every list
 * query, so a reload cannot bring it back. The peer never sees a difference,
 * and a page full of hidden rows refills instead of reading as "no more".
 */
import { PrivateRoomRepository } from "../../src/repositories/private-room.repository.js";

const ME = "user-a";
const PEER = "user-b";
const DELETED_AT = "2026-09-29T10:00:00.000Z";

function room(id: string, lastIso: string, deletedFor = {}) {
  return {
    roomId: id,
    participants: [ME, PEER],
    lastMessageAt: new Date(lastIso),
    deletedFor,
  };
}

// Newest first, as the inbox query orders them.
const ROOMS = [
  room("r-new-after-delete", "2026-09-29T11:00:00.000Z", {
    [ME]: DELETED_AT,
  }),
  room("r-deleted-1", "2026-09-29T09:00:00.000Z", { [ME]: DELETED_AT }),
  room("r-deleted-2", "2026-09-29T08:00:00.000Z", { [ME]: DELETED_AT }),
  room("r-plain", "2026-09-29T07:00:00.000Z"),
  room("r-peer-deleted", "2026-09-29T06:00:00.000Z", { [PEER]: DELETED_AT }),
];

function makeRepo() {
  const findMany = jest.fn(
    async (args: {
      where: { lastMessageAt?: { lt?: Date }; OR?: unknown[] };
      take?: number;
      select?: unknown;
    }) => {
      // Enough of the keyset to page: strictly older than the boundary.
      const lt =
        args.where.lastMessageAt?.lt ??
        (args.where.OR?.[0] as { lastMessageAt?: { lt?: Date } } | undefined)
          ?.lastMessageAt?.lt;
      const rows = ROOMS.filter((r) => !lt || r.lastMessageAt < lt);
      return args.take ? rows.slice(0, args.take) : rows;
    }
  );
  const repo = new PrivateRoomRepository({
    privateRoom: { findMany },
  } as unknown as ConstructorParameters<typeof PrivateRoomRepository>[0]);
  return { repo, findMany };
}

describe("private Delete Conversation hides the row for the deleter only", () => {
  it("inbox: hides deleted rooms, keeps one with a newer message, refills the page", async () => {
    const { repo, findMany } = makeRepo();
    const rows = await repo.getInboxConversations({
      userId: ME,
      direction: "before",
      ts: new Date("2026-09-30T00:00:00.000Z"),
      limit: 2,
    });
    expect(rows.map((r) => r.roomId)).toEqual([
      "r-new-after-delete",
      "r-plain",
    ]);
    // The first batch had only one visible row, so it paged on.
    expect(findMany.mock.calls.length).toBeGreaterThan(1);
  });

  it("peer: the same rooms all stay listed", async () => {
    const { repo } = makeRepo();
    const rows = await repo.getInboxConversations({
      userId: PEER,
      direction: "before",
      ts: new Date("2026-09-30T00:00:00.000Z"),
      limit: 10,
    });
    expect(rows.map((r) => r.roomId)).toEqual([
      "r-new-after-delete",
      "r-deleted-1",
      "r-deleted-2",
      "r-plain",
    ]);
  });

  it("legacy list and total agree with the inbox", async () => {
    const { repo } = makeRepo();
    const rows = await repo.getConversationList({ userId: ME, limit: 10 });
    expect(rows.map((r) => r.roomId)).toEqual([
      "r-new-after-delete",
      "r-plain",
      "r-peer-deleted",
    ]);
    expect(await repo.countConversations(ME)).toBe(3);
    expect(await repo.countConversations(PEER)).toBe(4);
  });
});
