/**
 * Regression test: `communityService.createReport()` must forward the report's
 * `communityId` on the `admin.report.ingest` event (consumed by
 * backoffice-service into admin_db.Report.communityId), so
 * GET /admin/v1/reports/{reportId} can populate the `community` block.
 *
 * Root cause of the original bug: `publishAdminReportIngestSafe(...)` was
 * called WITHOUT `communityId` even though the community-level/member-level
 * report always has one in scope — every ingested community report silently
 * landed with `communityId: null` in admin_db, so the admin detail endpoint's
 * `core.communityId ? buildCommunityReportBlock(...) : null` ternary always
 * took the null branch, regardless of whether the community actually existed.
 *
 * Only the I/O boundary (repository, publishers) is mocked — mirrors
 * report-content-resolve.test.ts's mocking style.
 */
jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findMemberByUserId: jest.fn(),
    findOpenReportByReporterAndTarget: jest.fn(),
    findReportByReporterAndTarget: jest.fn(),
    createReport: jest.fn(),
    findActiveMemberIdsByRoles: jest.fn(),
    createAuditLog: jest.fn(),
  },
}));

jest.mock("../../src/messaging/publish-admin-report.js", () => ({
  publishAdminReportIngestSafe: jest.fn(),
}));

jest.mock("../../src/messaging/publish-community.js", () => ({
  publishCommunityReportCreatedSafe: jest.fn(),
}));

jest.mock("../../src/grpc/chat.client.js", () => ({
  getChatClient: jest.fn(),
}));

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { publishAdminReportIngestSafe } from "../../src/messaging/publish-admin-report.js";
import { publishCommunityReportCreatedSafe } from "../../src/messaging/publish-community.js";
import { getChatClient } from "../../src/grpc/chat.client.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const ingestSafe = publishAdminReportIngestSafe as jest.Mock;
const communityEventSafe = publishCommunityReportCreatedSafe as jest.Mock;
const chat = getChatClient as jest.Mock;

const CID = "a".repeat(24);
const SELF = "edcfb732-4617-4b19-aa7a-575ca43c24cc";
const TARGET = "15c8a2c9-e759-413d-878c-842dc3066d94";
const REPORT_ROW_ID = "6a3a737f236c483508914d0c";

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue({ id: CID, name: "C", status: "ACTIVE" });
  repo.findMembership.mockResolvedValue({ role: "MEMBER", status: "ACTIVE" });
  repo.findMemberByUserId.mockResolvedValue({
    userId: TARGET,
    status: "ACTIVE",
  });
  repo.findOpenReportByReporterAndTarget.mockResolvedValue(null);
  repo.findReportByReporterAndTarget.mockResolvedValue(null);
  repo.findActiveMemberIdsByRoles.mockResolvedValue([]);
  repo.createAuditLog.mockResolvedValue(undefined);
  repo.createReport.mockImplementation(
    async (data: Record<string, unknown>) => ({
      id: REPORT_ROW_ID,
      status: "OPEN",
      reviewedBy: null,
      reviewedAt: null,
      resolution: null,
      createdAt: new Date("2026-02-02T11:00:00.000Z"),
      updatedAt: new Date("2026-02-02T11:00:00.000Z"),
      ...data,
    })
  );
});

describe("createReport — admin.report.ingest carries communityId", () => {
  it("includes the community's communityId for a member-level (targetUserId) report", async () => {
    await communityService.createReport(CID, SELF, {
      targetUserId: TARGET,
      reason: "SPAM",
    });

    expect(ingestSafe).toHaveBeenCalledTimes(1);
    expect(ingestSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user",
        communityId: CID,
        sourceReportId: REPORT_ROW_ID,
      })
    );
  });

  it("includes the community's communityId for a community-level (no target) report", async () => {
    await communityService.createReport(CID, SELF, {
      reason: "inappropriate content",
    });

    expect(ingestSafe).toHaveBeenCalledTimes(1);
    expect(ingestSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "community",
        communityId: CID,
        sourceReportId: REPORT_ROW_ID,
      })
    );
  });

  it("includes the community's communityId for a reported-message report", async () => {
    chat.mockReturnValue({
      getCommunityMessageById: jest.fn(async () => ({ found: false })),
    });

    await communityService.createReport(CID, SELF, {
      targetUserId: TARGET,
      reason: "SPAM",
      reportedMessageId: REPORT_ROW_ID,
    });

    expect(ingestSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: CID,
      })
    );
  });

  it("the community-level realtime event also carries the same communityId", async () => {
    await communityService.createReport(CID, SELF, {
      targetUserId: TARGET,
      reason: "SPAM",
    });

    expect(communityEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ communityId: CID })
    );
  });
});
