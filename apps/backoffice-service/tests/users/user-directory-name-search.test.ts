/**
 * GrpcUserDirectoryRepository.list — display-name search (Admin User List).
 *
 * Bug: the list is driven by auth-service's `adminListUsers`, which can only
 * match `email` + `account`. The username shown in the table and the user's
 * first/last name live on user-service's UserProfile, so searching for either
 * matched nothing — "username search doesn't work" / "full name search doesn't
 * work".
 *
 * Fix: resolve the same term against user-service (`adminSearchProfileIds` —
 * the helper report.repository/livestream.repository already use) and hand the
 * resulting id set to auth as `searchUserIds`, which auth OR-s into its own
 * email/account match rather than AND-ing it like `userIds`.
 */
const mockUserIndexFindMany = jest.fn(async () => [] as unknown[]);
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

const mockAdminSearchProfileIds = jest.fn();
jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: {
    adminGetProfilesByIds: jest.fn(async () => []),
    adminSearchProfileIds: mockAdminSearchProfileIds,
  },
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

describe("GrpcUserDirectoryRepository.list — display-name search", () => {
  const repo = new GrpcUserDirectoryRepository(prismaUserDirectoryRepository);

  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminListUsers.mockResolvedValue({ users: [], total: 0 });
    mockAdminSearchProfileIds.mockResolvedValue([]);
  });

  it("resolves the search term against user-service profiles and forwards the ids as searchUserIds", async () => {
    mockAdminSearchProfileIds.mockResolvedValue(["u-1", "u-2"]);

    await repo.list(baseQuery({ search: "Jon Snow" }));

    expect(mockAdminSearchProfileIds).toHaveBeenCalledWith("Jon Snow");
    const req = mockAdminListUsers.mock.calls[0][0];
    // The raw term still goes to auth (email/account match) — the profile ids
    // are an ADDITIONAL OR arm, not a replacement.
    expect(req.search).toBe("Jon Snow");
    expect(req.searchUserIds).toEqual(["u-1", "u-2"]);
  });

  it("does not call user-service when there is no search term", async () => {
    await repo.list(baseQuery());

    expect(mockAdminSearchProfileIds).not.toHaveBeenCalled();
    expect(mockAdminListUsers.mock.calls[0][0].searchUserIds).toBeUndefined();
  });

  it("degrades to email/account-only search when user-service is down", async () => {
    mockAdminSearchProfileIds.mockRejectedValue(new Error("upstream down"));

    await expect(repo.list(baseQuery({ search: "nilam" }))).resolves.toEqual(
      expect.objectContaining({ data: [] })
    );

    const req = mockAdminListUsers.mock.calls[0][0];
    expect(req.search).toBe("nilam");
    expect(req.searchUserIds).toEqual([]);
  });

  it("keeps the reports-bucket prefilter in userIds, separate from searchUserIds (AND vs OR)", async () => {
    // aggregateReportCounts runs two groupBys — by targetId (type "user") and
    // by reportedUserId (everything else). Only the first needs a hit here.
    mockReportGroupBy.mockImplementation(async ({ by }: { by: string[] }) =>
      by[0] === "targetId"
        ? [{ targetId: "reported-1", _count: { _all: 3 } }]
        : []
    );
    mockAdminSearchProfileIds.mockResolvedValue(["u-1"]);

    await repo.list(baseQuery({ search: "Jon", reports: "has" }));

    const req = mockAdminListUsers.mock.calls[0][0];
    expect(req.userIds).toEqual(["reported-1"]);
    expect(req.searchUserIds).toEqual(["u-1"]);
  });
});
