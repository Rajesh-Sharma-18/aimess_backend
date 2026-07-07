/**
 * GrpcUserDirectoryRepository.list — status filter (Admin User List).
 *
 * Bug: `status=active` (and `status=banned`) forwarded the raw filter straight
 * to auth-service's `adminListUsers`, which matches against `AuthUser.status`.
 * That column is authoritative ONLY for ACTIVE/DELETED — no admin ban/suspend/
 * unban flow ever writes BANNED/SUSPENDED there (see resolveModerationStatus in
 * user-directory.repository.ts). So `status=active` kept including users the
 * UserIndex mirror had banned (their live auth status stayed ACTIVE), and
 * `status=banned` matched nothing (auth never sets that value).
 *
 * Fix: resolve the filter against the UserIndex mirror at the DB level —
 * `excludeUserIds` (new, real `NOT IN` on auth-service's own query) for
 * ACTIVE, `userIds` (existing constrain-to-these-ids mechanism, same one the
 * reports-bucket prefilter already uses) for BANNED — instead of trusting
 * auth's status column or filtering the result set in memory.
 */
const mockUserIndexFindMany = jest.fn();
const mockReportGroupBy = jest.fn(async () => [] as unknown[]);
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    userIndex: { findMany: mockUserIndexFindMany },
    report: { groupBy: mockReportGroupBy },
  },
}));

const mockAdminListUsers = jest.fn();
jest.mock("../../src/grpc/auth.client.js", () => ({
  authClient: { adminListUsers: mockAdminListUsers },
}));
jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: { adminGetProfilesByIds: jest.fn(async () => []) },
}));
jest.mock("../../src/repositories/moderation-action.repository.js", () => ({
  moderationActionRepository: {
    latestBanActionsByTargets: jest.fn(async () => new Map()),
  },
}));

import {
  GrpcUserDirectoryRepository,
  prismaUserDirectoryRepository,
} from "../../src/repositories/user-directory.repository.js";
import type { ListUsersQuery } from "../../src/types/user-management.types.js";

function baseQuery(overrides: Partial<ListUsersQuery> = {}): ListUsersQuery {
  return { sort: "joinedAt:desc", page: 1, limit: 20, ...overrides };
}

const authUser = (id: string, status = "ACTIVE") => ({
  id,
  email: `${id}@x.com`,
  account: id,
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("GrpcUserDirectoryRepository.list — status filter", () => {
  const repo = new GrpcUserDirectoryRepository(prismaUserDirectoryRepository);

  beforeEach(() => {
    jest.clearAllMocks();
    // mirrorIdsByStatus / mirrorModerationMap are distinguished by `where` shape.
    mockUserIndexFindMany.mockImplementation(async ({ where }) => {
      if (where?.status)
        return [{ userId: "banned-1" }, { userId: "banned-2" }];
      return [];
    });
    mockAdminListUsers.mockResolvedValue({ users: [], total: 0 });
  });

  it("status=ACTIVE excludes UserIndex-mirror-banned ids via the DB query, not in-memory", async () => {
    mockAdminListUsers.mockResolvedValue({
      users: [authUser("active-1")],
      total: 1,
    });

    const result = await repo.list(baseQuery({ status: ["ACTIVE"] }));

    expect(mockUserIndexFindMany).toHaveBeenCalledWith({
      where: { status: { in: ["BANNED", "SUSPENDED"] } },
      select: { userId: true },
    });
    expect(mockAdminListUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ["ACTIVE"],
        excludeUserIds: ["banned-1", "banned-2"],
      })
    );
    expect(result.data).toHaveLength(1);
    expect(result.data[0].userId).toBe("active-1");
    expect(result.data[0].isBanned).toBe(false);
  });

  it("status=BANNED constrains to the mirror ids and never forwards status to auth", async () => {
    mockAdminListUsers.mockResolvedValue({
      // auth's own status is still ACTIVE for this user — the mirror is what
      // actually recorded the ban.
      users: [authUser("banned-1", "ACTIVE")],
      total: 1,
    });

    const result = await repo.list(baseQuery({ status: ["BANNED"] }));

    const req = mockAdminListUsers.mock.calls[0][0];
    expect(req.userIds).toEqual(["banned-1", "banned-2"]);
    expect(req.status).toBeUndefined();
    expect(result.data).toHaveLength(1);
  });

  it("status=BANNED with no mirror rows short-circuits to an empty page without calling auth", async () => {
    mockUserIndexFindMany.mockResolvedValueOnce([]);

    const result = await repo.list(baseQuery({ status: ["BANNED"] }));

    expect(mockAdminListUsers).not.toHaveBeenCalled();
    expect(result.data).toEqual([]);
    expect(result.pagination.total).toBe(0);
  });

  it("status=all (no filter) skips the mirror query and forwards no status constraint", async () => {
    mockAdminListUsers.mockResolvedValue({ users: [], total: 0 });

    await repo.list(baseQuery());

    expect(mockUserIndexFindMany).not.toHaveBeenCalled();
    const req = mockAdminListUsers.mock.calls[0][0];
    expect(req.status).toBeUndefined();
    expect(req.excludeUserIds).toBeUndefined();
  });

  it("reports-bucket prefilter intersects with the BANNED mirror-id constraint", async () => {
    mockUserIndexFindMany.mockImplementation(async ({ where }) => {
      if (where?.status)
        return [{ userId: "banned-1" }, { userId: "banned-2" }];
      return [];
    });
    mockReportGroupBy.mockResolvedValue([
      { targetId: "banned-1", _count: { _all: 3 } },
    ]);
    mockAdminListUsers.mockResolvedValue({
      users: [authUser("banned-1")],
      total: 1,
    });

    await repo.list(baseQuery({ status: ["BANNED"], reports: "has" }));

    const req = mockAdminListUsers.mock.calls[0][0];
    // Only banned-1 matches BOTH the reports bucket and the banned mirror set.
    expect(req.userIds).toEqual(["banned-1"]);
  });
});
