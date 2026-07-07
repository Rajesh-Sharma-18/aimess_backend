/**
 * GrpcUserDirectoryRepository.list — fullName + email mapping (Admin User List).
 *
 * Requirements:
 *   - fullName = trimmed `firstName + " " + lastName`; falls back to whichever
 *     single part exists; null when both are absent.
 *   - email is null when empty/undefined/missing (never an empty string).
 *
 * Mirrors the mocking pattern in user-directory-status-filter.test.ts: auth-
 * service supplies identity (id/email/account), user-service supplies the
 * display profile (username/firstName/lastName), batched in ONE
 * `adminGetProfilesByIds` call keyed by the page's userIds.
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
const mockAdminGetProfilesByIds = jest.fn();
jest.mock("../../src/grpc/auth.client.js", () => ({
  authClient: { adminListUsers: mockAdminListUsers },
}));
jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: { adminGetProfilesByIds: mockAdminGetProfilesByIds },
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

const authUser = (id: string, email: string) => ({
  id,
  email,
  account: id,
  status: "ACTIVE",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const profile = (userId: string, firstName: string, lastName: string) => ({
  userId,
  username: userId,
  avatarUrl: "",
  firstName,
  lastName,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("GrpcUserDirectoryRepository.list — fullName + email mapping", () => {
  const repo = new GrpcUserDirectoryRepository(prismaUserDirectoryRepository);

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserIndexFindMany.mockResolvedValue([]);
  });

  it('fullName = firstName + " " + lastName when both exist', async () => {
    mockAdminListUsers.mockResolvedValue({
      users: [authUser("u1", "u1@x.com")],
      total: 1,
    });
    mockAdminGetProfilesByIds.mockResolvedValue([profile("u1", "John", "Doe")]);

    const result = await repo.list(baseQuery());

    expect(result.data[0].fullName).toBe("John Doe");
  });

  it("trims extra whitespace around each part", async () => {
    mockAdminListUsers.mockResolvedValue({
      users: [authUser("u1", "u1@x.com")],
      total: 1,
    });
    mockAdminGetProfilesByIds.mockResolvedValue([
      profile("u1", "  John  ", "  Doe  "),
    ]);

    const result = await repo.list(baseQuery());

    expect(result.data[0].fullName).toBe("John Doe");
  });

  it("falls back to firstName only when lastName is absent", async () => {
    mockAdminListUsers.mockResolvedValue({
      users: [authUser("u1", "u1@x.com")],
      total: 1,
    });
    mockAdminGetProfilesByIds.mockResolvedValue([profile("u1", "John", "")]);

    const result = await repo.list(baseQuery());

    expect(result.data[0].fullName).toBe("John");
  });

  it("falls back to lastName only when firstName is absent", async () => {
    mockAdminListUsers.mockResolvedValue({
      users: [authUser("u1", "u1@x.com")],
      total: 1,
    });
    mockAdminGetProfilesByIds.mockResolvedValue([profile("u1", "", "Doe")]);

    const result = await repo.list(baseQuery());

    expect(result.data[0].fullName).toBe("Doe");
  });

  it("is null when both firstName and lastName are absent", async () => {
    mockAdminListUsers.mockResolvedValue({
      users: [authUser("u1", "u1@x.com")],
      total: 1,
    });
    mockAdminGetProfilesByIds.mockResolvedValue([profile("u1", "", "")]);

    const result = await repo.list(baseQuery());

    expect(result.data[0].fullName).toBeNull();
  });

  it("is null when the profile itself is missing (no gRPC hit)", async () => {
    mockAdminListUsers.mockResolvedValue({
      users: [authUser("u1", "u1@x.com")],
      total: 1,
    });
    mockAdminGetProfilesByIds.mockResolvedValue([]);

    const result = await repo.list(baseQuery());

    expect(result.data[0].fullName).toBeNull();
  });

  it("email is returned as-is when present", async () => {
    mockAdminListUsers.mockResolvedValue({
      users: [authUser("u1", "u1@x.com")],
      total: 1,
    });
    mockAdminGetProfilesByIds.mockResolvedValue([profile("u1", "John", "Doe")]);

    const result = await repo.list(baseQuery());

    expect(result.data[0].email).toBe("u1@x.com");
  });

  it('email is null (never an empty string) when auth-service returns ""', async () => {
    mockAdminListUsers.mockResolvedValue({
      users: [authUser("u1", "")],
      total: 1,
    });
    mockAdminGetProfilesByIds.mockResolvedValue([profile("u1", "John", "Doe")]);

    const result = await repo.list(baseQuery());

    expect(result.data[0].email).toBeNull();
  });

  it("existing fields (userId, username, status, isBanned) remain unchanged", async () => {
    mockAdminListUsers.mockResolvedValue({
      users: [authUser("u1", "u1@x.com")],
      total: 1,
    });
    mockAdminGetProfilesByIds.mockResolvedValue([profile("u1", "John", "Doe")]);

    const result = await repo.list(baseQuery());

    expect(result.data[0]).toMatchObject({
      userId: "u1",
      username: "u1",
      status: "ACTIVE",
      moderationStatus: "ACTIVE",
      isBanned: false,
    });
  });
});
