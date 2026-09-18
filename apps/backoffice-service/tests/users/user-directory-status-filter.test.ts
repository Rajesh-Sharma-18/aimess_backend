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

/**
 * The regression that actually reached the panel: the filter was changed to
 * forward `status` straight to auth-service, whose `AuthUser.status` has no
 * SUSPENDED value at all — `adminSetAccountStatus` accepts only BANNED|ACTIVE,
 * and neither POST /suspend nor a time-boxed ban calls it. So a suspended user
 * was ACTIVE upstream and got filed backwards in both directions.
 *
 * These pin the user-visible contract rather than the wire shape: a suspension
 * is an active ban (deriveModerationStatus), so it belongs under Banned and
 * must never be returned by the Active filter — least of all on a row this same
 * response stamps `isBanned: true`.
 */
describe("GrpcUserDirectoryRepository.list — suspended users are banned users", () => {
  const repo = new GrpcUserDirectoryRepository(prismaUserDirectoryRepository);

  /** Mirror: `suspended-1` is SUSPENDED; auth still reports it ACTIVE. */
  const mirrorSuspended = () => {
    mockUserIndexFindMany.mockImplementation(async ({ where }) => {
      if (where?.status) return [{ userId: "suspended-1" }];
      return [
        {
          userId: "suspended-1",
          status: "SUSPENDED",
          bannedAt: new Date("2026-09-01T00:00:00.000Z"),
          banReason: "SPAM",
          suspendedUntil: new Date("2026-09-08T00:00:00.000Z"),
        },
      ];
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminListUsers.mockResolvedValue({ users: [], total: 0 });
  });

  it("returns a mirror-suspended user under status=BANNED", async () => {
    mirrorSuspended();
    mockAdminListUsers.mockResolvedValue({
      users: [authUser("suspended-1", "ACTIVE")],
      total: 1,
    });

    const result = await repo.list(baseQuery({ status: ["BANNED"] }));

    expect(result.data).toHaveLength(1);
    expect(result.data[0].status).toBe("SUSPENDED");
    expect(result.data[0].isBanned).toBe(true);
    expect(result.data[0].moderationStatus).toBe("BANNED");
  });

  it("excludes a mirror-suspended user from status=ACTIVE", async () => {
    mirrorSuspended();

    await repo.list(baseQuery({ status: ["ACTIVE"] }));

    // The exclusion happens in auth's own query, so the row never comes back
    // at all — it is not fetched and then dropped from the page. That keeps
    // `total` exact, which is why there is deliberately no second, in-memory
    // isBanned guard on this branch: it would make the most-used filter's
    // count approximate to defend against an upstream that is already tested
    // (auth-service's admin-users-status-filter suite covers excludeUserIds).
    expect(mockAdminListUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ["ACTIVE"],
        excludeUserIds: ["suspended-1"],
      })
    );
  });
});

/**
 * ACTIVE+BANNED together cannot be one upstream query — the halves live in
 * different columns in different databases — so the page is narrowed after each
 * row's status is resolved. Restored alongside the mirror-based filter; without
 * a test the branch is dead weight nobody notices breaking.
 */
describe("GrpcUserDirectoryRepository.list — mixed status selection", () => {
  const repo = new GrpcUserDirectoryRepository(prismaUserDirectoryRepository);

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserIndexFindMany.mockImplementation(async ({ where }) => {
      if (where?.status) return [{ userId: "banned-1" }];
      return [
        {
          userId: "banned-1",
          status: "BANNED",
          bannedAt: new Date("2026-09-01T00:00:00.000Z"),
          banReason: "SPAM",
          suspendedUntil: null,
        },
      ];
    });
  });

  it("keeps both halves and drops everything else, without constraining auth", async () => {
    mockAdminListUsers.mockResolvedValue({
      users: [
        authUser("active-1"),
        authUser("banned-1", "ACTIVE"),
        authUser("deleted-1", "DELETED"),
      ],
      total: 3,
    });

    const result = await repo.list(
      baseQuery({ status: ["ACTIVE", "BANNED"] })
    );

    const req = mockAdminListUsers.mock.calls[0][0];
    expect(req.status).toBeUndefined();
    expect(req.excludeUserIds).toBeUndefined();
    expect(req.userIds).toBeUndefined();

    expect(result.data.map((r) => r.userId).sort()).toEqual([
      "active-1",
      "banned-1",
    ]);
  });
});
