/**
 * Reports & Moderation Details aggregate — the composition rules the
 * route-level spec (reports.test.ts) exercises only via a mocked service:
 * community fetches only fire when the report has a communityId,
 * `reportedMessage` is only populated for MESSAGE-targeted reports, and the
 * user avatar keys returned by `reportRepository.getCore` are presigned
 * (never returned raw).
 */
jest.mock("../../src/repositories/index.js", () => ({
  adminUserRepository: { findById: jest.fn() },
  reportRepository: { getCore: jest.fn() },
}));
jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: { adminGetCommunitiesByIds: jest.fn() },
}));
jest.mock("../../src/services/user-avatar.service.js", () => ({
  userAvatarService: {
    resolveAvatarOrNull: jest.fn(async (key: string | null) =>
      key
        ? {
            objectKey: key,
            downloadUrl: `https://cdn.example/${key}`,
            fileId: null,
          }
        : null
    ),
  },
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => undefined) },
}));

import { moderationService } from "../../src/services/moderation.service.js";
import { reportRepository } from "../../src/repositories/index.js";
import { communityClient } from "../../src/grpc/community.client.js";

const getCore = reportRepository.getCore as jest.Mock;
const adminGetCommunitiesByIds =
  communityClient.adminGetCommunitiesByIds as jest.Mock;

const baseCore = {
  reportId: "RPT-2026-0000001",
  reportType: "USER",
  targetType: "USER",
  reporterNote: null as string | null,
  status: "PENDING",
  createdAt: "2026-01-01T00:00:00.000Z",
  communityId: null as string | null,
  target: { type: "USER", id: "u_1" },
  reportedUser: {
    id: "u_1",
    username: "jdoe",
    displayName: "John Doe",
    // reportRepository.getCore already resolves the avatar (see toUserRef) —
    // toModerationUserRef passes it through, no re-presign.
    avatar: {
      objectKey: "avatars/u_1.png",
      downloadUrl: "https://cdn.example/avatars/u_1.png",
      fileId: null,
    },
  },
  reporterUser: {
    id: "u_2",
    username: "asmith",
    displayName: "Alice Smith",
    avatar: null,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("moderationService.getReportModerationDetail", () => {
  it("returns null when the report does not exist (→ 404 upstream)", async () => {
    getCore.mockResolvedValue(null);
    const result =
      await moderationService.getReportModerationDetail("RPT-MISSING");
    expect(result).toBeNull();
    expect(adminGetCommunitiesByIds).not.toHaveBeenCalled();
  });

  it("shapes reportedUser/reporter with a presigned avatar and no community block when communityId is null", async () => {
    getCore.mockResolvedValue(baseCore);

    const result = await moderationService.getReportModerationDetail(
      baseCore.reportId
    );

    expect(result?.report).toEqual({
      id: baseCore.reportId,
      type: "USER",
      status: "PENDING",
      createdAt: baseCore.createdAt,
      reportedUser: {
        id: "u_1",
        username: "jdoe",
        fullName: "John Doe",
        avatar: {
          objectKey: "avatars/u_1.png",
          downloadUrl: "https://cdn.example/avatars/u_1.png",
          fileId: null,
        },
      },
      reporter: {
        id: "u_2",
        username: "asmith",
        fullName: "Alice Smith",
        avatar: null,
      },
    });
    expect(result?.community).toBeNull();
    // No community context → gRPC fan-out should not fire.
    expect(adminGetCommunitiesByIds).not.toHaveBeenCalled();
  });

  it("fetches community details when the report has a communityId", async () => {
    getCore.mockResolvedValue({
      ...baseCore,
      communityId: "comm_1",
      targetType: "MESSAGE",
      target: { type: "MESSAGE", id: "msg_42" },
    });
    adminGetCommunitiesByIds.mockResolvedValue(
      new Map([
        [
          "comm_1",
          {
            communityId: "comm_1",
            name: "Indie Devs",
            avatarUrl: "https://community-cdn.example/comm_1.png",
            categoryId: "cat_1",
            categoryName: "Gaming",
            categorySlug: "gaming",
            memberCount: 42,
          },
        ],
      ])
    );

    const result =
      await moderationService.getReportModerationDetail("RPT-2026-0000001");

    expect(adminGetCommunitiesByIds).toHaveBeenCalledWith(["comm_1"]);
    expect(result?.community).toEqual({
      id: "comm_1",
      name: "Indie Devs",
      avatar: {
        objectKey: "https://community-cdn.example/comm_1.png",
        downloadUrl:
          "https://cdn.example/https://community-cdn.example/comm_1.png",
        fileId: null,
      },
      category: { id: "cat_1", name: "Gaming" },
      reportedDate: baseCore.createdAt,
      reportedMessage: { id: "msg_42" },
    });
    expect(result?.members).toBeUndefined();
  });

  it("returns reportedMessage: null when the report is community-based but not message-based", async () => {
    getCore.mockResolvedValue({
      ...baseCore,
      communityId: "comm_1",
      targetType: "COMMUNITY",
      target: { type: "COMMUNITY", id: "comm_1" },
    });
    adminGetCommunitiesByIds.mockResolvedValue(new Map());

    const result =
      await moderationService.getReportModerationDetail("RPT-2026-0000001");

    expect(result?.community?.reportedMessage).toBeNull();
  });

  it("includes otherReason only when reportType is OTHER", async () => {
    getCore.mockResolvedValue({
      ...baseCore,
      reportType: "OTHER",
      reporterNote: "Custom free-text reason",
    });

    const result = await moderationService.getReportModerationDetail(
      baseCore.reportId
    );

    expect(result?.report.type).toBe("OTHER");
    expect(result?.report.otherReason).toBe("Custom free-text reason");
  });

  it("omits otherReason when reportType is not OTHER", async () => {
    getCore.mockResolvedValue(baseCore);

    const result = await moderationService.getReportModerationDetail(
      baseCore.reportId
    );

    expect(result?.report).not.toHaveProperty("otherReason");
  });
});
