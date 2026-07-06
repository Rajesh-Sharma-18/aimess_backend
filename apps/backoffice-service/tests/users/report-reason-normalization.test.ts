/**
 * Fix for duplicate `topReasons` entries on GET /admin/v1/users/:userId/details.
 *
 * Root cause: `reportDetailRepository.categoryCounts()` grouped by the raw
 * `reason` column (`prisma.report.groupBy(["reason"])`), and different
 * source services store the SAME logical reason in different formats —
 * chat-service/stream-service publish UPPER_SNAKE enum values ("SPAM",
 * "INAPPROPRIATE_CONTENT"), community-service accepts free-text ("Spam
 * Messages", "inappropriate content"). Each distinct string became its own
 * row instead of being merged.
 *
 * These tests exercise `normalizeReportReason` directly (the canonicalizer)
 * and `reportDetailRepository.categoryCounts` end-to-end against a mocked
 * `prisma.report.groupBy` — asserting ONE query still runs and the merge
 * happens in-memory afterward.
 */
import { normalizeReportReason } from "../../src/lib/report-reason.js";

describe("normalizeReportReason", () => {
  it("merges the enum form and display-text variants of INAPPROPRIATE_CONTENT", () => {
    expect(normalizeReportReason("INAPPROPRIATE_CONTENT")).toEqual({
      key: "INAPPROPRIATE_CONTENT",
      label: "Inappropriate Content",
    });
    expect(normalizeReportReason("Inappropriate Content")).toEqual({
      key: "INAPPROPRIATE_CONTENT",
      label: "Inappropriate Content",
    });
    expect(normalizeReportReason("inappropriate content")).toEqual({
      key: "INAPPROPRIATE_CONTENT",
      label: "Inappropriate Content",
    });
    expect(normalizeReportReason("  inappropriate   content  ")).toEqual({
      key: "INAPPROPRIATE_CONTENT",
      label: "Inappropriate Content",
    });
  });

  it("merges the bare SPAM enum with the community-service display text", () => {
    expect(normalizeReportReason("SPAM")).toEqual({
      key: "SPAM_MESSAGES",
      label: "Spam Messages",
    });
    expect(normalizeReportReason("Spam Messages")).toEqual({
      key: "SPAM_MESSAGES",
      label: "Spam Messages",
    });
    expect(normalizeReportReason("spam messages")).toEqual({
      key: "SPAM_MESSAGES",
      label: "Spam Messages",
    });
  });

  it("canonicalizes OTHER regardless of case", () => {
    expect(normalizeReportReason("OTHER")).toEqual({
      key: "OTHER",
      label: "OTHER",
    });
    expect(normalizeReportReason("other")).toEqual({
      key: "OTHER",
      label: "OTHER",
    });
    expect(normalizeReportReason(" Other ")).toEqual({
      key: "OTHER",
      label: "OTHER",
    });
  });

  it("falls back to a Title-Cased self-key for an unrecognized reason", () => {
    expect(normalizeReportReason("banned word usage")).toEqual({
      key: "BANNED_WORD_USAGE",
      label: "Banned Word Usage",
    });
    // A differently-cased occurrence of the SAME unrecognized reason still merges.
    expect(normalizeReportReason("Banned Word Usage")).toEqual({
      key: "BANNED_WORD_USAGE",
      label: "Banned Word Usage",
    });
  });
});

const mockReportGroupBy = jest.fn();
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    report: { groupBy: (...args: unknown[]) => mockReportGroupBy(...args) },
  },
}));
jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: { adminGetCommunitiesByIds: jest.fn(async () => new Map()) },
}));
jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: { adminGetProfilesByIds: jest.fn(async () => []) },
}));

import { reportDetailRepository } from "../../src/repositories/report-detail.repository.js";

describe("reportDetailRepository.categoryCounts — dedup merge", () => {
  beforeEach(() => {
    mockReportGroupBy.mockReset();
  });

  it("sums duplicate-format rows into ONE canonical entry via a SINGLE query", async () => {
    mockReportGroupBy.mockResolvedValueOnce([
      { reason: "Inappropriate Content", _count: { _all: 1 } },
      { reason: "INAPPROPRIATE_CONTENT", _count: { _all: 1 } },
      { reason: "inappropriate content", _count: { _all: 2 } },
    ]);

    const result = await reportDetailRepository.categoryCounts("user-1");

    expect(mockReportGroupBy).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ reason: "Inappropriate Content", count: 4 }]);
  });

  it("merges SPAM and 'Spam Messages' and sorts by the MERGED count (not per-raw-value)", async () => {
    mockReportGroupBy.mockResolvedValueOnce([
      // Pre-merge, "Spam Messages" alone (1) looks smaller than "Offensive
      // Language" (2) — only after SPAM+Spam Messages merge to 4 does Spam
      // Messages correctly rank first.
      { reason: "Offensive Language", _count: { _all: 2 } },
      { reason: "SPAM", _count: { _all: 3 } },
      { reason: "Spam Messages", _count: { _all: 1 } },
    ]);

    const result = await reportDetailRepository.categoryCounts("user-1");

    expect(result).toEqual([
      { reason: "Spam Messages", count: 4 },
      { reason: "Offensive Language", count: 2 },
    ]);
  });

  it("keeps OTHER as its own bucket (never merged into a predefined reason)", async () => {
    mockReportGroupBy.mockResolvedValueOnce([
      { reason: "SPAM", _count: { _all: 2 } },
      { reason: "OTHER", _count: { _all: 5 } },
      { reason: "other", _count: { _all: 1 } },
    ]);

    const result = await reportDetailRepository.categoryCounts("user-1");

    expect(result).toEqual([
      { reason: "OTHER", count: 6 },
      { reason: "Spam Messages", count: 2 },
    ]);
  });
});
