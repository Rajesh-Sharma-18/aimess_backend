/**
 * Private history pagination — FULL-TRAVERSAL PROOF (before_ts path).
 *
 * Same defect class as community/group: the old `before_ts` page derived
 * `hasMore` from a post-in-memory-filter length (early termination) and used a
 * bare-ms cursor (same-millisecond messages skipped/duplicated). The fix moves
 * filtering into the DB and uses a `(createdAt, _id)` keyset.
 *
 * Private-specific: deleted-for-everyone (`isDeleted:true`) is EXCLUDED, and
 * delete-for-me is a MAP `deletedFor: { [userId]: ts }` (per-user key absent).
 */
import { PrivateMessageRepository } from "../../src/repositories/private-message.repository.js";
import {
  makeTimelinePrisma,
  traverseHistory,
  traverseHistoryBareMs,
  type EmuDoc,
} from "../helpers/timeline-emulator.js";

const ROOM = "private-room-1";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function mkDoc(i: number, over: Partial<EmuDoc>, ts: number): EmuDoc {
  return {
    _id: String(i).padStart(24, "0"),
    roomId: ROOM,
    createdAt: new Date(ts),
    isDeleted: false,
    deletedFor: {},
    senderId: OTHER,
    content: { text: `m${i}` },
    ...over,
  };
}

// Mirror of private timelineMatch: exclude isDeleted, drop the viewer's delete-for-me.
function isVisible(doc: EmuDoc): boolean {
  if (doc.roomId !== ROOM) return false;
  if (doc.isDeleted) return false;
  return !(USER in ((doc.deletedFor as Record<string, unknown>) ?? {}));
}

