/**
 * userManagementService.getUser (GET /v1/users/:userId, aliased at
 * /v1/users/:userId/details) — the real service/repository composition, not
 * the controller-level mock used by user-management.test.ts.
 *
 * Root cause fixed here: `getUser` used to run TWO independent
 * `prisma.report.groupBy(["reason"])` queries (`buildReportsSummary`'s
 * top-5 `topReasons` AND `reportDetailRepository.categoryCounts`'s full
 * `reportCategories`) against the exact same rows, producing overlapping,
 * duplicated data in the response (`reportsSummary.topReasons` was a strict
 * subset of `reportCategories`). It also fetched the user-service profile via
 * `userClient.adminGetProfile` but discarded `firstName`/`lastName`, and
 * returned `email: ""` instead of `null` when auth-service had none on file.
 *
 * Fixed shape: ONE `categoryCounts` query backs both `topReasons` (predefined
 * reasons only, "OTHER" excluded) and `reportCount` (sum across ALL reasons).
 * `otherReasons` is net-new — the free-text `details` notes filed under the
 * custom "OTHER" reason (each with its reporter + timestamp), previously
 * never surfaced anywhere in this endpoint.
 * `reporter`/`reportDate` reuse the existing paginated
 * `reportDetailRepository.listForUser` (page 1, limit 1) instead of a new
 * query. `moderationHistory`/`stats`/`reportCategories`/`avatarUrl` are
 * dropped from the response entirely (per UI requirements).
 */
const mockReportGroupBy = jest.fn();
const mockReportFindMany = jest.fn(async () => [] as unknown[]);
const mockReportCount = jest.fn(async () => 0);
const mockModerationActionFindMany = jest.fn(async () => [] as unknown[]);
const mockUserIndexFindUnique = jest.fn(async () => null as unknown);

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    report: {
      groupBy: mockReportGroupBy,
      findMany: mockReportFindMany,
      count: mockReportCount,
    },
    moderationAction: { findMany: mockModerationActionFindMany },
    userIndex: { findUnique: mockUserIndexFindUnique },
  },
}));

const mockAdminGetUser = jest.fn();
jest.mock("../../src/grpc/auth.client.js", () => ({
  authClient: { adminGetUser: mockAdminGetUser },
}));

const mockAdminGetProfile = jest.fn();
const mockAdminGetProfilesByIds = jest.fn(async () => [] as unknown[]);
jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: {
    adminGetProfile: mockAdminGetProfile,
    adminGetProfilesByIds: mockAdminGetProfilesByIds,
  },
}));

import { userManagementService } from "../../src/services/index.js";

const USER_ID = "user-123";

const authRecord = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: USER_ID,
  email: "u1@x.com",
  account: "u1",
  status: "ACTIVE",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  deletedAt: null,
  suspendedAt: null,
  suspendedReason: null,
  ...overrides,
});

const reportRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "r1",
  reason: "SPAM",
  details: null,
  status: "open",
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  reporterId: "reporter-1",
  ...over,
});

