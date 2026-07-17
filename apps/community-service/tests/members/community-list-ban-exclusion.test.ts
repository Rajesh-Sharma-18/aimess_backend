/**
 * "My Communities" list must exclude a genuine voluntary LEFT but KEEP a
 * BANNED or KICKED member's community visible (restricted-access model:
 * both stay read-only/isolated, not removed from the list, until the caller
 * dismisses them). listMineByActivity matches ACTIVE/BANNED directly, or
 * LEFT rows that carry a `removedAt` kick marker (kickMember sets status=LEFT
 * + removedAt so every existing rejoin-flow "reactivate a LEFT row" check
 * keeps working unmodified) — a plain LEFT row (removedAt null) still drops out.
 */
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    community: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));
jest.unmock("../../src/repositories/community.repository.js");

import { prisma } from "../../src/config/prisma.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const db = prisma.community as unknown as {
  findMany: jest.Mock;
  count: jest.Mock;
};

describe("communityRepository.listMineByActivity — restricted-access list inclusion", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.findMany.mockResolvedValue([]);
    db.count.mockResolvedValue(0);
  });

  it("matches ACTIVE/BANNED directly, OR a LEFT row with removedAt set (kicked, not yet dismissed) — a plain LEFT (removedAt null) never matches", async () => {
    await communityRepository.listMineByActivity({
      userId: "user-1",
      direction: "before",
      ts: new Date("2026-07-01T00:00:00.000Z"),
      limit: 20,
    });

    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          members: {
            some: {
              userId: "user-1",
              OR: [
                { status: { in: ["ACTIVE", "BANNED"] } },
                { status: "LEFT", removedAt: { not: null } },
              ],
            },
          },
        }),
      })
    );
  });

  it("also applies the same OR filter to the total count query", async () => {
    await communityRepository.listMineByActivity({
      userId: "user-1",
      direction: "before",
      ts: new Date("2026-07-01T00:00:00.000Z"),
      limit: 20,
    });

    expect(db.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          members: {
            some: {
              userId: "user-1",
              OR: [
                { status: { in: ["ACTIVE", "BANNED"] } },
                { status: "LEFT", removedAt: { not: null } },
              ],
            },
          },
        }),
      })
    );
  });
});
