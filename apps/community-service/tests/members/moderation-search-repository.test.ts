jest.unmock("../../src/repositories/community.repository.js");
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    communityMember: { findMany: jest.fn(), count: jest.fn() },
    communityMemberMute: { findMany: jest.fn(), count: jest.fn() },
  },
}));

import { prisma } from "../../src/config/prisma.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const db = prisma as unknown as {
  communityMember: { findMany: jest.Mock; count: jest.Mock };
  communityMemberMute: { findMany: jest.Mock; count: jest.Mock };
};
const communityId = "a".repeat(24);
const now = new Date("2026-09-22T00:00:00Z");

beforeEach(() => {
  db.communityMember.findMany.mockResolvedValue([{ userId: "peter" }]);
  db.communityMember.count.mockResolvedValue(1);
  db.communityMemberMute.findMany.mockResolvedValue([{ userId: "peter" }]);
  db.communityMemberMute.count.mockResolvedValue(1);
});

it.each(["Peter", "peter_parker", "PETER"])(
  "searches muted identities before pagination: %s",
  async (search) => {
    await communityRepository.listMutedMembers({
      communityId,
      now,
      page: 3,
      limit: 20,
      search: ` ${search} `,
    });
    expect(db.communityMember.findMany).toHaveBeenCalledWith({
      where: {
        communityId,
        OR: [
          { snapshotDisplayName: { contains: search, mode: "insensitive" } },
          { snapshotUsername: { contains: search, mode: "insensitive" } },
          { userId: { contains: search, mode: "insensitive" } },
        ],
      },
      select: { userId: true },
    });
    const where = {
      communityId,
      OR: [{ mutedUntil: null }, { mutedUntil: { gt: now } }],
      userId: { in: ["peter"] },
    };
    expect(db.communityMemberMute.findMany).toHaveBeenCalledWith({
      where,
      orderBy: { id: "desc" },
      skip: 40,
      take: 20,
    });
    expect(db.communityMemberMute.count).toHaveBeenCalledWith({ where });
  }
);

it("a name with no matches cannot return unrelated muted users", async () => {
  db.communityMember.findMany.mockResolvedValue([]);
  await communityRepository.listMutedMembers({
    communityId,
    now,
    page: 1,
    limit: 20,
    search: "missing",
  });
  expect(db.communityMemberMute.findMany.mock.calls[0][0].where.userId).toEqual(
    { in: [] }
  );
});

it("clearing search restores the full active mute population", async () => {
  await communityRepository.listMutedMembers({
    communityId,
    now,
    page: 2,
    limit: 20,
  });
  expect(db.communityMember.findMany).not.toHaveBeenCalled();
  expect(db.communityMemberMute.findMany.mock.calls[0][0]).toEqual({
    where: {
      communityId,
      OR: [{ mutedUntil: null }, { mutedUntil: { gt: now } }],
    },
    orderBy: { id: "desc" },
    skip: 20,
    take: 20,
  });
});

it.each(["Peter", "peter_parker", "PETER"])(
  "keeps banned status and community constraints with search: %s",
  async (search) => {
    await communityRepository.listBannedMembers({
      communityId,
      search,
      page: 2,
      limit: 20,
      sortBy: "bannedAt",
      sortOrder: "desc",
    });
    const args = db.communityMember.findMany.mock.calls[0][0];
    expect(args).toMatchObject({
      skip: 20,
      take: 20,
      where: {
        communityId,
        status: "BANNED",
        OR: [
          { snapshotDisplayName: { contains: search, mode: "insensitive" } },
          { snapshotUsername: { contains: search, mode: "insensitive" } },
          { userId: { contains: search, mode: "insensitive" } },
        ],
      },
    });
    expect(db.communityMember.count).toHaveBeenCalledWith({
      where: args.where,
    });
  }
);
