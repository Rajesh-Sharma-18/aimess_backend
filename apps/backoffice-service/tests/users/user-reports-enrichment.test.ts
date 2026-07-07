/**
 * userManagementService.listUserReports (GET /admin/v1/users/:userId/reports)
 * — the real service/repository composition (reportDetailRepository.listForUser
 * + the two independent enrichment fan-outs), not the controller-level mock
 * used by user-management.test.ts.
 *
 * Verifies the additive fields: `reporter.fullname` (firstName + lastName),
 * `communityId`/`communityName` (batch-resolved via the existing
 * `communityClient.adminGetCommunitiesByIds`, reused from the Livestream
 * Management enrichment path — no new gRPC method), and `otherReason`
 * (== `details` only when `reason === "OTHER"`, else null). All existing
 * fields (reportId, reason, details, status, createdAt, reporter.username/
 * avatar) must be unchanged. `reporter.avatarUrl` was removed in favor of the
 * standard `reporter.avatar` (a MediaObject, null when no avatar is set).
 */
const mockReportFindMany = jest.fn(async () => [] as unknown[]);
const mockReportCount = jest.fn(async () => 0);

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    report: {
      findMany: mockReportFindMany,
      count: mockReportCount,
    },
  },
}));

const mockAdminGetProfilesByIds = jest.fn(async () => [] as unknown[]);
jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: {
    adminGetProfilesByIds: mockAdminGetProfilesByIds,
  },
}));

const mockAdminGetCommunitiesByIds = jest.fn(async () => new Map());
jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: {
    adminGetCommunitiesByIds: mockAdminGetCommunitiesByIds,
  },
}));

import { userManagementService } from "../../src/services/index.js";

const USER_ID = "user-123";

const reportRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "r1",
  reason: "SPAM",
  details: null,
  status: "open",
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  reporterId: "reporter-1",
  communityId: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminGetProfilesByIds.mockResolvedValue([]);
  mockAdminGetCommunitiesByIds.mockResolvedValue(new Map());
});

describe("userManagementService.listUserReports — additive fields", () => {
  it("preserves every existing field unchanged", async () => {
    mockReportCount.mockResolvedValueOnce(1);
    mockReportFindMany.mockResolvedValueOnce([
      reportRow({ reason: "HARASSMENT", details: null, status: "open" }),
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

    const { data } = await userManagementService.listUserReports(
      USER_ID,
      1,
      20
    );

    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      reportId: "r1",
      reason: "HARASSMENT",
      details: null,
      status: "open",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    expect(data[0]!.reporter).toMatchObject({
      userId: "reporter-1",
      username: "alice",
    });
    // Flat avatarUrl removed in favor of the standard `avatar` MediaObject.
    expect(data[0]!.reporter).not.toHaveProperty("avatarUrl");
    expect(data[0]!.reporter).toHaveProperty("avatar");
  });

  it("fullname = firstName + lastName when both exist", async () => {
    mockReportCount.mockResolvedValueOnce(1);
    mockReportFindMany.mockResolvedValueOnce([reportRow()]);
    mockAdminGetProfilesByIds.mockResolvedValueOnce([
      {
        userId: "reporter-1",
        username: "alice",
        avatarUrl: "",
        firstName: "John",
        lastName: "Doe",
        createdAt: "",
      },
    ]);

    const { data } = await userManagementService.listUserReports(
      USER_ID,
      1,
      20
    );

    expect(data[0]!.reporter.fullname).toBe("John Doe");
  });

  it("fullname falls back to the single available part", async () => {
    mockReportCount.mockResolvedValueOnce(1);
    mockReportFindMany.mockResolvedValueOnce([reportRow()]);
    mockAdminGetProfilesByIds.mockResolvedValueOnce([
      {
        userId: "reporter-1",
        username: "alice",
        avatarUrl: "",
        firstName: "John",
        lastName: "",
        createdAt: "",
      },
    ]);

    const { data } = await userManagementService.listUserReports(
      USER_ID,
      1,
      20
    );

    expect(data[0]!.reporter.fullname).toBe("John");
  });

  it("fullname is null when both firstName and lastName are absent", async () => {
    mockReportCount.mockResolvedValueOnce(1);
    mockReportFindMany.mockResolvedValueOnce([reportRow()]);
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

    const { data } = await userManagementService.listUserReports(
      USER_ID,
      1,
      20
    );

    expect(data[0]!.reporter.fullname).toBeNull();
  });

  it("resolves communityName via the batch community lookup (no N+1)", async () => {
    mockReportCount.mockResolvedValueOnce(2);
    mockReportFindMany.mockResolvedValueOnce([
      reportRow({ id: "r1", communityId: "comm_1" }),
      reportRow({ id: "r2", communityId: "comm_1", reporterId: "reporter-2" }),
    ]);
    mockAdminGetProfilesByIds.mockResolvedValueOnce([]);
    mockAdminGetCommunitiesByIds.mockResolvedValueOnce(
      new Map([["comm_1", { communityId: "comm_1", name: "Tech Community" }]])
    );

    const { data } = await userManagementService.listUserReports(
      USER_ID,
      1,
      20
    );

    // ONE batch call for BOTH rows sharing the same community — not one per row.
    expect(mockAdminGetCommunitiesByIds).toHaveBeenCalledTimes(1);
    expect(mockAdminGetCommunitiesByIds).toHaveBeenCalledWith(["comm_1"]);
    expect(data[0]!.communityId).toBe("comm_1");
    expect(data[0]!.communityName).toBe("Tech Community");
    expect(data[1]!.communityName).toBe("Tech Community");
  });

  it("communityId/communityName are null for a community-less report", async () => {
    mockReportCount.mockResolvedValueOnce(1);
    mockReportFindMany.mockResolvedValueOnce([
      reportRow({ communityId: null }),
    ]);
    mockAdminGetProfilesByIds.mockResolvedValueOnce([]);

    const { data } = await userManagementService.listUserReports(
      USER_ID,
      1,
      20
    );

    expect(data[0]!.communityId).toBeNull();
    expect(data[0]!.communityName).toBeNull();
    // Nothing to resolve → the community batch call must not fire.
    expect(mockAdminGetCommunitiesByIds).not.toHaveBeenCalled();
  });

  it("otherReason mirrors details when reason is OTHER", async () => {
    mockReportCount.mockResolvedValueOnce(1);
    mockReportFindMany.mockResolvedValueOnce([
      reportRow({ reason: "OTHER", details: "Shares phishing links." }),
    ]);
    mockAdminGetProfilesByIds.mockResolvedValueOnce([]);

    const { data } = await userManagementService.listUserReports(
      USER_ID,
      1,
      20
    );

    expect(data[0]!.reason).toBe("OTHER");
    expect(data[0]!.otherReason).toBe("Shares phishing links.");
    // The existing `details` field is untouched.
    expect(data[0]!.details).toBe("Shares phishing links.");
  });

  it("otherReason is null for a predefined reason, even if details is set", async () => {
    mockReportCount.mockResolvedValueOnce(1);
    mockReportFindMany.mockResolvedValueOnce([
      reportRow({ reason: "SPAM", details: "leftover legacy text" }),
    ]);
    mockAdminGetProfilesByIds.mockResolvedValueOnce([]);

    const { data } = await userManagementService.listUserReports(
      USER_ID,
      1,
      20
    );

    expect(data[0]!.reason).toBe("SPAM");
    expect(data[0]!.otherReason).toBeNull();
    expect(data[0]!.details).toBe("leftover legacy text");
  });
});
