/**
 * Repository-level coverage for `communityRepository.listDiscoverable`'s `q`
 * search-token handling — the query backing `GET /communities/discover` and
 * the search mode of `GET /communities/mine` (both V1 and V2).
 *
 * Exercises the REAL repository method with only the Prisma I/O boundary
 * mocked (same pattern as `community-reaction-repository.test.ts`):
 * `tests/setup/global-mocks.ts` auto-mocks the ENTIRE community.repository
 * module for every test — `jest.unmock` opts this file back into the real
 * module so the actual `where` clause built from `q` is what gets asserted.
 */

jest.unmock("../../src/repositories/community.repository.js");

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    community: {
      findMany: jest.fn(),
      count: jest.fn(),
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

import { prisma } from "../../src/config/prisma.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const findManyMock = (
  prisma as unknown as { community: { findMany: jest.Mock } }
).community.findMany;
const countMock = (prisma as unknown as { community: { count: jest.Mock } })
  .community.count;

function baseParams(
  overrides: Partial<
    Parameters<typeof communityRepository.listDiscoverable>[0]
  > = {}
) {
  return { page: 1, limit: 20, ...overrides };
}

beforeEach(() => {
  findManyMock.mockReset();
  countMock.mockReset();
  findManyMock.mockResolvedValue([]);
  countMock.mockResolvedValue(0);
});

/** Pulls the `AND` array passed to the most recent `findMany` call. */
function lastFindManyAnd(): Array<Record<string, unknown>> {
  const where = findManyMock.mock.calls[0][0].where;
  return where.AND;
}

/**
 * Narrows an `AND` array down to just the per-token search OR clauses
 * (`{OR: [{normalizedName: ...}, {normalizedHandle: ...}]}`), excluding the
 * visibility OR clause (`{OR: [{type: "PUBLIC"}, ...]}`), which has no
 * `normalizedName` key on its first arm.
 */
function searchClausesOf(
  and: Array<Record<string, unknown>>
): Array<{ OR: Array<Record<string, unknown>> }> {
  return and.filter(
    (c) =>
      "OR" in c && (c.OR as Array<Record<string, unknown>>)[0].normalizedName
  ) as Array<{ OR: Array<Record<string, unknown>> }>;
}

