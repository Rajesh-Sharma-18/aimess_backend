/**
 * Reports & Moderation Details aggregate — the composition rules the
 * route-level spec (reports.test.ts) exercises only via a mocked service:
 * community/communityAdmin fetches only fire when the report has a
 * communityId, and the user avatar keys returned by
 * `reportRepository.getCore` are presigned (never returned raw).
 */
jest.mock("../../src/repositories/index.js", () => ({
  adminUserRepository: { findById: jest.fn() },
  reportRepository: { getCore: jest.fn() },
}));
jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: { adminGetCommunity: jest.fn() },
}));
jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: { adminGetProfile: jest.fn() },
}));
jest.mock("../../src/lib/avatar-media.js", () => ({
  resolveAvatarOrNull: jest.fn(async (key: string | null) =>
    key
      ? {
          objectKey: key,
          downloadUrl: `https://cdn.example/${key}`,
          fileId: null,
        }
      : null
  ),
  resolveCommunityImageOrNull: jest.fn(async (key: string | null) =>
    key
      ? {
          objectKey: key,
          downloadUrl: `https://community-cdn.example/${key}`,
          fileId: null,
        }
      : null
  ),
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => undefined) },
}));

import { moderationService } from "../../src/services/moderation.service.js";
import { reportRepository } from "../../src/repositories/index.js";
import { communityClient } from "../../src/grpc/community.client.js";
import { userClient } from "../../src/grpc/user.client.js";

const getCore = reportRepository.getCore as jest.Mock;
const adminGetCommunity = communityClient.adminGetCommunity as jest.Mock;
const adminGetProfile = userClient.adminGetProfile as jest.Mock;

const baseCore = {
  reportId: "RPT-2026-0000001",
  reportType: "USER",
  targetType: "USER",
  reason: "SPAM",
  reporterNote: "Spam message text",
  status: "PENDING",
  createdAt: 1783741146000,
  updatedAt: 1783741146000,
  communityId: null as string | null,
  target: { type: "USER", id: "u_1" },
  reportedUser: {
    id: "u_1",
    username: "jdoe",
    displayName: "John Doe",
    firstName: "John",
    lastName: "Doe",
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
    firstName: "Alice",
    lastName: "Smith",
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
    expect(adminGetCommunity).not.toHaveBeenCalled();
  });

  it("shapes a flattened report + reporter/reportedUser and no community block when communityId is null", async () => {
    getCore.mockResolvedValue(baseCore);

    const result = await moderationService.getReportModerationDetail(
      baseCore.reportId
    );

    expect(result).toEqual({
      id: baseCore.reportId,
      type: "USER",
      reportReason: "Spam Messages",
      reportMessage: "Spam message text",
      reportStatus: "PENDING",
      createdAt: baseCore.createdAt,
      updatedAt: baseCore.updatedAt,
      reportedUser: {
        id: "u_1",
        username: "jdoe",
        firstName: "John",
        lastName: "Doe",
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
        firstName: "Alice",
        lastName: "Smith",
        fullName: "Alice Smith",
        avatar: null,
      },
      communityAdmin: null,
      community: null,
    });
    // No community context → gRPC fan-out should not fire.
    expect(adminGetCommunity).not.toHaveBeenCalled();
    expect(adminGetProfile).not.toHaveBeenCalled();
  });

  it("fetches community + communityAdmin details when the report has a communityId", async () => {
    getCore.mockResolvedValue({ ...baseCore, communityId: "comm_1" });
    adminGetCommunity.mockResolvedValue({
      found: true,
      community: {
        communityId: "comm_1",
        name: "Indie Devs",
        handle: "@indie_devs",
        communityAvatarUrl: "comm_1.png",
        adminId: "u_admin",
        adminName: "Alice Wonder",
        adminUsername: "alice_124",
        adminAvatarUrl: "avatars/u_admin.png",
      },
    });
    adminGetProfile.mockResolvedValue({
      userId: "u_admin",
      username: "alice_124",
      firstName: "Alice",
      lastName: "Wonder",
      avatarUrl: "avatars/u_admin.png",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result =
      await moderationService.getReportModerationDetail("RPT-2026-0000001");

    expect(adminGetCommunity).toHaveBeenCalledWith("comm_1");
    expect(adminGetProfile).toHaveBeenCalledWith("u_admin");
    expect(result?.community).toEqual({
      id: "comm_1",
      name: "Indie Devs",
      handle: "@indie_devs",
      avatar: {
        objectKey: "comm_1.png",
        downloadUrl: "https://community-cdn.example/comm_1.png",
        fileId: null,
      },
    });
    expect(result?.communityAdmin).toEqual({
      id: "u_admin",
      username: "alice_124",
      firstName: "Alice",
      lastName: "Wonder",
      fullName: "Alice Wonder",
      avatar: {
        objectKey: "avatars/u_admin.png",
        downloadUrl: "https://cdn.example/avatars/u_admin.png",
        fileId: null,
      },
    });
  });

  it("falls back to the community-service admin snapshot when the user-service profile lookup misses", async () => {
    getCore.mockResolvedValue({ ...baseCore, communityId: "comm_1" });
    adminGetCommunity.mockResolvedValue({
      found: true,
      community: {
        communityId: "comm_1",
        name: "Indie Devs",
        handle: "@indie_devs",
        communityAvatarUrl: "",
        adminId: "u_admin",
        adminName: "Alice Wonder",
        adminUsername: "alice_124",
        adminAvatarUrl: "",
      },
    });
    adminGetProfile.mockResolvedValue(null);

    const result =
      await moderationService.getReportModerationDetail("RPT-2026-0000001");

    expect(result?.communityAdmin).toEqual({
      id: "u_admin",
      username: "alice_124",
      firstName: "",
      lastName: "",
      fullName: "Alice Wonder",
      avatar: null,
    });
  });

  it("returns null community/communityAdmin when community-service can't find the community", async () => {
    getCore.mockResolvedValue({ ...baseCore, communityId: "comm_missing" });
    adminGetCommunity.mockResolvedValue({ found: false });

    const result =
      await moderationService.getReportModerationDetail("RPT-2026-0000001");

    expect(result?.community).toBeNull();
    expect(result?.communityAdmin).toBeNull();
    expect(adminGetProfile).not.toHaveBeenCalled();
  });
});
