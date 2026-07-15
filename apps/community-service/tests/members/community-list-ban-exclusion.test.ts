/**
 * "My Communities" list must include ACTIVE and BANNED members (a ban revokes
 * access only, never roster visibility — the community stays in the banned
 * user's list, locked), exclude LEFT members, and exclude any row the caller
 * manually removed from their list (`removedAt`). See listMineByActivity.
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

describe("communityRepository.listMineByActivity — ban/unban list inclusion", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.findMany.mockResolvedValue([]);
    db.count.mockResolvedValue(0);
  });

  it("matches ACTIVE or BANNED, excludes LEFT, and excludes a manually-removed row", async () => {
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
              status: { in: ["ACTIVE", "BANNED"] },
              OR: [{ removedAt: null }, { removedAt: { isSet: false } }],
            },
          },
        }),
      })
    );
  });

  it("V2 keyset variant uses the identical membership filter", async () => {
    await communityRepository.listMineByActivityKeyset({
      userId: "user-1",
      cursor: null,
      limit: 20,
    });

    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          members: {
            some: {
              userId: "user-1",
              status: { in: ["ACTIVE", "BANNED"] },
              OR: [{ removedAt: null }, { removedAt: { isSet: false } }],
            },
          },
        }),
      })
    );
  });
});
