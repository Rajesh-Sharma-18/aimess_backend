/**
 * Reports & Moderation Details aggregate — the composition rules the
 * route-level spec (reports.test.ts) exercises only via a mocked service:
 *  - reportType is derived from the reported ENTITY (USER vs COMMUNITY vs
 *    LIVESTREAM vs MESSAGE), never the reason category;
 *  - a private USER report carries no community/communityAdmin/livestream/message;
 *  - community/communityAdmin fetches only fire when the report has a communityId;
 *  - the user avatar keys returned by `reportRepository.getCore` are presigned
 *    (never returned raw).
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
jest.mock("../../src/grpc/stream.client.js", () => ({
  streamClient: { adminGetStream: jest.fn() },
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
  resolveStreamThumbnailOrNull: jest.fn(async (key: string | null) =>
    key
      ? {
          objectKey: key,
          downloadUrl: `https://stream-cdn.example/${key}`,
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
import { streamClient } from "../../src/grpc/stream.client.js";

const getCore = reportRepository.getCore as jest.Mock;
const adminGetCommunity = communityClient.adminGetCommunity as jest.Mock;
const adminGetProfile = userClient.adminGetProfile as jest.Mock;
const adminGetStream = streamClient.adminGetStream as jest.Mock;

const baseCore = {
  reportId: "RPT-2026-0000001",
  reportType: "SPAM",
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

const communityRow = {
  communityId: "comm_1",
  name: "Indie Devs",
  handle: "@indie_devs",
  communityAvatarUrl: "comm_1.png",
  adminId: "u_admin",
  adminName: "Alice Wonder",
  adminUsername: "alice_124",
  adminAvatarUrl: "avatars/u_admin.png",
};

const adminProfileRow = {
  userId: "u_admin",
  username: "alice_124",
  firstName: "Alice",
  lastName: "Wonder",
  avatarUrl: "avatars/u_admin.png",
  createdAt: "2026-01-01T00:00:00.000Z",
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

  it("USER report: flat report + reporter/reportedUser, no entity blocks", async () => {
    getCore.mockResolvedValue(baseCore);

    const result = await moderationService.getReportModerationDetail(
      baseCore.reportId
    );

    expect(result).toEqual({
      id: baseCore.reportId,
      reportType: "USER",
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
    });
    // USER report omits the community/livestream/message keys entirely.
    expect(result).not.toHaveProperty("community");
    expect(result).not.toHaveProperty("communityAdmin");
    expect(result).not.toHaveProperty("livestream");
    expect(result).not.toHaveProperty("message");
    // No community context → gRPC fan-out should not fire.
    expect(adminGetCommunity).not.toHaveBeenCalled();
    expect(adminGetProfile).not.toHaveBeenCalled();
  });

  it("COMMUNITY report (member reported inside a community): reportType=COMMUNITY + community + communityAdmin", async () => {
    getCore.mockResolvedValue({ ...baseCore, communityId: "comm_1" });
    adminGetCommunity.mockResolvedValue({
      found: true,
      community: communityRow,
    });
    adminGetProfile.mockResolvedValue(adminProfileRow);

    const result =
      await moderationService.getReportModerationDetail("RPT-2026-0000001");

    expect(result?.reportType).toBe("COMMUNITY");
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
    // COMMUNITY report has no livestream/message blocks.
    expect(result).not.toHaveProperty("livestream");
    expect(result).not.toHaveProperty("message");
  });

  it("falls back to the community-service admin snapshot when the user-service profile lookup misses", async () => {
    getCore.mockResolvedValue({ ...baseCore, communityId: "comm_1" });
    adminGetCommunity.mockResolvedValue({
      found: true,
      community: {
        ...communityRow,
        communityAvatarUrl: "",
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

    expect(result?.reportType).toBe("COMMUNITY");
    expect(result?.community).toBeNull();
    expect(result?.communityAdmin).toBeNull();
    expect(adminGetProfile).not.toHaveBeenCalled();
  });

  it("LIVESTREAM report: reportType=LIVESTREAM + livestream block + community + communityAdmin", async () => {
    getCore.mockResolvedValue({
      ...baseCore,
      targetType: "STREAM",
      communityId: "comm_1",
      target: { type: "STREAM", id: "stream_1" },
      reportedUser: null,
    });
    adminGetStream.mockResolvedValue({
      id: "stream_1",
      communityId: "comm_1",
      creatorId: "u_host",
      title: "Live Coding",
      description: "building stuff",
      thumbnail: "thumb_1.png",
      status: "ENDED",
      viewerCount: 3,
      totalViews: 40,
      uniqueViewerCount: 12,
      durationSeconds: 3600,
      livedAt: 1783741100000,
      endedAt: 1783744700000,
      createdAt: 1783741000000,
    });
    adminGetCommunity.mockResolvedValue({
      found: true,
      community: communityRow,
    });
    adminGetProfile.mockImplementation(async (id: string) =>
      id === "u_host"
        ? {
            userId: "u_host",
            username: "hoster",
            firstName: "Hattie",
            lastName: "Host",
            avatarUrl: "avatars/u_host.png",
            createdAt: "2026-01-01T00:00:00.000Z",
          }
        : adminProfileRow
    );

    const result =
      await moderationService.getReportModerationDetail("RPT-2026-0000001");

    expect(result?.reportType).toBe("LIVESTREAM");
    expect(adminGetStream).toHaveBeenCalledWith("stream_1");
    expect(result?.livestream).toEqual({
      id: "stream_1",
      title: "Live Coding",
      description: "building stuff",
      status: "ENDED",
      thumbnail: {
        objectKey: "thumb_1.png",
        downloadUrl: "https://stream-cdn.example/thumb_1.png",
        fileId: null,
      },
      // ENDED → distinct-user count, not the raw totalViews call-counter.
      viewerCount: 12,
      activeViewerCount: 0,
      duration: 3_600_000,
      startedAt: 1783741100000,
      endedAt: 1783744700000,
      host: {
        id: "u_host",
        username: "hoster",
        firstName: "Hattie",
        lastName: "Host",
        fullName: "Hattie Host",
        avatar: {
          objectKey: "avatars/u_host.png",
          downloadUrl: "https://cdn.example/avatars/u_host.png",
          fileId: null,
        },
      },
    });
    expect(result?.community?.id).toBe("comm_1");
    expect(result?.communityAdmin?.id).toBe("u_admin");
    expect(result).not.toHaveProperty("message");
  });

  it("MESSAGE report: reportType=MESSAGE + message block + community + communityAdmin", async () => {
    getCore.mockResolvedValue({
      ...baseCore,
      targetType: "MESSAGE",
      communityId: "comm_1",
      target: { type: "MESSAGE", id: "msg_1" },
    });
    adminGetCommunity.mockResolvedValue({
      found: true,
      community: communityRow,
    });
    adminGetProfile.mockResolvedValue(adminProfileRow);

    const result =
      await moderationService.getReportModerationDetail("RPT-2026-0000001");

    expect(result?.reportType).toBe("MESSAGE");
    expect(result?.message).toEqual({
      id: "msg_1",
      messageType: null,
      text: null,
      content: null,
      media: [],
      sentAt: null,
      // reported sender resolved from the report's reportedUser.
      senderId: "u_1",
    });
    expect(result?.community?.id).toBe("comm_1");
    expect(result?.communityAdmin?.id).toBe("u_admin");
    expect(adminGetStream).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("livestream");
  });
});
