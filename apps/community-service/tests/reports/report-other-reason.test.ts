/**
 * Service-layer test for `communityService.createReport()` handling of the
 * "OTHER" reason: a mandatory custom description, persisted separately from
 * `reason`, and forwarded as `details` on the admin.report.ingest event.
 *
 * Only the I/O boundary is mocked (repository, messaging publishers).
 */

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findMemberByUserId: jest.fn(),
    findOpenReportByReporterAndTarget: jest.fn(),
    createReport: jest.fn(),
    findActiveMemberIdsByRoles: jest.fn(),
    createAuditLog: jest.fn(),
  },
}));

jest.mock("../../src/messaging/publish-community.js", () => ({
  publishCommunityReportCreatedSafe: jest.fn(),
  publishCommunityReportActionedSafe: jest.fn(),
}));

jest.mock("../../src/messaging/publish-admin-report.js", () => ({
  publishAdminReportIngestSafe: jest.fn(),
}));

import { BadRequestError } from "@aimess/errors";

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { publishAdminReportIngestSafe } from "../../src/messaging/publish-admin-report.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const publishAdminReportIngest = publishAdminReportIngestSafe as jest.Mock;

const CID = "a".repeat(24);
const SELF = "edcfb732-4617-4b19-aa7a-575ca43c24cc";
const TARGET = "15c8a2c9-e759-413d-878c-842dc3066d94";
const MSG = "6a3a737f236c483508914d0c";

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue({ id: CID, name: "C", status: "ACTIVE" });
  repo.findMembership.mockResolvedValue({ role: "MEMBER", status: "ACTIVE" });
  repo.findMemberByUserId.mockResolvedValue({
    userId: TARGET,
    status: "ACTIVE",
  });
  repo.findOpenReportByReporterAndTarget.mockResolvedValue(null);
  repo.findActiveMemberIdsByRoles.mockResolvedValue([]);
  repo.createAuditLog.mockResolvedValue(undefined);
  repo.createReport.mockImplementation(
    async (data: Record<string, unknown>) => ({
      id: MSG,
      status: "OPEN",
      reviewedBy: null,
      reviewedAt: null,
      resolution: null,
      reportedMessageId: null,
      reportedContentType: null,
      reportedContentText: null,
      reportedContentMedia: null,
      reportedContentPostedAt: null,
      createdAt: new Date("2026-02-02T11:00:00.000Z"),
      updatedAt: new Date("2026-02-02T11:00:00.000Z"),
      ...data,
    })
  );
});

describe("createReport — OTHER reason", () => {
  it("rejects OTHER with no otherReason (defense-in-depth, mirrors validator)", async () => {
    await expect(
      communityService.createReport(CID, SELF, {
        targetUserId: TARGET,
        reason: "OTHER",
      })
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(repo.createReport).not.toHaveBeenCalled();
  });

  it("rejects OTHER with a whitespace-only otherReason", async () => {
    await expect(
      communityService.createReport(CID, SELF, {
        targetUserId: TARGET,
        reason: "OTHER",
        otherReason: "   ",
      })
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(repo.createReport).not.toHaveBeenCalled();
  });

  it("persists otherReason separately from reason and forwards it as ingest `details`", async () => {
    const dto = await communityService.createReport(CID, SELF, {
      targetUserId: TARGET,
      reason: "OTHER",
      otherReason: "  They keep sending off-platform payment links  ",
    });

    expect(repo.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "OTHER",
        otherReason: "They keep sending off-platform payment links",
      })
    );
    expect(dto.reason).toBe("OTHER");
    expect(dto.otherReason).toBe(
      "They keep sending off-platform payment links"
    );

    expect(publishAdminReportIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "OTHER",
        details: "They keep sending off-platform payment links",
      })
    );
  });

  it("ignores/clears otherReason for a predefined reason", async () => {
    const dto = await communityService.createReport(CID, SELF, {
      targetUserId: TARGET,
      reason: "SPAM",
      otherReason: "should be dropped",
    });

    expect(repo.createReport).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "SPAM", otherReason: null })
    );
    expect(dto.otherReason).toBeNull();

    expect(publishAdminReportIngest).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "SPAM", details: null })
    );
  });
});
