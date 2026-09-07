/**
 * Repository-level coverage for `communityRepository.listDiscoverable`'s keyset
 * (`cursor`) mode — the `id desc` page backing `GET /communities/mine` search.
 *
 * Same Prisma-boundary mocking as `list-discoverable-search.test.ts`: the global
 * setup auto-mocks the whole repository module, so `jest.unmock` opts this file
 * back into the real one and the actual query args are what get asserted.
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

const CURSOR = "aaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(() => {
  findManyMock.mockReset();
  countMock.mockReset();
  findManyMock.mockResolvedValue([]);
  countMock.mockResolvedValue(0);
});

describe("communityRepository.listDiscoverable — keyset (cursor) mode", () => {
  it("bounds on `id < cursor`, drops skip, and runs no count", async () => {
    const result = await communityRepository.listDiscoverable({
      q: "text",
      page: 1,
      limit: 20,
      cursor: CURSOR,
    });

    const args = findManyMock.mock.calls[0][0];
    expect(args.where.AND).toContainEqual({ id: { lt: CURSOR } });
    expect(args.skip).toBeUndefined();
    expect(args.take).toBe(20);
    expect(args.orderBy).toEqual({ id: "desc" });
    expect(countMock).not.toHaveBeenCalled();
    // -1 = not counted; callers page on the row count, never on totalPage.
    expect(result.total).toBe(-1);
  });

  it("keeps the offset path (skip + count) when no cursor is sent", async () => {
    countMock.mockResolvedValue(7);

    const result = await communityRepository.listDiscoverable({
      q: "text",
      page: 3,
      limit: 10,
    });

    const args = findManyMock.mock.calls[0][0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
    expect(args.where.AND).not.toContainEqual(
      expect.objectContaining({ id: { lt: expect.anything() } })
    );
    expect(countMock).toHaveBeenCalled();
    expect(result.total).toBe(7);
  });
});
