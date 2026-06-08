import { prisma } from "../config/prisma.js";
import { userClient } from "../grpc/user.client.js";
import type {
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
  /** All report categories (reason) filed against a user, highest count first. */
  async categoryCounts(userId: string): Promise<ReportCategoryCount[]> {
    const grouped = await prisma.report.groupBy({
      by: ["reason"],
      where: { type: "user", targetId: userId },
      _count: { _all: true },
      orderBy: { _count: { reason: "desc" } },
    });
    return grouped.map((g) => ({ reason: g.reason, count: g._count._all }));
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
        },
      }),
    ]);

    // Batch-resolve reporter display profiles (user-service). Empty input → no
    // gRPC call (handled in the client).
    const ids = [...new Set(rows.map((r) => r.reporterId))];
    const profiles = await userClient.adminGetProfilesByIds(ids);
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));

    const data: ReportRow[] = rows.map((r) => {
      const profile = profileMap.get(r.reporterId);
      return {
        reportId: r.id,
        reason: r.reason,
        details: r.details,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        reporter: {
          userId: r.reporterId,
          username: profile?.username ?? null,
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
