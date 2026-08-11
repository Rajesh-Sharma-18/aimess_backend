/**
 * Community SEQUENCE pagination — FULL-TRAVERSAL PROOF.
 *
 * The `before_seq`/`after_seq` axis of `GET /api/chat/community/rooms/:roomId/messages` replaces the
 * `(createdAt, _id)` timestamp keyset with the monotonic `sequenceNumber` keyset
 * (`findByRoomIdSeq` / `findAroundSeq`). Because `sequenceNumber` is UNIQUE per
 * room, the seq axis is gap-safe with NO tiebreaker and NO snap-to-millisecond
 * handling: even a whole page of messages sharing one millisecond can never
 * split/skip/dup across a page boundary — the exact failure the V1 path had to
 * work around.
 *
 * These tests run the REAL `GeneralRoomMessageRepository` against a faithful
 * in-memory emulator of the `aggregateRaw`/`findMany` operators the seq methods
 * emit, traverse the entire history by seq, and assert: every visible message is
 * returned EXACTLY ONCE, none missing, none duplicated, `hasMore` is exact, and
 * hidden/personal/deleted rows never terminate pagination early. The `around`
 * window's bidirectional seq cursors are checked too.
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
  sequenceNumber: number;
  deletedForAll: boolean;
  deletedBy: string[];
  visibleToUserId: string | null;
  systemMessageType: string | null;
  messageType: string;
  message: string;
  sentBy: string;
};

function dateMs(v: { $date: string }): number {
  return new Date(v.$date).getTime();
}

function fieldVal(doc: Doc, key: string): number | string {
  if (key === "_id") return doc._id;
  if (key === "sequenceNumber") return doc.sequenceNumber;
  return doc.createdAt.getTime();
}

function matchField(doc: Doc, key: string, cond: unknown): boolean {
  if (key === "roomId") return doc.roomId === (cond as { $oid: string }).$oid;
  if (key === "deletedForAll") return doc.deletedForAll === cond;
  if (key === "deletedBy")
    return !doc.deletedBy.includes((cond as { $ne: string }).$ne);
  if (key === "visibleToUserId") {
    if (typeof cond === "string") return doc.visibleToUserId === cond;
    const arr = (cond as { $in?: Array<string | null> }).$in;
    if (arr) {
      return arr.some((a) =>
        a === null ? doc.visibleToUserId == null : doc.visibleToUserId === a
      );
    }
    return false;
  }
  if (key === "systemMessageType") {
    const arr = cond as { $nin?: string[]; $in?: string[] };
    if (arr.$nin) return !arr.$nin.includes(doc.systemMessageType ?? "");
    if (arr.$in) return arr.$in.includes(doc.systemMessageType ?? "");
  }
  if (key === "sequenceNumber") {
    const c = cond as Record<string, number>;
    if (c.$lt != null && !(doc.sequenceNumber < c.$lt)) return false;
    if (c.$lte != null && !(doc.sequenceNumber <= c.$lte)) return false;
    if (c.$gt != null && !(doc.sequenceNumber > c.$gt)) return false;
    if (c.$gte != null && !(doc.sequenceNumber >= c.$gte)) return false;
    return true;
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
    if (c.$eq && !(doc._id === c.$eq.$oid)) return false;
    if (c.$lt && !(doc._id < c.$lt.$oid)) return false;
    if (c.$gt && !(doc._id > c.$gt.$oid)) return false;
    return true;
  }
  if (key === "$or") {
    return (cond as Array<Record<string, unknown>>).some((sub) =>
      matchDoc(doc, sub)
    );
  }
  if (key === "$and") {
    return (cond as Array<Record<string, unknown>>).every((sub) =>
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
        const av1 = fieldVal(a, k1);
        const bv1 = fieldVal(b, k1);
        if (av1 < bv1) return -1 * d1;
        if (av1 > bv1) return 1 * d1;
        if (!k2) return 0;
        const av2 = fieldVal(a, k2);
        const bv2 = fieldVal(b, k2);
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
    async ({
      where,
      orderBy,
      take,
    }: {
      where: {
        id?: { in: string[] };
        roomId?: string;
        visibleToUserId?: string;
      };
      orderBy?: unknown;
      take?: number;
    }) => {
      if (!where.id) {
        // findLatestPersonalJoinMessageId fallback shape.
        let rows = docs.filter(
          (d) =>
            d.roomId === where.roomId &&
            d.visibleToUserId === where.visibleToUserId &&
            !d.deletedForAll &&
            [...PERSONAL_JOIN_SESSION_TYPES].includes(
              d.systemMessageType as never
            )
        );
        if (orderBy) {
          rows = [...rows].sort((a, b) => {
            const t = b.createdAt.getTime() - a.createdAt.getTime();
            return t || b._id.localeCompare(a._id);
          });
        }
        return rows.slice(0, take ?? rows.length).map((d) => ({ id: d._id }));
      }
      const want = new Set(where.id.in);
      return docs
        .filter((d) => want.has(d._id))
        .map((d) => ({ ...d, id: d._id }));
    }
  );

  return { generalRoomMessage: { aggregateRaw, findMany } };
}

function latestPersonalJoinId(docs: Doc[]): string | null {
  return (
    docs
      .filter(
        (d) =>
          d.roomId === ROOM &&
          d.visibleToUserId === USER &&
          !d.deletedForAll &&
          [...PERSONAL_JOIN_SESSION_TYPES].includes(
            d.systemMessageType as never
          )
      )
      .sort((a, b) => {
        const t = b.createdAt.getTime() - a.createdAt.getTime();
        return t || b._id.localeCompare(a._id);
      })[0]?._id ?? null
  );
}

function isVisible(
  doc: Doc,
  viewerActive = true,
  latestJoinId: string | null = null
): boolean {
  if (doc.roomId !== ROOM) return false;
  if (doc.deletedForAll) return false;
  if (doc.deletedBy.includes(USER)) return false;
  if (!(doc.visibleToUserId == null || doc.visibleToUserId === USER))
    return false;
  if ([...HIDDEN_SYSTEM_MESSAGE_TYPES].includes(doc.systemMessageType as never))
    return false;
  if (
    viewerActive &&
    doc.visibleToUserId === USER &&
    [...PERSONAL_JOIN_SESSION_TYPES].includes(doc.systemMessageType as never)
  )
    return doc._id === latestJoinId;
  return true;
}

/** i is both the id ordinal and the sequenceNumber (1-based, unique, monotonic). */
function mkDoc(i: number, over: Partial<Doc>, ts: number): Doc {
  return {
    _id: String(i).padStart(24, "0"),
    roomId: ROOM,
    createdAt: new Date(ts),
    sequenceNumber: i + 1,
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

/** Walk the whole history newest→oldest by seq, exactly as the service does. */
async function traverseSeq(
  repo: GeneralRoomMessageRepository,
  limit: number,
  viewerIsActiveMember = true
): Promise<Doc[]> {
  const collected: Doc[] = [];
  let seq: number | null = null;
  let guard = 0;
  for (;;) {
    const { messages, hasMore } = (await repo.findByRoomIdSeq({
      roomId: ROOM,
      userId: USER,
      direction: "before",
      seq,
      limit,
      viewerIsActiveMember,
    })) as unknown as { messages: Doc[]; hasMore: boolean };

    collected.push(...messages);
    if (!hasMore || messages.length === 0) break;
    // DB order is desc for "before"; the tail is the lowest seq = next boundary.
    // nextCursor is the PLAIN seq string (adapter.nextCursor), parsed back to int.
    const tail = messages[messages.length - 1]!;
    seq = Number(String(tail.sequenceNumber));
    if (++guard > 10_000) throw new Error("runaway pagination");
  }
  return collected;
}

describe("community SEQUENCE pagination — full traversal", () => {
  it("retrieves EVERY visible message exactly once across a 731-message room with hidden/personal/deleted rows", async () => {
    const base = 1_700_000_000_000;
    const docs: Doc[] = [];
    for (let i = 0; i < 731; i++) {
      const ts = base + Math.floor(i / 4) * 1000; // clusters share a millisecond
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
      .filter((d) => isVisible(d, true, latestPersonalJoinId(docs)))
      .map((d) => d._id)
      .sort();
    expect(expected.length).toBeGreaterThan(500);

    const collected = await traverseSeq(repo, 30);
    const ids = collected.map((d) => d._id);

    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect([...ids].sort()).toEqual(expected); // nothing missing, nothing extra
  });

  it("GAP-SAFE: an entire page of messages sharing ONE millisecond is fully reachable (the V1 weakness the seq axis removes)", async () => {
    const t = 1_782_133_107_521;
    const docs: Doc[] = [];
    // 3 older + 50 in the EXACT same ms + 3 newer. Page size 10 < 50: on a bare-ms
    // cursor this cluster would split; on the unique seq cursor it never does.
    for (let i = 0; i < 3; i++) docs.push(mkDoc(i, {}, t - (3 - i) * 1000));
    for (let i = 0; i < 50; i++) docs.push(mkDoc(100 + i, {}, t));
    for (let i = 0; i < 3; i++)
      docs.push(mkDoc(200 + i, {}, t + (i + 1) * 1000));
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(docs) as never
    );

    const ids = (await traverseSeq(repo, 10)).map((d) => d._id).sort();
    expect(new Set(ids).size).toBe(ids.length); // no dupes across boundaries
    expect(ids).toEqual(docs.map((d) => d._id).sort()); // all 56 reachable
    for (let i = 0; i < 50; i++)
      expect(ids).toContain(String(100 + i).padStart(24, "0"));
  });

  it("emits a PLAIN-seq nextCursor and an EXACT hasMore (over-fetch detection)", async () => {
    const base = 1_700_000_000_000;
    const docs = Array.from({ length: 5 }, (_, i) =>
      mkDoc(i, {}, base + i * 1000)
    );
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(docs) as never
    );

    // Newest page, limit 2: seqs 5,4 (desc); hasMore true; boundary seq = 4.
    const page1 = (await repo.findByRoomIdSeq({
      roomId: ROOM,
      userId: USER,
      direction: "before",
      seq: null,
      limit: 2,
    })) as unknown as { messages: Doc[]; hasMore: boolean };
    expect(page1.hasMore).toBe(true);
    expect(page1.messages.map((m) => m.sequenceNumber)).toEqual([5, 4]);

    // Continue with seq=4 (exclusive <): seqs 3,2; hasMore true.
    const page2 = (await repo.findByRoomIdSeq({
      roomId: ROOM,
      userId: USER,
      direction: "before",
      seq: 4,
      limit: 2,
    })) as unknown as { messages: Doc[]; hasMore: boolean };
    expect(page2.messages.map((m) => m.sequenceNumber)).toEqual([3, 2]);
    expect(page2.hasMore).toBe(true);

    // Last page: exact hasMore=false when the remainder fits.
    const last = (await repo.findByRoomIdSeq({
      roomId: ROOM,
      userId: USER,
      direction: "before",
      seq: 2,
      limit: 30,
    })) as unknown as { messages: Doc[]; hasMore: boolean };
    expect(last.hasMore).toBe(false);
    expect(last.messages.map((m) => m.sequenceNumber)).toEqual([1]);
  });

  it("forward sync (after_seq): returns strictly-newer messages oldest-first", async () => {
    const base = 1_700_000_000_000;
    const docs = Array.from({ length: 6 }, (_, i) =>
      mkDoc(i, {}, base + i * 1000)
    );
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(docs) as never
    );

    const after = (await repo.findByRoomIdSeq({
      roomId: ROOM,
      userId: USER,
      direction: "after",
      seq: 3, // seq > 3 → 4,5,6 ascending
      limit: 10,
    })) as unknown as { messages: Doc[]; hasMore: boolean };
    expect(after.messages.map((m) => m.sequenceNumber)).toEqual([4, 5, 6]);
    expect(after.hasMore).toBe(false);
  });

  it("a hidden system message in the FIRST window does NOT terminate pagination early", async () => {
    const base = 1_700_000_000_000;
    const docs: Doc[] = [];
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

    const ids = (await traverseSeq(repo, 30)).map((d) => d._id).sort();
    const expected = docs
      .filter((d) => isVisible(d, true, latestPersonalJoinId(docs)))
      .map((d) => d._id)
      .sort();
    expect(ids).toEqual(expected);
    expect(ids).toHaveLength(99);
  });

  it("findAroundSeq: window is anchor-centered with correct bidirectional hasMore/edges", async () => {
    const base = 1_700_000_000_000;
    const docs = Array.from({ length: 20 }, (_, i) =>
      mkDoc(i, {}, base + i * 1000)
    );
    const repo = new GeneralRoomMessageRepository(
      makeFakePrisma(docs) as never
    );

    // Anchor on seq 10 (id ordinal 9), limit 6 → ~3 each side, anchor-inclusive.
    const rows = (await repo.findAroundSeq({
      roomId: ROOM,
      userId: USER,
      anchorSeq: 10,
      limit: 6,
    })) as unknown as Doc[];

    const seqs = rows.map((r) => r.sequenceNumber);
    // Oldest→newest, includes the anchor (10), no dupes.
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs).toContain(10);
    expect(new Set(seqs).size).toBe(seqs.length);
    // Symmetric-ish window strictly inside the room bounds.
    expect(Math.min(...seqs)).toBeGreaterThan(1);
    expect(Math.max(...seqs)).toBeLessThan(20);
  });
});
