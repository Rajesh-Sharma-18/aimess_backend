/**
 * Community history pagination — FULL-TRAVERSAL PROOF.
 *
 * Regression target: scrolling back through `GET /community/rooms/:id/messages`
 * with `before_ts` dropped messages. Two root causes:
 *
 *   1. The old repo fetched `limit + 1` rows then filtered hidden/personal/
 *      deleted rows IN MEMORY, so `hasMore` (derived from the post-filter length)
 *      underflowed whenever a hidden row landed in the window — pagination
 *      terminated early and older messages became unreachable.
 *   2. The cursor was a bare millisecond, so messages sharing one millisecond
 *      were split across a page boundary and silently skipped/duplicated.
 *
 * The fix moves all filtering into the DB and uses a `(createdAt, _id)` keyset
 * cursor. These tests run the REAL `GeneralRoomMessageRepository` against a small
 * faithful in-memory emulator of the exact `aggregateRaw`/`findMany` operators it
 * emits, then traverse the entire history and assert: every visible message is
 * returned EXACTLY ONCE, none are missing, none duplicated, and the count matches
 * what pagination can actually reach.
 */
import { GeneralRoomMessageRepository } from "../../src/repositories/general-room-message.repository.js";
import {
  HIDDEN_SYSTEM_MESSAGE_TYPES,
  PERSONAL_JOIN_SESSION_TYPES,
} from "@aimess/constants";

const ROOM = "a".repeat(24);
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

type Doc = {
  _id: string;
  roomId: string;
  createdAt: Date;
  deletedForAll: boolean;
  deletedBy: string[];
  visibleToUserId: string | null;
  systemMessageType: string | null;
  messageType: string;
  message: string;
  sentBy: string;
};

// ---------------------------------------------------------------------------
// Minimal Mongo emulator — implements ONLY the operators the repo emits.
// ---------------------------------------------------------------------------
function dateMs(v: { $date: string }): number {
  return new Date(v.$date).getTime();
}

function matchField(doc: Doc, key: string, cond: unknown): boolean {
  if (key === "roomId") return doc.roomId === (cond as { $oid: string }).$oid;
  if (key === "deletedForAll") return doc.deletedForAll === cond;
  if (key === "deletedBy")
    return !doc.deletedBy.includes((cond as { $ne: string }).$ne);
  if (key === "visibleToUserId") {
    const arr = (cond as { $in: Array<string | null> }).$in;
    return arr.some((a) =>
      a === null ? doc.visibleToUserId == null : doc.visibleToUserId === a
    );
  }
  if (key === "systemMessageType") {
    const arr = cond as { $nin?: string[]; $in?: string[] };
    if (arr.$nin) return !arr.$nin.includes(doc.systemMessageType ?? "");
    if (arr.$in) return arr.$in.includes(doc.systemMessageType ?? "");
  }
  if (key === "createdAt") {
    const c = cond as Record<string, { $date: string }>;
    if ("$date" in c)
      return doc.createdAt.getTime() === dateMs(c as { $date: string });
    const t = doc.createdAt.getTime();
    if (c.$lt && !(t < dateMs(c.$lt))) return false;
    if (c.$lte && !(t <= dateMs(c.$lte))) return false;
    if (c.$gt && !(t > dateMs(c.$gt))) return false;
    if (c.$gte && !(t >= dateMs(c.$gte))) return false;
    return true;
  }
  if (key === "_id") {
    const c = cond as Record<string, { $oid: string }>;
    if (c.$lt && !(doc._id < c.$lt.$oid)) return false;
    if (c.$gt && !(doc._id > c.$gt.$oid)) return false;
    return true;
  }
  if (key === "$or") {
    return (cond as Array<Record<string, unknown>>).some((sub) =>
      matchDoc(doc, sub)
    );
  }
  if (key === "$nor") {
    return !(cond as Array<Record<string, unknown>>).some((sub) =>
      matchDoc(doc, sub)
    );
  }
  throw new Error(`emulator: unsupported match key ${key}`);
}

function matchDoc(doc: Doc, match: Record<string, unknown>): boolean {
  return Object.entries(match).every(([k, v]) => matchField(doc, k, v));
}