describe("private history pagination — full traversal (before_ts)", () => {
  it("retrieves EVERY visible message exactly once across a 731-message room with same-ms clusters + deleted rows", async () => {
    const base = 1_700_000_000_000;
    const docs: EmuDoc[] = [];
    for (let i = 0; i < 731; i++) {
      const ts = base + Math.floor(i / 4) * 1000; // clusters of 4 share one ms
      let over: Partial<EmuDoc> = {};
      if (i % 13 === 0)
        over = { isDeleted: true }; // deleted-for-everyone — EXCLUDED
      else if (i % 31 === 0)
        over = { deletedFor: { [USER]: base } }; // delete-for-me — DROPPED
      else if (i % 37 === 0) over = { deletedFor: { [OTHER]: base } }; // other's — KEPT
      docs.push(mkDoc(i, over, ts));
    }
    const repo = new PrivateMessageRepository(
      makeTimelinePrisma("privateMessage", docs) as never
    );

    const expected = docs
      .filter(isVisible)
      .map((d) => d._id)
      .sort();
    const collected = await traverseHistory(repo as never, {
      roomId: ROOM,
      userId: USER,
      limit: 30,
    });
    const ids = collected.map((d) => d.id);

    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect([...ids].sort()).toEqual(expected); // nothing missing/extra
    const total = await repo.countTimeline({ roomId: ROOM, userId: USER });
    expect(total).toBe(expected.length);
  });

  it("10 messages in the SAME millisecond are all reachable (tiny page forces a boundary split)", async () => {
    const t = 1_782_133_107_521;
    const docs: EmuDoc[] = [];
    for (let i = 0; i < 3; i++) docs.push(mkDoc(i, {}, t - (3 - i) * 1000));
    for (let i = 0; i < 10; i++) docs.push(mkDoc(100 + i, {}, t));
    for (let i = 0; i < 3; i++)
      docs.push(mkDoc(200 + i, {}, t + (i + 1) * 1000));

    const repo = new PrivateMessageRepository(
      makeTimelinePrisma("privateMessage", docs) as never
    );
    const collected = await traverseHistory(repo as never, {
      roomId: ROOM,
      userId: USER,
      limit: 3,
    });
    const ids = collected.map((d) => d.id).sort();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(docs.map((d) => d._id).sort());
  });

  it("a deleted-for-me row in the first window no longer terminates pagination early", async () => {
    const base = 1_700_000_000_000;
    const docs = Array.from({ length: 100 }, (_, i) =>
      mkDoc(
        i,
        i === 98 ? { deletedFor: { [USER]: base } } : {},
        base + i * 1000
      )
    );
    const repo = new PrivateMessageRepository(
      makeTimelinePrisma("privateMessage", docs) as never
    );
    const ids = (
      await traverseHistory(repo as never, {
        roomId: ROOM,
        userId: USER,
        limit: 30,
      })
    )
      .map((d) => d.id)
      .sort();
    expect(ids).toEqual(
      docs
        .filter(isVisible)
        .map((d) => d._id)
        .sort()
    );
    expect(ids).toHaveLength(99);
  });

  it("BARE-MS cursor reaches EVERY visible message across the 731-room (snap-to-ms hardening)", async () => {
    const base = 1_700_000_000_000;
    const docs: EmuDoc[] = [];
    for (let i = 0; i < 731; i++) {
      const ts = base + Math.floor(i / 4) * 1000;
      let over: Partial<EmuDoc> = {};
      if (i % 13 === 0) over = { isDeleted: true };
      else if (i % 31 === 0) over = { deletedFor: { [USER]: base } };
      else if (i % 37 === 0) over = { deletedFor: { [OTHER]: base } };
      docs.push(mkDoc(i, over, ts));
    }
    const repo = new PrivateMessageRepository(
      makeTimelinePrisma("privateMessage", docs) as never
    );
    const expected = docs
      .filter(isVisible)
      .map((d) => d._id)
      .sort();
    const ids = (
      await traverseHistoryBareMs(repo as never, {
        roomId: ROOM,
        userId: USER,
        limit: 30,
      })
    ).map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(expected);
  });

  it("BARE-MS cursor: a degenerate single-ms page (50 > limit) stays lossless (extend path)", async () => {
    const t = 1_782_133_500_000;
    const docs: EmuDoc[] = [];
    for (let i = 0; i < 2; i++) docs.push(mkDoc(i, {}, t - (2 - i) * 1000));
    for (let i = 0; i < 50; i++) docs.push(mkDoc(100 + i, {}, t));
    for (let i = 0; i < 2; i++)
      docs.push(mkDoc(200 + i, {}, t + (i + 1) * 1000));
    const repo = new PrivateMessageRepository(
      makeTimelinePrisma("privateMessage", docs) as never
    );
    const ids = (
      await traverseHistoryBareMs(repo as never, {
        roomId: ROOM,
        userId: USER,
        limit: 10,
      })
    )
      .map((d) => d.id)
      .sort();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(docs.map((d) => d._id).sort());
  });

  it("$match excludes isDeleted and the viewer's delete-for-me map key; continuation uses an exclusive keyset", async () => {
    const aggregateRaw = jest.fn().mockResolvedValue([]);
    const findMany = jest.fn().mockResolvedValue([]);
    const repo = new PrivateMessageRepository({
      privateMessage: { aggregateRaw, findMany },
    } as never);

    const boundaryId = "f".repeat(24);
    const ts = new Date(1_782_133_107_521);
    await repo.findByRoomIdTimeline({
      userId: USER,
      roomId: ROOM,
      direction: "before",
      ts,
      boundaryId,
      limit: 30,
    });
    const match = aggregateRaw.mock.calls[0][0].pipeline.find(
      (s: Record<string, unknown>) => "$match" in s
    ).$match;
    expect(match.isDeleted).toBe(false);
    expect(match[`deletedFor.${USER}`]).toEqual({ $exists: false });
    expect(match.createdAt).toBeUndefined();
    expect(match.$or).toEqual([
      { createdAt: { $lt: { $date: ts.toISOString() } } },
      {
        createdAt: { $date: ts.toISOString() },
        _id: { $lt: { $oid: boundaryId } },
      },
    ]);
  });
});
