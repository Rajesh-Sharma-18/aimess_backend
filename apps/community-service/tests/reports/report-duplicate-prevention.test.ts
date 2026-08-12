/**
 * Service-layer test: a user may report another user only ONCE per
 * community, regardless of report status (OPEN/REVIEWED/ACTIONED/DISMISSED/
 * WITHDRAWN all count) — as opposed to the no-target (community-level)
 * report path, which keeps its pre-existing OPEN-only idempotent behavior.
 *
 * Only the I/O boundary (repository) is mocked.
 */
jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findMemberByUserId: jest.fn(),
    findOpenReportByReporterAndTarget: jest.fn(),
    findReportByReporterAndTarget: jest.fn(),
    findReportByReporterAndMessage: jest.fn(),
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

import { ConflictError } from "@aimess/errors";
import { Prisma } from "../../src/generated/prisma/index.js";

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;

const CID = "a".repeat(24);
const SELF = "edcfb732-4617-4b19-aa7a-575ca43c24cc";
const TARGET = "15c8a2c9-e759-413d-878c-842dc3066d94";
const MSG = "6a3a737f236c483508914d0c";

const EXISTING_DISMISSED_REPORT = {
  id: MSG,
  communityId: CID,
  reporterId: SELF,
  targetUserId: TARGET,
  reason: "SPAM",
  status: "DISMISSED",
  reviewedBy: null,
  reviewedAt: null,
  resolution: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

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
  repo.findReportByReporterAndMessage.mockResolvedValue(null);
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

describe("createReport — duplicate member-report prevention", () => {
  it("rejects a second report against the same target when a prior DISMISSED report exists", async () => {
    repo.findReportByReporterAndTarget.mockResolvedValue(
      EXISTING_DISMISSED_REPORT
    );

    await expect(
      communityService.createReport(CID, SELF, {
        targetUserId: TARGET,
        reason: "HARASSMENT",
      })
    ).rejects.toBeInstanceOf(ConflictError);

    expect(repo.createReport).not.toHaveBeenCalled();
    expect(repo.findReportByReporterAndTarget).toHaveBeenCalledWith({
      communityId: CID,
      reporterId: SELF,
      targetUserId: TARGET,
    });
  });

  it("rejects with COMMUNITY_REPORT_ALREADY_EXISTS regardless of the existing report's status (RESOLVED)", async () => {
    repo.findReportByReporterAndTarget.mockResolvedValue({
      ...EXISTING_DISMISSED_REPORT,
      status: "ACTIONED",
    });

    await expect(
      communityService.createReport(CID, SELF, {
        targetUserId: TARGET,
        reason: "SPAM",
      })
    ).rejects.toMatchObject({ message: "COMMUNITY_REPORT_ALREADY_EXISTS" });
  });

  it("allows the first report against a target when none exists yet", async () => {
    const dto = await communityService.createReport(CID, SELF, {
      targetUserId: TARGET,
      reason: "SPAM",
    });

    expect(dto.status).toBe("OPEN");
    expect(repo.createReport).toHaveBeenCalledTimes(1);
  });

  it("maps a race-condition P2002 on insert to the same business error", async () => {
    repo.findReportByReporterAndTarget.mockResolvedValue(null); // passes pre-check
    repo.createReport.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate key", {
        code: "P2002",
        clientVersion: "test",
      })
    );

    await expect(
      communityService.createReport(CID, SELF, {
        targetUserId: TARGET,
        reason: "SPAM",
      })
    ).rejects.toMatchObject({ message: "COMMUNITY_REPORT_ALREADY_EXISTS" });
  });

  it("does NOT apply the any-status dedup to community-level (no target) reports", async () => {
    // Community-level path uses the OPEN-only helper, not the any-status one.
    await communityService.createReport(CID, SELF, {
      reason: "inappropriate content",
    });

    expect(repo.findReportByReporterAndTarget).not.toHaveBeenCalled();
    expect(repo.findOpenReportByReporterAndTarget).toHaveBeenCalledWith({
      communityId: CID,
      reporterId: SELF,
      targetUserId: null,
    });
    expect(repo.createReport).toHaveBeenCalledTimes(1);
  });

  it("still idempotently returns an existing OPEN community-level report (unchanged behavior)", async () => {
    const openCommunityReport = {
      ...EXISTING_DISMISSED_REPORT,
      targetUserId: null,
      status: "OPEN",
    };
    repo.findOpenReportByReporterAndTarget.mockResolvedValue(
      openCommunityReport
    );

    const dto = await communityService.createReport(CID, SELF, {
      reason: "inappropriate content",
    });

    expect(dto.status).toBe("OPEN");
    expect(repo.createReport).not.toHaveBeenCalled();
  });
});
