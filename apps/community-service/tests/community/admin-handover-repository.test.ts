/**
 * Repository: the admin seat moves only through a claim conditional on
 * Community.adminId (exactly one ADMIN under concurrency), and /communities/mine
 * hides closed communities from everyone but their admin.
 */
jest.unmock("../../src/repositories/community.repository.js");

const tx = {
  community: { updateMany: jest.fn() },
  communityMember: { updateMany: jest.fn() },
};

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    community: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
  },
}));

import { prisma } from "../../src/config/prisma.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const CID = "c".repeat(24);

beforeEach(() => jest.clearAllMocks());

describe("handOverAdmin", () => {
  it("claims the seat on adminId, promotes the successor, demotes the former admin to MODERATOR", async () => {
    tx.community.updateMany.mockResolvedValue({ count: 1 });
    tx.communityMember.updateMany.mockResolvedValue({ count: 1 });

    await expect(communityRepository.handOverAdmin(CID, "old", "new")).resolves.toBe(true);

    expect(tx.community.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: CID, adminId: "old" }),
        data: { adminId: "new" },
      })
    );
    const [promote, demote] = tx.communityMember.updateMany.mock.calls.map((c) => c[0]);
    expect(promote).toMatchObject({ where: { userId: "new", status: "ACTIVE" }, data: { role: "ADMIN" } });
    expect(demote).toMatchObject({ where: { userId: "old", role: "ADMIN" }, data: { role: "MODERATOR" } });
  });

  it("a concurrent loser (adminId already moved) writes nothing", async () => {
    tx.community.updateMany.mockResolvedValue({ count: 0 });

    await expect(communityRepository.handOverAdmin(CID, "old", "new")).resolves.toBe(false);
    expect(tx.communityMember.updateMany).not.toHaveBeenCalled();
  });

  it("rolls back when the successor is no longer ACTIVE", async () => {
    tx.community.updateMany.mockResolvedValue({ count: 1 });
    tx.communityMember.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(communityRepository.handOverAdmin(CID, "old", "new")).resolves.toBe(false);
  });
});

describe("/communities/mine visibility", () => {
  it("V1 and V2 hide CLOSED/SUSPENDED communities unless the viewer is the admin", async () => {
    const findMany = (prisma as unknown as { community: { findMany: jest.Mock } }).community.findMany;
    const visible = {
      OR: [
        { status: { not: "CLOSED" }, moderationStatus: { not: "SUSPENDED" } },
        { adminId: "u1" },
      ],
    };

    await communityRepository.listMineByActivity({ userId: "u1", direction: "before", ts: new Date(), limit: 10 });
    await communityRepository.listMineByActivityKeyset({ userId: "u1", cursor: null, limit: 10 });

    for (const [arg] of findMany.mock.calls) {
      expect(arg.where.AND).toContainEqual(visible);
    }
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
