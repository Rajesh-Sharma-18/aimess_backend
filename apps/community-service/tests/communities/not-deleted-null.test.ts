/**
 * Soft-delete filter must treat an explicit `deletedAt: null` as active, not just
 * an unset field — `banana` (deletedAt: null) 404'd from /by-handle.
 */
jest.unmock("../../src/repositories/community.repository.js");

jest.mock("../../src/config/prisma.js", () => ({
  prisma: { community: { findFirst: jest.fn(async () => null) } },
}));

import { prisma } from "../../src/config/prisma.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const findFirst = prisma.community.findFirst as unknown as jest.Mock;

describe("findByHandleFull soft-delete filter", () => {
  it("matches rows whose deletedAt is unset OR null", async () => {
    await communityRepository.findByHandleFull("banana");
    const where = findFirst.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("deletedAt");
    expect(where.AND).toContainEqual({
      OR: expect.arrayContaining([
        { deletedAt: { isSet: false } },
        { deletedAt: null },
      ]),
    });
  });
});
