/**
 * `GET /api/v1/communities/mine?cursor=` — COMPOUND-KEYSET gap-safety proof.
 *
 * V1 `/mine` bounds only `lastActivityAt` in the WHERE (the `id` tiebreaker lives
 * only in `orderBy`), so communities sharing one `lastActivityAt` millisecond can
 * skip or duplicate across a page edge. `listMineByActivityKeyset` puts the
 * `id` tiebreaker IN the boundary (`$or[{lastActivityAt lt}, {lastActivityAt eq,
 * id lt}]`), giving a true total order.
 *
 * These tests exercise the REAL `listMineByActivityKeyset` with only the Prisma
 * boundary mocked (a faithful emulator of the compound `where` + `orderBy` +
 * `take`), traverse the whole list newest→oldest feeding the compound cursor
 * back exactly as the service does, and assert every community is returned
 * EXACTLY ONCE across dense same-millisecond clusters — none skipped, none
 * duplicated. The boundary shape itself is asserted too.
 */

jest.unmock("../../src/repositories/community.repository.js");

type Row = { id: string; lastActivityAt: Date };

let store: Row[] = [];
const findManyMock = jest.fn();
const countMock = jest.fn();

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    community: {
      findMany: (args: unknown) => findManyMock(args),
      count: (args: unknown) => countMock(args),
    },
  },
}));

jest.mock("../../src/generated/prisma/index.js", () => {
  const echo = () =>
    new Proxy(
      {},
      { get: (_t, key) => (typeof key === "string" ? key : undefined) }
    );
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "__esModule") return true;
        return echo();
      },
    }
  );
});

import { communityRepository } from "../../src/repositories/community.repository.js";

const USER = "11111111-1111-4111-8111-111111111111";

// --- Faithful emulator of the exact `where`/`orderBy`/`take` the repo emits ----
type Clause =
  | { lastActivityAt: { lt: Date } }
  | { lastActivityAt: Date; id: { lt: string } };

function passesBoundary(row: Row, where: { OR?: Clause[] }): boolean {
  if (!where.OR) return true; // newest page: no boundary
  return where.OR.some((clause) => {
    if ("id" in clause) {
      return (
        row.lastActivityAt.getTime() ===
          (clause.lastActivityAt as Date).getTime() && row.id < clause.id.lt
      );
    }
    return row.lastActivityAt.getTime() < clause.lastActivityAt.lt.getTime();
  });
}

beforeEach(() => {
  findManyMock.mockReset();
  countMock.mockReset();
  findManyMock.mockImplementation(
    async (args: { where: { OR?: Clause[] }; take: number }) => {
      const matched = store
        .filter((r) => passesBoundary(r, args.where))
        // orderBy [{ lastActivityAt: desc }, { id: desc }]
        .sort((a, b) => {
          const t = b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
          return t || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
        });
      return matched.slice(0, args.take).map((r) => ({ ...r }));
    }
  );
  countMock.mockImplementation(async () => store.length);
});

/** Traverse the whole list newest→oldest exactly as `listMineKeyset` does. */
async function traverse(limit: number): Promise<Row[]> {
  const collected: Row[] = [];
  let cursor: { ts: Date; id: string } | null = null;
  let guard = 0;
  for (;;) {
    // The service over-fetches limit+1 and slices for an exact hasMore.
    const { rows } = (await communityRepository.listMineByActivityKeyset({
      userId: USER,
      cursor,
      limit: limit + 1,
    })) as unknown as { rows: Row[] };

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    collected.push(...page);
    if (!hasMore || page.length === 0) break;
    const last = page[page.length - 1]!;
    // nextCursor = `${lastActivityAtMs}_${id}` → parsed back to the keyset.
    cursor = { ts: last.lastActivityAt, id: last.id };
    if (++guard > 10_000) throw new Error("runaway pagination");
  }
  return collected;
}

function mk(i: number, ts: number): Row {
  return { id: String(i).padStart(24, "0"), lastActivityAt: new Date(ts) };
}

describe("communities/mine cursor= — compound keyset gap-safety", () => {
  it("reaches EVERY community exactly once across dense same-millisecond clusters", async () => {
    const base = 1_784_000_000_000;
    // 97 communities, clusters of 3 share one lastActivityAt ms → clusters
    // routinely straddle a page boundary at limit 10 (the V1 leak point).
    store = Array.from({ length: 97 }, (_, i) =>
      mk(i, base + Math.floor(i / 3) * 1000)
    );

    const ids = (await traverse(10)).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect([...ids].sort()).toEqual(store.map((r) => r.id).sort()); // all reachable
  });

  it("ALL communities sharing ONE millisecond are fully reachable across tiny pages", async () => {
    const t = 1_784_104_753_870;
    // 25 communities in the EXACT same ms (page size 4 < 25 → many boundaries).
    store = Array.from({ length: 25 }, (_, i) => mk(i, t));

    const ids = (await traverse(4)).map((r) => r.id).sort();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(store.map((r) => r.id).sort()); // none skipped at edges
  });

  it("newest page has NO boundary; a continuation page uses the compound $or", async () => {
    const base = 1_784_000_000_000;
    store = Array.from({ length: 5 }, (_, i) => mk(i, base + i * 1000));

    await communityRepository.listMineByActivityKeyset({
      userId: USER,
      cursor: null,
      limit: 3,
    });
    expect(findManyMock.mock.calls[0]![0].where.OR).toBeUndefined();

    const cursorTs = new Date(base + 2000);
    await communityRepository.listMineByActivityKeyset({
      userId: USER,
      cursor: { ts: cursorTs, id: "000000000000000000000009" },
      limit: 3,
    });
    const where = findManyMock.mock.calls[1]![0].where;
    expect(where.OR).toEqual([
      { lastActivityAt: { lt: cursorTs } },
      { lastActivityAt: cursorTs, id: { lt: "000000000000000000000009" } },
    ]);
    // Newest-first ordering with the id tiebreaker, both descending.
    expect(findManyMock.mock.calls[1]![0].orderBy).toEqual([
      { lastActivityAt: "desc" },
      { id: "desc" },
    ]);
  });
});
