/** AIMESS-382: a community the owner left or dismissed no longer holds a create-limit slot. */
const communityFindMany = jest.fn();
const memberCount = jest.fn();

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    community: { findMany: communityFindMany },
    communityMember: { count: memberCount },
  },
}));

jest.mock("../../src/repositories/community.repository.js", () =>
  jest.requireActual("../../src/repositories/community.repository.js")
);

import { communityRepository } from "../../src/repositories/community.repository.js";

describe("countOwnedCommunities", () => {
  beforeEach(() => {
    communityFindMany.mockReset();
    memberCount.mockReset();
  });

  it("is 0 without touching memberships when the user owns nothing", async () => {
    communityFindMany.mockResolvedValue([]);
    await expect(communityRepository.countOwnedCommunities("u1")).resolves.toBe(0);
    expect(memberCount).not.toHaveBeenCalled();
  });

  it("counts only owned communities where the owner is still ACTIVE and not dismissed", async () => {
    communityFindMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    memberCount.mockResolvedValue(1);

    await expect(communityRepository.countOwnedCommunities("u1")).resolves.toBe(1);

    const where = memberCount.mock.calls[0][0].where;
    expect(where.userId).toBe("u1");
    expect(where.communityId).toEqual({ in: ["c1", "c2"] });
    expect(where.status).toBe("ACTIVE");
    expect(where.OR).toEqual([{ dismissedAt: { isSet: false } }, { dismissedAt: null }]);
  });
});
