/**
 * Group history pagination — FULL-TRAVERSAL PROOF (before_ts path).
 *
 * Same defect class as community chat: the old `before_ts` page derived `hasMore`
 * from a post-in-memory-filter length (early termination) and used a bare-ms
 * cursor (same-millisecond messages skipped/duplicated). The fix moves the
 * delete-for-me filter into the DB and uses a `(createdAt, _id)` keyset.
 *
 * Deleted-for-everyone messages (`isDeleted:true`) are dropped from history —
 * same as private/community — as are the viewer's own `deletedForUserIds` entries.
 */
import { GroupMessageRepository } from "../../src/repositories/group-message.repository.js";
import {
  makeTimelinePrisma,
  traverseHistory,
  traverseHistoryBareMs,
  type EmuDoc,
} from "../helpers/timeline-emulator.js";

const ROOM = "group-room-1";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function mkDoc(i: number, over: Partial<EmuDoc>, ts: number): EmuDoc {
  return {
    _id: String(i).padStart(24, "0"),
    roomId: ROOM,
    createdAt: new Date(ts),
    isDeleted: false,
    deletedForUserIds: [],
    senderId: OTHER,
    content: { text: `m${i}` },
    ...over,
  };
}

// Mirror of group timelineMatch: drop tombstones and delete-for-me.
function isVisible(doc: EmuDoc): boolean {
  if (doc.roomId !== ROOM) return false;
  if (doc.isDeleted) return false;
  return !((doc.deletedForUserIds as string[]) ?? []).includes(USER);
}

describe("group history pagination — full traversal (before_ts)", () => {
  it("retrieves EVERY visible message exactly once across a 731-message room with same-ms clusters + deleted rows (tombstones dropped)", async () => {
    const base = 1_700_000_000_000;
    const docs: EmuDoc[] = [];
    for (let i = 0; i < 731; i++) {
      const ts = base + Math.floor(i / 4) * 1000; // clusters of 4 share one ms
      let over: Partial<EmuDoc> = {};
      if (i % 13 === 0)
        over = { isDeleted: true }; // deleted for everyone — DROPPED
      else if (i % 31 === 0)
        over = { deletedForUserIds: [USER] }; // delete-for-me — DROPPED
      else if (i % 37 === 0) over = { deletedForUserIds: [OTHER] }; // other's delete — KEPT
      docs.push(mkDoc(i, over, ts));
    }
    const repo = new GroupMessageRepository(
      makeTimelinePrisma("groupMessage", docs) as never
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

    const repo = new GroupMessageRepository(
      makeTimelinePrisma("groupMessage", docs) as never
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
      mkDoc(i, i === 98 ? { deletedForUserIds: [USER] } : {}, base + i * 1000)
    );
    const repo = new GroupMessageRepository(
      makeTimelinePrisma("groupMessage", docs) as never
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

  it("BARE-MS cursor reaches EVERY message across the 731-room (snap-to-ms hardening)", async () => {
    const base = 1_700_000_000_000;
    const docs: EmuDoc[] = [];
    for (let i = 0; i < 731; i++) {
      const ts = base + Math.floor(i / 4) * 1000;
      let over: Partial<EmuDoc> = {};
      if (i % 31 === 0) over = { deletedForUserIds: [USER] };
      else if (i % 37 === 0) over = { deletedForUserIds: [OTHER] };
      docs.push(mkDoc(i, over, ts));
    }
    const repo = new GroupMessageRepository(
      makeTimelinePrisma("groupMessage", docs) as never
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
    const repo = new GroupMessageRepository(
      makeTimelinePrisma("groupMessage", docs) as never
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

  it("uses an EXCLUSIVE (createdAt,_id) keyset on a continuation page", async () => {
    const aggregateRaw = jest.fn().mockResolvedValue([]);
    const findMany = jest.fn().mockResolvedValue([]);
    const repo = new GroupMessageRepository({
      groupMessage: { aggregateRaw, findMany },
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
    expect(match.deletedForUserIds).toEqual({ $ne: USER });
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
