/**
 * A friend you already accepted must stay in YOUR friend list even if they set
 * `whoCanFindMe: NO_ONE` — that scope gates DISCOVERY, not an existing edge.
 * Regression: `findUsersInList` used to merge `discoverableWhere`, so those
 * friends vanished from the picker while `GET /users/friends` still listed them.
 */
const findMany = jest.fn().mockResolvedValue([]);
const count = jest.fn().mockResolvedValue(0);

jest.mock("../../src/config/prisma.js", () => ({
  prisma: { userProfile: { findMany, count } },
}));

import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";

const FRIEND_IDS = ["a", "b"];

describe("findUsersInList / countUsersInList", () => {
  beforeEach(() => {
    findMany.mockClear();
    count.mockClear();
  });

  it("does not apply the whoCanFindMe discovery gate", async () => {
    await userProfileRepository.findUsersInList(FRIEND_IDS, "al", 0, 20);
    await userProfileRepository.countUsersInList(FRIEND_IDS, "al");

    for (const spy of [findMany, count]) {
      const { where } = spy.mock.calls[0][0];
      expect(JSON.stringify(where)).not.toContain("privacySettings");
      expect(where.userId).toEqual({ in: FRIEND_IDS });
      expect(where.deletedAt).toBeNull();
    }
  });

  it("orders by a unique tiebreaker so paging cannot drop rows", async () => {
    await userProfileRepository.findUsersInList(FRIEND_IDS, undefined, 20, 20);

    expect(findMany.mock.calls[0][0].orderBy).toEqual([
      { firstName: "asc" },
      { userId: "asc" },
    ]);
  });
});
