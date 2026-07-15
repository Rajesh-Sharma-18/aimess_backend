/**
 * ZERO-LOSS CHANGES FEED — `findByRoomIdRevisionSince` + `getRoomRevision`.
 *
 * The `revision` axis is what closes MUTATION-loss that Cursor V2's `after_seq`
 * (inserts only) can't: an edit / reaction / delete-for-all on an OLD message
 * bumps that row's `revision` to the room's newest, so a `revision > since` query
 * returns its CURRENT state even though its `sequenceNumber` never moved.
 *
 * These tests run the REAL `GeneralRoomMessageRepository` against a faithful
 * in-memory emulator of the exact `findMany` / `aggregateRaw` / `generalRoom
 * .findUnique` calls the revision methods emit, and assert: an offline client
 * synced to revision N receives every INSERT and MUTATION after N (tombstones
 * included), ordered revision ASC, exactly once, with an exact `hasMore` and a
 * correct `nextRevision` high-water — while `sequenceNumber` stays immutable.
 */
import { GeneralRoomMessageRepository } from "../../src/repositories/general-room-message.repository.js";

const ROOM = "a".repeat(24);
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

type Doc = {
  _id: string;
  roomId: string;
  createdAt: Date;
  sequenceNumber: number;
  revision: number;
  deletedForAll: boolean;
  deletedBy: string[];
  visibleToUserId: string | null;
  systemMessageType: string | null;
  messageType: string;
  message: string;
  sentBy: string;
};

/** In-memory room state: each message is ONE row carrying its CURRENT revision. */
function makeFakePrisma(store: Doc[], lastRevision: () => number) {
  const findMany = jest.fn(
    async ({
      where,
      orderBy,
      take,
    }: {
      where: {
        roomId?: string;
        revision?: { gt?: number };
        createdAt?: { lte?: Date };
      };
      orderBy?: { revision?: "asc" | "desc" };
      take?: number;
    }) => {
      let rows = store.filter((d) => {
        if (where.roomId && d.roomId !== where.roomId) return false;
        if (where.revision?.gt != null && !(d.revision > where.revision.gt))
          return false;
        if (
          where.createdAt?.lte != null &&
          !(d.createdAt.getTime() <= where.createdAt.lte.getTime())
        )
          return false;
        // deletedForAll intentionally NOT filtered — tombstones must replay.
        return true;
      });
      if (orderBy?.revision) {
        const dir = orderBy.revision === "asc" ? 1 : -1;
        rows = [...rows].sort((a, b) => (a.revision - b.revision) * dir);
      }
      if (take != null) rows = rows.slice(0, take);
      return rows.map((d) => ({ ...d, id: d._id }));
    }
  );

  // findLatestPersonalJoinMessageId → no personal-join rows in these tests.
  const aggregateRaw = jest.fn(async () => [] as unknown[]);

  const generalRoom = {
    findUnique: jest.fn(async () => ({ lastRevision: lastRevision() })),
  };

  return { generalRoomMessage: { findMany, aggregateRaw }, generalRoom };
}

function mk(i: number, over: Partial<Doc>): Doc {
  return {
    _id: String(i).padStart(24, "0"),
    roomId: ROOM,
    createdAt: new Date(1_700_000_000_000 + i * 1000),
    sequenceNumber: i,
    revision: i,
    deletedForAll: false,
    deletedBy: [],
    visibleToUserId: null,
    systemMessageType: null,
    messageType: "TEXT",
    message: `m${i}`,
    sentBy: OTHER,
    ...over,
  };
}

/** Drain the whole feed from `since`, exactly as a client / the service would. */
async function drain(
  repo: GeneralRoomMessageRepository,
  since: number,
  limit: number
): Promise<Doc[]> {
  const collected: Doc[] = [];
  let cursor = since;
  let guard = 0;
  for (;;) {
    const { messages, hasMore, nextRevision } =
      (await repo.findByRoomIdRevisionSince({
        roomId: ROOM,
        userId: USER,
        sinceRevision: cursor,
        limit,
      })) as unknown as {
        messages: Doc[];
        hasMore: boolean;
        nextRevision: number | null;
      };
    collected.push(...messages);
    if (!hasMore || nextRevision == null) break;
    cursor = nextRevision;
    if (++guard > 10_000) throw new Error("runaway pagination");
  }
  return collected;
}

