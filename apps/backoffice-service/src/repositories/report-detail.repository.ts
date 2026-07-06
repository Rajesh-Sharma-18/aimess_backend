import { prisma } from "../config/prisma.js";
import { communityClient } from "../grpc/community.client.js";
import { userClient } from "../grpc/user.client.js";
import { buildFullName } from "../lib/grpc-view.js";
import { normalizeReportReason } from "../lib/report-reason.js";
import type {
  OtherReasonNote,
  Paginated,
  PaginationMeta,
  ReportCategoryCount,
  ReportRow,
} from "../types/user-management.types.js";

/**
 * Repository backing the admin "Reported Details" panel on the User Management
 * detail screen (admin_db `Report` rows where `type='user'`, `targetId=userId`).
 *
 * Reporter identity/display is enriched from user-service via the existing
 * `userClient.adminGetProfilesByIds` gRPC fan-out (batched, one round-trip per
 * page). The avatar value returned here is the RAW MinIO key — presigning is
 * the service layer's responsibility (mirrors `listUsers`).
 */
export const reportDetailRepository = {
  /**
   * All report categories (reason) filed against a user, highest count
   * first. Reasons are stored verbatim by whichever service filed the report
   * (chat/stream publish UPPER_SNAKE enum values, community-service accepts
   * free-text) — a plain `groupBy(["reason"])` would therefore group
   * "SPAM"/"Spam Messages"/"spam messages" as three separate categories.
   * ONE query still runs; {@link normalizeReportReason} merges the grouped
   * rows onto a canonical key/label and sums their counts in-memory, so the
   * "highest count first" ordering is computed AFTER merging (a per-raw-value
   * DB `orderBy` would otherwise reorder by the wrong, pre-merge counts).
   */
  async categoryCounts(userId: string): Promise<ReportCategoryCount[]> {
    const grouped = await prisma.report.groupBy({
      by: ["reason"],
      where: { type: "user", targetId: userId },
      _count: { _all: true },
    });

    const merged = new Map<string, ReportCategoryCount>();
    for (const g of grouped) {
      const { key, label } = normalizeReportReason(g.reason);
      const existing = merged.get(key);
      if (existing) {
        existing.count += g._count._all;
      } else {
        merged.set(key, { reason: label, count: g._count._all });
      }
    }

    return [...merged.values()].sort((a, b) => b.count - a.count);
  },

  /**
   * Free-text notes filed under the custom "OTHER" reason against a user,
   * newest first, each with its reporter (best-effort username) and
   * timestamp. Distinct from {@link categoryCounts}, which only carries
   * counts — this is the per-report `details` text `categoryCounts` never
   * surfaces. Reports with an empty/whitespace-only `details` are dropped.
   */
  async otherReasonNotes(userId: string): Promise<OtherReasonNote[]> {
    const rows = await prisma.report.findMany({
      where: { type: "user", targetId: userId, reason: "OTHER" },
      select: { details: true, reporterId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });

    const withDescription = rows
      .map((r) => ({ ...r, details: r.details?.trim() }))
      .filter((r): r is typeof r & { details: string } => !!r.details);

    if (withDescription.length === 0) return [];

    // Batch-resolve reporter display profiles (user-service). Skipped
    // entirely when there is nothing to resolve.
    const ids = [...new Set(withDescription.map((r) => r.reporterId))];
    const profiles = await userClient.adminGetProfilesByIds(ids);
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));

    return withDescription.map((r) => ({
      description: r.details,
      reportedBy: profileMap.get(r.reporterId)?.username ?? null,
      reportedAt: r.createdAt.toISOString(),
    }));
  },

  /** Offset-paginated reports filed against a user, newest first. */
  async listForUser(
    userId: string,
    page: number,
    limit: number
  ): Promise<Paginated<ReportRow>> {
    const skip = (page - 1) * limit;

    const [total, rows] = await Promise.all([
      prisma.report.count({ where: { type: "user", targetId: userId } }),
      prisma.report.findMany({
        where: { type: "user", targetId: userId },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          reason: true,
          details: true,
          status: true,
          createdAt: true,
          reporterId: true,
          communityId: true,
        },
      }),
    ]);

    // Independent enrichment lookups — batched (one round-trip each per page)
    // and run in parallel, not sequentially.
    const reporterIds = [...new Set(rows.map((r) => r.reporterId))];
    const communityIds = [
      ...new Set(
        rows.map((r) => r.communityId).filter((id): id is string => !!id)
      ),
    ];
    const [profiles, communities] = await Promise.all([
      userClient.adminGetProfilesByIds(reporterIds),
      communityIds.length > 0
        ? communityClient.adminGetCommunitiesByIds(communityIds)
        : Promise.resolve(new Map<string, { name: string }>()),
    ]);
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));

    const data: ReportRow[] = rows.map((r) => {
      const profile = profileMap.get(r.reporterId);
      return {
        reportId: r.id,
        reason: r.reason,
        details: r.details,
        // Custom free-text description — only ever set for the "OTHER"
        // reason; a predefined reason NEVER surfaces `details` here even if
        // the upstream row happens to carry one.
        otherReason: r.reason === "OTHER" ? (r.details ?? null) : null,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        communityId: r.communityId ?? null,
        communityName: r.communityId
          ? (communities.get(r.communityId)?.name ?? null)
          : null,
        reporter: {
          userId: r.reporterId,
          username: profile?.username ?? null,
          fullname: buildFullName(profile?.firstName, profile?.lastName),
          // Raw MinIO key — presigned in the service layer.
          avatarKey: profile?.avatarUrl || null,
        },
      };
    });

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const hasNext = skip + rows.length < total;

    const pagination: PaginationMeta = {
      mode: "offset",
      page,
      limit,
      total,
      totalApprox: total,
      totalPages,
      hasNext,
      hasPrev: page > 1,
      nextCursor: null,
    };

    return { data, pagination };
  },
};