describe("userManagementService.getUser — profile fullName/email", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReportGroupBy.mockResolvedValue([]);
    mockReportFindMany.mockResolvedValue([]);
    mockReportCount.mockResolvedValue(0);
    mockModerationActionFindMany.mockResolvedValue([]);
    mockAdminGetProfilesByIds.mockResolvedValue([]);
  });

  it('fullName = firstName + " " + lastName when both exist', async () => {
    mockAdminGetUser.mockResolvedValue(authRecord());
    mockAdminGetProfile.mockResolvedValue({
      userId: USER_ID,
      username: "u1",
      avatarUrl: "",
      firstName: "John",
      lastName: "Doe",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await userManagementService.getUser(USER_ID);

    expect(result?.profile.fullName).toBe("John Doe");
  });

  it("falls back to the single available part", async () => {
    mockAdminGetUser.mockResolvedValue(authRecord());
    mockAdminGetProfile.mockResolvedValue({
      userId: USER_ID,
      username: "u1",
      avatarUrl: "",
      firstName: "John",
      lastName: "",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await userManagementService.getUser(USER_ID);

    expect(result?.profile.fullName).toBe("John");
  });

  it("is null when both firstName and lastName are absent", async () => {
    mockAdminGetUser.mockResolvedValue(authRecord());
    mockAdminGetProfile.mockResolvedValue(null);

    const result = await userManagementService.getUser(USER_ID);

    expect(result?.profile.fullName).toBeNull();
  });

  it("email is null (never an empty string) when auth-service has none on file", async () => {
    mockAdminGetUser.mockResolvedValue(authRecord({ email: "" }));
    mockAdminGetProfile.mockResolvedValue(null);

    const result = await userManagementService.getUser(USER_ID);

    expect(result?.profile.email).toBeNull();
  });

  it("email is returned as-is when present", async () => {
    mockAdminGetUser.mockResolvedValue(authRecord({ email: "u1@x.com" }));
    mockAdminGetProfile.mockResolvedValue(null);

    const result = await userManagementService.getUser(USER_ID);

    expect(result?.profile.email).toBe("u1@x.com");
  });

  it("does not return avatarUrl/avatarUrlExpiresIn (only the nested avatar object)", async () => {
    mockAdminGetUser.mockResolvedValue(authRecord());
    mockAdminGetProfile.mockResolvedValue(null);

    const result = await userManagementService.getUser(USER_ID);

    expect(result?.profile).not.toHaveProperty("avatarUrl");
    expect(result?.profile).not.toHaveProperty("avatarUrlExpiresIn");
    expect(result?.profile).toHaveProperty("avatar");
  });
});

describe("userManagementService.getUser — reportDetails", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminGetUser.mockResolvedValue(authRecord());
    mockAdminGetProfile.mockResolvedValue(null);
    mockModerationActionFindMany.mockResolvedValue([]);
  });

  it("returns an all-empty reportDetails block when the user has no reports", async () => {
    mockReportGroupBy.mockResolvedValue([]);
    mockReportFindMany.mockResolvedValue([]);
    mockReportCount.mockResolvedValue(0);

    const result = await userManagementService.getUser(USER_ID);

    expect(result?.reportDetails).toEqual({
      reporter: null,
      reportDate: null,
      reportCount: 0,
      topReasons: [],
      otherReasons: [],
    });
  });

  it("excludes OTHER from topReasons and aggregates duplicate predefined reasons", async () => {
    // categoryCounts (grouped by reason)
    mockReportGroupBy.mockResolvedValueOnce([
      { reason: "SPAM", _count: { _all: 3 } },
      { reason: "HARASSMENT", _count: { _all: 2 } },
      { reason: "OTHER", _count: { _all: 4 } },
    ]);
    // otherReasonNotes (findMany where reason=OTHER)
    mockReportFindMany.mockImplementationOnce(async () => [
      {
        details: "Fake profile pictures",
        reporterId: "reporter-2",
        createdAt: new Date("2026-06-10T00:00:00.000Z"),
      },
      {
        details: "  Impersonating a celebrity  ",
        reporterId: "reporter-3",
        createdAt: new Date("2026-06-09T00:00:00.000Z"),
      },
      {
        details: null,
        reporterId: "reporter-4",
        createdAt: new Date("2026-06-08T00:00:00.000Z"),
      },
    ]);
    // otherReasonNotes's own reporter-profile batch resolve
    mockAdminGetProfilesByIds.mockResolvedValueOnce([
      {
        userId: "reporter-2",
        username: "carol",
        avatarUrl: "",
        firstName: "",
        lastName: "",
        createdAt: "",
      },
      {
        userId: "reporter-3",
        username: "dave",
        avatarUrl: "",
        firstName: "",
        lastName: "",
        createdAt: "",
      },
    ]);
    // listForUser: count + findMany (newest first)
    mockReportCount.mockResolvedValueOnce(9);
    mockReportFindMany.mockImplementationOnce(async () => [
      reportRow({ reason: "OTHER", reporterId: "reporter-1" }),
    ]);
    mockAdminGetProfilesByIds.mockResolvedValueOnce([
      {
        userId: "reporter-1",
        username: "alice",
        avatarUrl: "",
        firstName: "",
        lastName: "",
        createdAt: "",
      },
    ]);

    const result = await userManagementService.getUser(USER_ID);

    // Raw enum values normalize to their canonical display label.
    expect(result?.reportDetails.topReasons).toEqual([
      { reason: "Spam Messages", count: 3 },
      { reason: "Harassment", count: 2 },
    ]);
    expect(result?.reportDetails.reportCount).toBe(9); // 3 + 2 + 4, incl. OTHER
    expect(result?.reportDetails.otherReasons).toEqual([
      {
        description: "Fake profile pictures",
        reportedBy: "carol",
        reportedAt: "2026-06-10T00:00:00.000Z",
      },
      {
        description: "Impersonating a celebrity",
        reportedBy: "dave",
        reportedAt: "2026-06-09T00:00:00.000Z",
      },
    ]);
  });

  it("reporter/reportDate come from the single most recent report", async () => {
    mockReportGroupBy.mockResolvedValueOnce([
      { reason: "SPAM", _count: { _all: 1 } },
    ]);
    mockReportFindMany.mockImplementationOnce(async () => []); // otherReasonNotes
    mockReportCount.mockResolvedValueOnce(1);
    mockReportFindMany.mockImplementationOnce(async () => [
      reportRow({
        reason: "SPAM",
        reporterId: "reporter-9",
        createdAt: new Date("2026-06-15T12:00:00.000Z"),
      }),
    ]);
    mockAdminGetProfilesByIds.mockResolvedValueOnce([
      {
        userId: "reporter-9",
        username: "bob",
        avatarUrl: "",
        firstName: "",
        lastName: "",
        createdAt: "",
      },
    ]);

    const result = await userManagementService.getUser(USER_ID);

    expect(result?.reportDetails.reporter).toBe("bob");
    expect(result?.reportDetails.reportDate).toBe("2026-06-15T12:00:00.000Z");
  });

  it("response has no moderationHistory, stats, or reportCategories fields", async () => {
    mockReportGroupBy.mockResolvedValue([]);
    mockReportFindMany.mockResolvedValue([]);
    mockReportCount.mockResolvedValue(0);

    const result = await userManagementService.getUser(USER_ID);

    expect(result).not.toHaveProperty("moderationHistory");
    expect(result).not.toHaveProperty("stats");
    expect(result).not.toHaveProperty("reportCategories");
    expect(result).not.toHaveProperty("reportsSummary");
  });

  it("still resolves accountStatus.appliedBy from moderation history internally", async () => {
    mockReportGroupBy.mockResolvedValue([]);
    mockReportFindMany.mockResolvedValue([]);
    mockReportCount.mockResolvedValue(0);
    mockModerationActionFindMany.mockResolvedValue([
      {
        id: "ma1",
        type: "ban_user",
        actorId: "admin-1",
        reason: "SPAM",
        metadata: null,
        reportId: null,
        expiresAt: null,
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    ]);

    const result = await userManagementService.getUser(USER_ID);

    expect(result?.accountStatus.appliedBy).toBe("admin-1");
  });
});