function makeFakePrisma(docs: Doc[]) {
  const aggregateRaw = jest.fn(async ({ pipeline }: { pipeline: any[] }) => {
    const match = pipeline.find((s) => "$match" in s)?.$match ?? {};
    let rows = docs.filter((d) => matchDoc(d, match));

    const countStage = pipeline.find((s) => "$count" in s);
    if (countStage) return rows.length ? [{ total: rows.length }] : [];

    const sort = pipeline.find((s) => "$sort" in s)?.$sort as
      | Record<string, number>
      | undefined;
    if (sort) {
      const [[k1, d1], tie] = Object.entries(sort);
      const [k2, d2] = tie ?? [];
      rows = [...rows].sort((a, b) => {
        const av1 = k1 === "_id" ? a._id : a.createdAt.getTime();
        const bv1 = k1 === "_id" ? b._id : b.createdAt.getTime();
        if (av1 < bv1) return -1 * d1;
        if (av1 > bv1) return 1 * d1;
        if (!k2) return 0;
        const av2 = k2 === "_id" ? a._id : a.createdAt.getTime();
        const bv2 = k2 === "_id" ? b._id : b.createdAt.getTime();
        if (av2 < bv2) return -1 * d2!;
        if (av2 > bv2) return 1 * d2!;
        return 0;
      });
    }
    const limit = pipeline.find((s) => "$limit" in s)?.$limit as
      | number
      | undefined;
    if (limit != null) rows = rows.slice(0, limit);
    return rows.map((d) => ({ _id: { $oid: d._id } }));
  });

  const findMany = jest.fn(
    async ({ where }: { where: { id: { in: string[] } } }) => {
      const want = new Set(where.id.in);
      return docs
        .filter((d) => want.has(d._id))
        .map((d) => ({ ...d, id: d._id }));
    }
  );

  return { generalRoomMessage: { aggregateRaw, findMany } };
}

// Mirror of timelineMatch semantics — the EXPECTED visible set for an active viewer.
function isVisible(doc: Doc, viewerActive = true): boolean {
  if (doc.roomId !== ROOM) return false;
  if (doc.deletedForAll) return false;
  if (doc.deletedBy.includes(USER)) return false;
  if (!(doc.visibleToUserId == null || doc.visibleToUserId === USER))
    return false;
  if ([...HIDDEN_SYSTEM_MESSAGE_TYPES].includes(doc.systemMessageType as never))
    return false;
  if (
    !viewerActive &&
    doc.visibleToUserId === USER &&
    [...PERSONAL_JOIN_SESSION_TYPES].includes(doc.systemMessageType as never)
  )
    return false;
  return true;
}