describe("zero-loss changes feed (revision axis)", () => {
  it("returns an EDIT / REACTION / DELETE of old messages to a client synced before them (V2 after_seq would miss these)", async () => {
    // 5 inserts (seq==rev==1..5). Then, after the client synced at revision 5:
    //   edit    msg#2 → revision 6 (seq stays 2)
    //   react   msg#1 → revision 7 (seq stays 1)
    //   delete  msg#3 → revision 8, tombstone (seq stays 3)
    const store: Doc[] = [
      mk(1, { revision: 7, message: "m1" }), // reacted
      mk(2, { revision: 6, message: "m2 edited" }), // edited
      mk(3, { revision: 8, deletedForAll: true }), // tombstoned
      mk(4, {}),
      mk(5, {}),
    ];
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(store, () => 8) as never
    );

    const { messages, hasMore, nextRevision } =
      await repo.findByRoomIdRevisionSince({
        roomId: ROOM,
        userId: USER,
        sinceRevision: 5,
        limit: 100,
      });

    // Exactly the three mutated messages, revision ASC, none of the untouched 4/5.
    expect(messages.map((m) => m.revision)).toEqual([6, 7, 8]);
    expect(messages.map((m) => m.sequenceNumber)).toEqual([2, 1, 3]); // placement immutable
    expect(hasMore).toBe(false);
    expect(nextRevision).toBe(8);

    const deleted = messages.find((m) => m.sequenceNumber === 3)!;
    expect(deleted.deletedForAll).toBe(true); // tombstone replays (not a hard delete)
    const edited = messages.find((m) => m.sequenceNumber === 2)!;
    expect(edited.message).toBe("m2 edited");
  });

  it("cold start (since=0) returns every message once at its CURRENT revision, revision ASC", async () => {
    const store: Doc[] = [
      mk(1, { revision: 7 }),
      mk(2, { revision: 6 }),
      mk(3, { revision: 8, deletedForAll: true }),
      mk(4, {}),
      mk(5, {}),
    ];
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(store, () => 8) as never
    );
    const all = await drain(repo, 0, 100);
    expect(all.map((m) => m.revision)).toEqual([4, 5, 6, 7, 8]);
    expect(new Set(all.map((m) => m._id)).size).toBe(5); // each message exactly once
  });

  it("drains across pages with an EXACT hasMore and gapless nextRevision (no skip, no dup)", async () => {
    // 20 messages, revision==seq==1..20. Client synced at 3; page size 4.
    const store = Array.from({ length: 20 }, (_, i) => mk(i + 1, {}));
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(store, () => 20) as never
    );
    const drained = await drain(repo, 3, 4);
    const revs = drained.map((m) => m.revision);
    expect(revs).toEqual(Array.from({ length: 17 }, (_, i) => i + 4)); // 4..20 in order
    expect(new Set(revs).size).toBe(revs.length); // no duplicates across page edges
  });

  it("banned readCutoff never surfaces a change on a message created after the ban", async () => {
    const cutoff = new Date(1_700_000_000_000 + 3 * 1000); // ≤ msg#3
    const store: Doc[] = [
      mk(1, { revision: 6 }), // pre-ban, later reacted
      mk(2, {}),
      mk(3, {}),
      mk(4, { revision: 5 }), // created AFTER cutoff — must never appear
    ];
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(store, () => 6) as never
    );
    const { messages } = await repo.findByRoomIdRevisionSince({
      roomId: ROOM,
      userId: USER,
      sinceRevision: 0,
      limit: 100,
      readCutoff: cutoff,
    });
    expect(
      messages.every((m) => m.createdAt.getTime() <= cutoff.getTime())
    ).toBe(true);
    expect(messages.find((m) => m.sequenceNumber === 4)).toBeUndefined();
  });

  it("getRoomRevision returns the room's current CHANGE high-water", async () => {
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma([], () => 42) as never
    );
    expect(await repo.getRoomRevision(ROOM)).toBe(42);
  });
});
