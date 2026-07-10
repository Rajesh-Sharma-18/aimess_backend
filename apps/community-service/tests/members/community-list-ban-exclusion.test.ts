/**
 * "My Communities" list must exclude BANNED and LEFT members — the single
 * `status: ACTIVE` filter in listMineByActivity is what makes ban/unban
 * removal from the list immediate with no extra list-management code, and
 * what keeps an unbanned-but-not-rejoined user out of the list.
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

const db = prisma.community as unknown as { findMany: jest.Mock; count: jest.Mock };

describe("communityRepository.listMineByActivity — ban/unban list exclusion", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.findMany.mockResolvedValue([]);
    db.count.mockResolvedValue(0);
  });

  it("filters strictly to an ACTIVE membership row — BANNED and LEFT members never match", async () => {
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
            some: { userId: "user-1", status: "ACTIVE" },
          },
        }),
      })
    );
  });
});
