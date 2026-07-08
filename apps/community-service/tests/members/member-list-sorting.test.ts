jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    communityMember: {
      aggregateRaw: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));
jest.unmock("../../src/repositories/community.repository.js");

import { prisma } from "../../src/config/prisma.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const db = prisma.communityMember as unknown as {
  aggregateRaw: jest.Mock;
  findMany: jest.Mock;
  count: jest.Mock;
};

const COMMUNITY_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const CALLER_ID = "me";

const member = (id: string, userId: string, role: string) => ({
  id,
  userId,
  role,
  status: "ACTIVE",
  joinedAt: new Date("2026-01-01T00:00:00.000Z"),
  snapshotUsername: userId,
  snapshotDisplayName: userId,
  snapshotAvatarKey: null,
  bannedAt: null,
  bannedBy: null,
  banReason: null,
});

describe("communityRepository.listMembers sorting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.count.mockResolvedValue(5);
  });

  it("paginates by caller-first, admins, moderators, members while preserving id order inside buckets", async () => {
    db.aggregateRaw.mockResolvedValue([
      { _id: { $oid: "id-me" } },
      { _id: { $oid: "id-admin" } },
      { _id: { $oid: "id-mod" } },
    ]);
    db.findMany.mockResolvedValue([
      member("id-mod", "mod", "MODERATOR"),
      member("id-me", CALLER_ID, "MEMBER"),
      member("id-admin", "admin", "ADMIN"),
    ]);

    const result = await communityRepository.listMembers({
      communityId: COMMUNITY_ID,
      callerId: CALLER_ID,
      status: "ACTIVE" as never,
      page: 2,
      limit: 3,
    });

    expect(result.rows.map((row) => row.userId)).toEqual([
      CALLER_ID,
      "admin",
      "mod",
    ]);
    expect(db.aggregateRaw).toHaveBeenCalledWith({
      pipeline: expect.arrayContaining([
        {
          $match: {
            communityId: { $oid: COMMUNITY_ID },
            status: "ACTIVE",
          },
        },
        expect.objectContaining({
          $addFields: expect.objectContaining({
            _sortPriority: expect.objectContaining({
              $switch: expect.objectContaining({
                branches: expect.arrayContaining([
                  { case: { $eq: ["$userId", CALLER_ID] }, then: 0 },
                  { case: { $eq: ["$role", "ADMIN"] }, then: 1 },
                  { case: { $eq: ["$role", "MODERATOR"] }, then: 2 },
                ]),
              }),
            }),
          }),
        }),
        { $sort: { _sortPriority: 1, _id: 1 } },
        { $skip: 3 },
        { $limit: 3 },
      ]),
    });
  });
});
