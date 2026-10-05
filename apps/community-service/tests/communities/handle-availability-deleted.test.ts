/**
 * `findByHandle` backs the handle-availability check. It must see soft-deleted
 * communities: their rows keep the handle in the `communities_handle_key`
 * unique index, so reporting the handle as available would only make the
 * create fail with COMMUNITY_HANDLE_TAKEN afterwards.
 *
 * Same Prisma-boundary mocking as `normalized-search-fields-sync.test.ts`.
 */

jest.unmock("../../src/repositories/community.repository.js");

jest.mock("../../src/config/prisma.js", () => ({
  prisma: { community: { findFirst: jest.fn() } },
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

const findFirstMock = (
  prisma as unknown as { community: { findFirst: jest.Mock } }
).community.findFirst;

it("findByHandle does not filter out soft-deleted communities", async () => {
  findFirstMock.mockResolvedValue({ id: "c1" });

  await communityRepository.findByHandle("mission_aimess");

  const where = findFirstMock.mock.calls[0][0].where;
  expect(where).not.toHaveProperty("deletedAt");
  expect(where.handle).toEqual({ equals: "mission_aimess", mode: "insensitive" });
});
