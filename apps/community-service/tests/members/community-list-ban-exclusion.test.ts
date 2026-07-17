/**
 * "My Communities" list visibility (business rules):
 *  - ACTIVE  → visible.
 *  - BANNED  → visible UNTIL the caller dismisses it (dismissedAt set) — the
 *    community stays in the list even though every action on it is denied
 *    with USER_BANNED.
 *  - LEFT    → never visible, whether voluntary or an admin kick (removedAt
 *    is an audit-only marker) — both rejoin via the normal flow.
 * listMineByActivity encodes this as:
 *   status=ACTIVE OR (status=BANNED AND dismissedAt unset)
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

const EXPECTED_MEMBER_FILTER = {
  some: {
    userId: "user-1",
    OR: [
      { status: "ACTIVE" },
      { status: "BANNED", dismissedAt: { isSet: false } },
    ],
  },
};

describe("communityRepository.listMineByActivity — visibility filter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.findMany.mockResolvedValue([]);
    db.count.mockResolvedValue(0);
  });

  it("matches ACTIVE, or BANNED not yet dismissed — LEFT (voluntary OR kicked) and dismissed-BANNED never match", async () => {
    await communityRepository.listMineByActivity({
      userId: "user-1",
      direction: "before",
      ts: new Date("2026-07-01T00:00:00.000Z"),
      limit: 20,
    });

    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          members: EXPECTED_MEMBER_FILTER,
        }),
      })
    );
  });

  it("also applies the same filter to the total count query", async () => {
    await communityRepository.listMineByActivity({
      userId: "user-1",
      direction: "before",
      ts: new Date("2026-07-01T00:00:00.000Z"),
      limit: 20,
    });

    expect(db.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          members: EXPECTED_MEMBER_FILTER,
        }),
      })
    );
  });
});
