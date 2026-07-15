/**
 * Report Details "Users" list (GET /reports/:reportId/users) — the single
 * endpoint serving both report kinds. Verifies:
 *  - null (→ 404) when the report doesn't exist;
 *  - COMMUNITY/MESSAGE reports return the reported community's members, mapped
 *    to the unified shape (handle→username, member.username→displayName, BANNED
 *    status surfaced as role), sortBy→community sortField, slim pagination;
 *  - LIVESTREAM reports return the stream's viewer sessions (type→role), with
 *    unsupported search/role/sort accepted-but-ignored;
 *  - a plain USER report (no community) returns an empty page;
 *  - a deleted stream (repo throws NotFound) degrades to an empty page, not 404.
 */
jest.mock("../../src/repositories/index.js", () => ({
  adminUserRepository: { findById: jest.fn() },
  reportRepository: { getCore: jest.fn() },
  communityMembersRepository: { listMembers: jest.fn() },
  livestreamRepository: { listUsers: jest.fn() },
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
  resolveAvatarOrNull: jest.fn(async () => null),
  resolveCommunityImageOrNull: jest.fn(async () => null),
  resolveStreamThumbnailOrNull: jest.fn(async () => null),
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => undefined) },
}));

import { NotFoundError } from "@aimess/errors";

import { moderationService } from "../../src/services/moderation.service.js";
import {
  reportRepository,
  communityMembersRepository,
  livestreamRepository,
} from "../../src/repositories/index.js";

const getCore = reportRepository.getCore as jest.Mock;
const listMembers = communityMembersRepository.listMembers as jest.Mock;
const listUsers = livestreamRepository.listUsers as jest.Mock;

const baseCore = {
  reportId: "RPT-1",
  reportType: "SPAM",
  targetType: "USER",
  reason: "SPAM",
  reporterNote: null,
  status: "PENDING",
  createdAt: 1,
  updatedAt: 1,
  communityId: null as string | null,
  target: { type: "USER", id: "u_1" },
  reportedUser: null,
  reporterUser: null,
};

const fullPagination = (over: Partial<Record<string, number>> = {}) => ({
  mode: "offset" as const,
  page: 1,
  limit: 20,
  total: 1,
  totalApprox: 1,
  totalPages: 1,
  hasNext: false,
  hasPrev: false,
  nextCursor: null,
  ...over,
});

const query = {
  page: 1,
  limit: 20,
  sortBy: "joinedAt" as const,
  sortDir: "desc" as const,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("moderationService.listReportUsers", () => {
  it("returns null when the report does not exist (→ 404 upstream)", async () => {
    getCore.mockResolvedValue(null);
    const result = await moderationService.listReportUsers(
      "RPT-MISSING",
      query
    );
    expect(result).toBeNull();
    expect(listMembers).not.toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
  });

  it("COMMUNITY report: returns mapped community members + slim pagination", async () => {
    getCore.mockResolvedValue({ ...baseCore, communityId: "comm_1" });
    listMembers.mockResolvedValue({
      data: [
        {
          userId: "u_10",
          username: "John Doe",
          handle: "@jdoe",
          avatar: null,
          role: "MODERATOR",
          status: "ACTIVE",
          joinedAt: 1783745454545,
        },
        {
          userId: "u_11",
          username: "Ann Ban",
          handle: "@aban",
          avatar: null,
          role: "MEMBER",
          status: "BANNED",
          joinedAt: 1783745454999,
        },
      ],
      pagination: fullPagination({ total: 2, totalPages: 1 }),
    });

    const result = await moderationService.listReportUsers("RPT-1", {
      ...query,
      search: "john",
      role: "MODERATOR",
      sortBy: "username",
      sortDir: "asc",
    });

    // sortBy=username → community sortField=username; filters passed through.
    expect(listMembers).toHaveBeenCalledWith("comm_1", {
      search: "john",
      role: "MODERATOR",
      page: 1,
      limit: 20,
      sortField: "username",
      sortDir: "asc",
    });
    expect(result?.items[0]).toEqual({
      userId: "u_10",
      username: "jdoe", // handle, @ stripped
      displayName: "John Doe",
      avatar: null,
      role: "MODERATOR",
      joinedAt: 1783745454545,
    });
    // Banned member surfaces role BANNED (status, not role, upstream).
    expect(result?.items[1].role).toBe("BANNED");
    expect(result?.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 2,
      totalPages: 1,
    });
  });

  it("COMMUNITY report: sortBy=role maps to community sortField=role (honors asc/desc)", async () => {
    getCore.mockResolvedValue({ ...baseCore, communityId: "comm_1" });
    listMembers.mockResolvedValue({
      data: [],
      pagination: fullPagination({ total: 0, totalPages: 0 }),
    });

    await moderationService.listReportUsers("RPT-1", {
      ...query,
      sortBy: "role",
      sortDir: "desc",
    });

    expect(listMembers).toHaveBeenCalledWith(
      "comm_1",
      expect.objectContaining({ sortField: "role", sortDir: "desc" })
    );
  });

  it("LIVESTREAM report: passes search/role through and maps sortBy→listUsers sortField (type→role)", async () => {
    getCore.mockResolvedValue({
      ...baseCore,
      targetType: "STREAM",
      target: { type: "STREAM", id: "stream_1" },
    });
    listUsers.mockResolvedValue({
      data: [
        {
          no: 1,
          userId: "u_20",
          username: "hoster",
          handle: "@hoster",
          avatar: null,
          joinedAt: 1783745454545,
          leftAt: null,
          watchDurationSeconds: 120,
          type: "Admin",
        },
      ],
      pagination: fullPagination({ total: 1, totalPages: 1 }),
    });

    const result = await moderationService.listReportUsers("RPT-1", {
      ...query,
      // Now forwarded to the repository's candidate-set enrichment path.
      search: "host",
      role: "Admin",
      sortBy: "username",
    });

    expect(listUsers).toHaveBeenCalledWith("stream_1", {
      page: 1,
      limit: 20,
      sortField: "username",
      sortDir: "desc",
      search: "host",
      role: "Admin",
    });
    expect(result?.items[0]).toEqual({
      userId: "u_20",
      username: "hoster",
      displayName: "hoster",
      avatar: null,
      role: "Admin",
      joinedAt: 1783745454545,
    });
  });

  it("USER report (no community): returns an empty page without hitting any roster", async () => {
    getCore.mockResolvedValue(baseCore);
    const result = await moderationService.listReportUsers("RPT-1", query);
    expect(result).toEqual({
      items: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
    expect(listMembers).not.toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
  });

  it("LIVESTREAM report with a deleted stream: empty page, not a 404", async () => {
    getCore.mockResolvedValue({
      ...baseCore,
      targetType: "STREAM",
      target: { type: "STREAM", id: "stream_gone" },
    });
    listUsers.mockRejectedValue(new NotFoundError("LIVESTREAM_NOT_FOUND"));

    const result = await moderationService.listReportUsers("RPT-1", query);
    expect(result).toEqual({
      items: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });
});