function mkDoc(i: number, over: Partial<Doc>, ts: number): Doc {
  return {
    _id: String(i).padStart(24, "0"),
    roomId: ROOM,
    createdAt: new Date(ts),
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

/** Walk the whole history newest→oldest exactly as the controller+service do. */
async function traverseAll(
  repo: GeneralRoomMessageRepository,
  limit: number,
  viewerIsActiveMember = true
): Promise<Doc[]> {
  const collected: Doc[] = [];
  let cursor: { ts: number; id: string } | null = null;
  let guard = 0;
  for (;;) {
    const { messages, hasMore } = (await repo.findByRoomIdTimeline({
      roomId: ROOM,
      userId: USER,
      direction: "before",
      ts: cursor ? new Date(cursor.ts) : new Date(9_000_000_000_000),
      boundaryId: cursor ? cursor.id : null,
      inclusive: cursor == null,
      limit,
      viewerIsActiveMember,
    })) as unknown as { messages: Doc[]; hasMore: boolean };

    collected.push(...messages);
    if (!hasMore || messages.length === 0) break;
    const tail = messages[messages.length - 1]!; // oldest in this desc page
    // Reconstruct the compound cursor the service hands the client, then parse it
    // back the way the controller does — this exercises the real round-trip.
    const nextCursor = `${tail.createdAt.getTime()}_${tail._id}`;
    const sep = nextCursor.indexOf("_");
    cursor = {
      ts: Number(nextCursor.slice(0, sep)),
      id: nextCursor.slice(sep + 1),
    };
    if (++guard > 10_000) throw new Error("runaway pagination");
  }
  return collected;
}

/**
 * Walk the whole history echoing ONLY the bare millisecond (the client drops the
 * `_id` tiebreaker — `before_ts=<ms>` instead of the compound `<ms>_<id>`). With
 * the snap-to-millisecond hardening this MUST still reach every message.
 */
async function traverseBareMs(
  repo: GeneralRoomMessageRepository,
  limit: number
): Promise<Doc[]> {
  const collected: Doc[] = [];
  let ms: number | null = null;
  let guard = 0;
  for (;;) {
    const { messages, hasMore } = (await repo.findByRoomIdTimeline({
      roomId: ROOM,
      userId: USER,
      direction: "before",
      ts: ms != null ? new Date(ms) : new Date(9_000_000_000_000),
      boundaryId: null, // bare ms — NO _id tiebreaker
      inclusive: ms == null,
      limit,
    })) as unknown as { messages: Doc[]; hasMore: boolean };
    collected.push(...messages);
    if (!hasMore || messages.length === 0) break;
    const tail = messages[messages.length - 1]!;
    ms = tail.createdAt.getTime(); // drop the _id, exactly as a naive FE does
    if (++guard > 10_000) throw new Error("runaway pagination");
  }
  return collected;
}

describe("community history pagination — full traversal", () => {
  it("retrieves EVERY visible message exactly once across a 731-message room with same-ms clusters, hidden/personal/deleted rows", async () => {
    const base = 1_700_000_000_000;
    const docs: Doc[] = [];
    for (let i = 0; i < 731; i++) {
      // Clusters of 4 consecutive messages share one millisecond — the same-ms
      // stress the bare-ms cursor used to skip.
      const ts = base + Math.floor(i / 4) * 1000;
      let over: Partial<Doc> = {};
      if (i % 29 === 0) over = { deletedForAll: true };
      else if (i % 31 === 0) over = { deletedBy: [USER] };
      else if (i % 23 === 0) over = { visibleToUserId: OTHER };
      else if (i % 17 === 0)
        over = { systemMessageType: "MEMBER_JOINED", messageType: "SYSTEM" };
      else if (i % 37 === 0)
        over = {
          visibleToUserId: USER,
          systemMessageType: "COMMUNITY_JOINED",
          messageType: "SYSTEM",
        };
      else if (i % 41 === 0)
        over = { systemMessageType: "MEMBER_REMOVED", messageType: "SYSTEM" };
      docs.push(mkDoc(i, over, ts));
    }

    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(docs) as never
    );

    const expected = docs
      .filter((d) => isVisible(d))
      .map((d) => d._id)
      .sort();
    expect(expected.length).toBeGreaterThan(600); // sanity: most are visible

    const collected = await traverseAll(repo, 30);
    const ids = collected.map((d) => d._id);

    // No duplicates.
    expect(new Set(ids).size).toBe(ids.length);
    // Exactly the visible set — nothing missing, nothing extra.
    expect([...ids].sort()).toEqual(expected);
    // total reported by the API equals what pagination actually reaches.
    const total = await repo.countTimeline({
      roomId: ROOM,
      userId: USER,
      viewerIsActiveMember: true,
    });
    expect(total).toBe(expected.length);
  });

  it("the user's example: 10 messages in the SAME millisecond are all reachable, none skipped", async () => {
    const t = 1_782_133_107_521;
    const docs: Doc[] = [];
    // 3 older, then 10 sharing the exact same ms, then 3 newer.
    for (let i = 0; i < 3; i++) docs.push(mkDoc(i, {}, t - (3 - i) * 1000));
    for (let i = 0; i < 10; i++) docs.push(mkDoc(100 + i, {}, t)); // identical ms
    for (let i = 0; i < 3; i++)
      docs.push(mkDoc(200 + i, {}, t + (i + 1) * 1000));

    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(docs) as never
    );

    // A tiny page size forces the same-ms cluster to straddle page boundaries.
    const collected = await traverseAll(repo, 3);
    const ids = collected.map((d) => d._id).sort();

    expect(new Set(ids).size).toBe(ids.length); // no dupes across the boundary
    expect(ids).toEqual(docs.map((d) => d._id).sort()); // all 16 reachable
    // Specifically: every one of the 10 same-ms messages is present.
    for (let i = 0; i < 10; i++) {
      expect(ids).toContain(String(100 + i).padStart(24, "0"));
    }
  });

  it("a hidden system message in the FIRST window no longer terminates pagination early", async () => {
    const base = 1_700_000_000_000;
    const docs: Doc[] = [];
    // 100 messages; the 2nd-newest is a hidden MEMBER_JOINED. Pre-fix, a hidden
    // row inside the first limit+1 window made hasMore=false → only one page ever.
    for (let i = 0; i < 100; i++) {
      const over =
        i === 98
          ? { systemMessageType: "MEMBER_JOINED", messageType: "SYSTEM" }
          : {};
      docs.push(mkDoc(i, over, base + i * 1000));
    }
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(docs) as never
    );

    const collected = await traverseAll(repo, 30);
    const ids = collected.map((d) => d._id).sort();
    const expected = docs
      .filter((d) => isVisible(d))
      .map((d) => d._id)
      .sort();

    expect(ids).toEqual(expected); // all 99 visible reachable (not just page 1)
    expect(ids).toHaveLength(99);
  });

  it("emits a COMPOUND keyset nextCursor and an exact hasMore (over-fetch detection)", async () => {
    const base = 1_700_000_000_000;
    const docs = Array.from({ length: 5 }, (_, i) =>
      mkDoc(i, {}, base + i * 1000)
    );
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(docs) as never
    );

    // First page, limit 2: newest-first → ids 4,3; hasMore true; boundary = id 3.
    const page1 = (await repo.findByRoomIdTimeline({
      roomId: ROOM,
      userId: USER,
      direction: "before",
      ts: new Date(9_000_000_000_000),
      inclusive: true,
      limit: 2,
    })) as unknown as { messages: Doc[]; hasMore: boolean };
    expect(page1.hasMore).toBe(true);
    expect(page1.messages.map((m) => m._id)).toEqual([
      String(4).padStart(24, "0"),
      String(3).padStart(24, "0"),
    ]);

    // Last page: exact hasMore=false when the remainder fits.
    const last = (await repo.findByRoomIdTimeline({
      roomId: ROOM,
      userId: USER,
      direction: "before",
      ts: new Date(base + 1 * 1000),
      boundaryId: String(1).padStart(24, "0"),
      limit: 30,
    })) as unknown as { messages: Doc[]; hasMore: boolean };
    expect(last.hasMore).toBe(false);
    expect(last.messages.map((m) => m._id)).toEqual([
      String(0).padStart(24, "0"),
    ]);
  });

  // ----- snap-to-millisecond hardening: bare-ms cursors must NOT lose messages --
  it("BARE-MS cursor (the bug report's `before_ts=<ms>`) reaches EVERY message — snap-to-ms hardening", async () => {
    const base = 1_782_133_000_000;
    const docs: Doc[] = [];
    // 731 messages, clusters of 4 share one millisecond → clusters routinely
    // straddle the page boundary at limit=30. Pre-hardening this dropped 43.
    for (let i = 0; i < 731; i++)
      docs.push(mkDoc(i, {}, base + Math.floor(i / 4) * 1000));
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(docs) as never
    );

    const ids = (await traverseBareMs(repo, 30)).map((d) => d._id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect([...ids].sort()).toEqual(docs.map((d) => d._id).sort()); // all 731
  });

  it("BARE-MS cursor: 10 messages in the SAME millisecond are all reachable across tiny pages", async () => {
    const t = 1_782_133_107_521; // the exact ms from the bug report
    const docs: Doc[] = [];
    for (let i = 0; i < 3; i++) docs.push(mkDoc(i, {}, t - (3 - i) * 1000));
    for (let i = 0; i < 10; i++) docs.push(mkDoc(100 + i, {}, t)); // identical ms
    for (let i = 0; i < 3; i++)
      docs.push(mkDoc(200 + i, {}, t + (i + 1) * 1000));
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(docs) as never
    );

    const ids = (await traverseBareMs(repo, 3)).map((d) => d._id).sort();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(docs.map((d) => d._id).sort()); // all 16 reachable
    for (let i = 0; i < 10; i++)
      expect(ids).toContain(String(100 + i).padStart(24, "0"));
  });

  it("BARE-MS cursor: DEGENERATE page — more same-ms messages than the limit — still lossless (extend path)", async () => {
    const t = 1_782_133_500_000;
    const docs: Doc[] = [];
    // 50 messages ALL in one millisecond (page limit 10 < 50 → trim would empty
    // the page, forcing the extend branch), bracketed by a few distinct-ms rows.
    for (let i = 0; i < 2; i++) docs.push(mkDoc(i, {}, t - (2 - i) * 1000));
    for (let i = 0; i < 50; i++) docs.push(mkDoc(100 + i, {}, t)); // identical ms
    for (let i = 0; i < 2; i++)
      docs.push(mkDoc(200 + i, {}, t + (i + 1) * 1000));
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(docs) as never
    );

    const ids = (await traverseBareMs(repo, 10)).map((d) => d._id).sort();
    expect(new Set(ids).size).toBe(ids.length); // no dupes despite the extend
    expect(ids).toEqual(docs.map((d) => d._id).sort()); // all 54 reachable
  });

  it("BARE-MS cursor reaches every visible message across the mixed 731-room (hidden/personal/deleted)", async () => {
    const base = 1_700_000_000_000;
    const docs: Doc[] = [];
    for (let i = 0; i < 731; i++) {
      const ts = base + Math.floor(i / 4) * 1000;
      let over: Partial<Doc> = {};
      if (i % 29 === 0) over = { deletedForAll: true };
      else if (i % 31 === 0) over = { deletedBy: [USER] };
      else if (i % 23 === 0) over = { visibleToUserId: OTHER };
      else if (i % 17 === 0)
        over = { systemMessageType: "MEMBER_JOINED", messageType: "SYSTEM" };
      else if (i % 37 === 0)
        over = {
          visibleToUserId: USER,
          systemMessageType: "COMMUNITY_JOINED",
          messageType: "SYSTEM",
        };
      else if (i % 41 === 0)
        over = { systemMessageType: "MEMBER_REMOVED", messageType: "SYSTEM" };
      docs.push(mkDoc(i, over, ts));
    }
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(docs) as never
    );

    const expected = docs
      .filter((d) => isVisible(d))
      .map((d) => d._id)
      .sort();
    const ids = (await traverseBareMs(repo, 30)).map((d) => d._id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(expected); // nothing missing, nothing extra
  });
});