describe("communityRepository.listDiscoverable — search token building", () => {
  it("single-word query: one AND clause, OR over normalizedName/normalizedHandle", async () => {
    await communityRepository.listDiscoverable(baseParams({ q: "text" }));

    const and = lastFindManyAnd();
    const searchClauses = searchClausesOf(and);
    expect(searchClauses).toHaveLength(1);
    expect(searchClauses[0].OR).toEqual([
      { normalizedName: { contains: "text" } },
      { normalizedHandle: { contains: "text" } },
      { name: { contains: "text", mode: "insensitive" } },
      { handle: { contains: "text", mode: "insensitive" } },
    ]);
  });

  it("multi-word query: one AND-ed OR clause PER token", async () => {
    await communityRepository.listDiscoverable(baseParams({ q: "text text1" }));

    const and = lastFindManyAnd();
    const searchClauses = searchClausesOf(and);

    expect(searchClauses).toHaveLength(2);
    expect(searchClauses[0].OR).toEqual([
      { normalizedName: { contains: "text" } },
      { normalizedHandle: { contains: "text" } },
      { name: { contains: "text", mode: "insensitive" } },
      { handle: { contains: "text", mode: "insensitive" } },
    ]);
    expect(searchClauses[1].OR).toEqual([
      { normalizedName: { contains: "text1" } },
      { normalizedHandle: { contains: "text1" } },
      { name: { contains: "text1", mode: "insensitive" } },
      { handle: { contains: "text1", mode: "insensitive" } },
    ]);
  });

  it("is case-insensitive and strips formatting characters (spaces/underscores/hyphens/dots)", async () => {
    await communityRepository.listDiscoverable(baseParams({ q: "Dr._Jhatka" }));

    const and = lastFindManyAnd();
    const searchClauses = searchClausesOf(and);
    // A single whitespace-token ("Dr._Jhatka" has no space) that normalizes
    // to one alnum-only, lowercased string.
    expect(searchClauses).toHaveLength(1);
    expect(searchClauses[0].OR).toEqual([
      { normalizedName: { contains: "drjhatka" } },
      { normalizedHandle: { contains: "drjhatka" } },
      { name: { contains: "Dr._Jhatka", mode: "insensitive" } },
      { handle: { contains: "Dr._Jhatka", mode: "insensitive" } },
    ]);
  });

  it("collapses multiple internal spaces and ignores leading/trailing whitespace", async () => {
    await communityRepository.listDiscoverable(
      baseParams({ q: "  text    text1  " })
    );

    const and = lastFindManyAnd();
    const searchClauses = searchClausesOf(and);

    // Exactly two tokens — no empty-string token from the extra whitespace.
    expect(searchClauses).toHaveLength(2);
    expect(searchClauses[0].OR[0]).toEqual({
      normalizedName: { contains: "text" },
    });
    expect(searchClauses[1].OR[0]).toEqual({
      normalizedName: { contains: "text1" },
    });
  });

  it("omits the search clause entirely when q is absent", async () => {
    await communityRepository.listDiscoverable(baseParams());

    const and = lastFindManyAnd();
    // Only the visibility OR (`{OR: [{type: "PUBLIC"}, ...]}`) should be
    // present — no search OR clause when q wasn't provided.
    expect(searchClausesOf(and)).toHaveLength(0);
  });

  it("preserves pagination (skip/take) and sort order regardless of token count", async () => {
    await communityRepository.listDiscoverable(
      baseParams({ q: "text text1 text2", page: 3, limit: 10 })
    );

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20, // (page 3 - 1) * limit 10
        take: 10,
        orderBy: { id: "desc" },
      })
    );
  });

  it("still applies category and visibility/exclusion filters alongside the search tokens", async () => {
    await communityRepository.listDiscoverable(
      baseParams({
        q: "text text1",
        categoryId: "cat1",
        includeMemberCommunityIds: ["m1"],
        excludeCommunityIds: ["e1"],
      })
    );

    const and = lastFindManyAnd();
    expect(and).toContainEqual({ categoryId: "cat1" });
    expect(and).toContainEqual({ id: { notIn: ["e1"] } });
    expect(and).toContainEqual({
      OR: [{ type: "PUBLIC" }, { id: { in: ["m1"] } }],
    });
    // Plus the two per-token search clauses (normalizedName/normalizedHandle
    // OR each), distinct from the visibility OR above (no normalizedName key).
    expect(searchClausesOf(and)).toHaveLength(2);
  });

  it("returns the repository's total count alongside the page", async () => {
    findManyMock.mockResolvedValue([{ id: "c1" }]);
    countMock.mockResolvedValue(7);

    const result = await communityRepository.listDiscoverable(
      baseParams({ q: "text" })
    );

    expect(result).toEqual({ rows: [{ id: "c1" }], total: 7 });
    // The count query mirrors the same filter (no artificial duplication risk
    // from a separate, looser count clause).
    expect(countMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.any(Object) })
    );
  });

  // A CLOSED community keeps every member, so mine-search must still return it.
  it("keeps CLOSED communities the caller belongs to in mine-search", async () => {
    await communityRepository.listDiscoverable(
      baseParams({ q: "text", includeMemberCommunityIds: ["m1"] })
    );

    expect(lastFindManyAnd()).toContainEqual({
      OR: [{ status: { not: "CLOSED" } }, { id: { in: ["m1"] } }],
    });
  });

  // Public discover has no membership widening, so CLOSED stays hidden there.
  it("excludes CLOSED communities from public discover", async () => {
    await communityRepository.listDiscoverable(
      baseParams({ q: "text", excludeCommunityIds: ["e1"] })
    );

    expect(lastFindManyAnd()).toContainEqual({
      OR: [{ status: { not: "CLOSED" } }],
    });
  });
});
