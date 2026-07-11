import type {
  PrismaClient,
  LivestreamCommentReport,
} from "../generated/prisma/index.js";

export class LivestreamCommentReportRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Upsert a comment report. If the same user already reported this comment
   * the existing row is returned unchanged (idempotent).
   */
  async upsert(data: {
    commentId: string;
    livestreamId: string;
    reportedBy: string;
    reason: string;
    details?: string | null;
  }): Promise<LivestreamCommentReport> {
    return this.prisma.livestreamCommentReport.upsert({
      where: {
        commentId_reportedBy: {
          commentId: data.commentId,
          reportedBy: data.reportedBy,
        },
      },
      create: {
        commentId: data.commentId,
        livestreamId: data.livestreamId,
        reportedBy: data.reportedBy,
        reason: data.reason,
        details: data.details ?? null,
      },
      update: {},
    });
  }

  /** Newest-first cursor page of reports for a stream. */
  async findByLivestream(
    livestreamId: string,
    options: { limit: number; before?: string }
  ): Promise<LivestreamCommentReport[]> {
    return this.prisma.livestreamCommentReport.findMany({
      where: {
        livestreamId,
        ...(options.before ? { id: { lt: options.before } } : {}),
      },
      orderBy: { id: "desc" },
      take: options.limit,
    });
  }

  /**
   * Report count grouped by livestreamId — one aggregation, not per-livestream
   * fetches. When `livestreamIds` is non-empty the aggregation is scoped to
   * that set (missing keys ⇒ 0); when empty, every livestream that has at
   * least one report is returned (used by the has-reports/min-reports filter).
   */
  async groupCountsByLivestream(
    livestreamIds?: string[]
  ): Promise<{ livestreamId: string; count: number }[]> {
    if (livestreamIds && livestreamIds.length === 0) return [];
    const rows = await this.prisma.livestreamCommentReport.groupBy({
      by: ["livestreamId"],
      where:
        livestreamIds && livestreamIds.length > 0
          ? { livestreamId: { in: livestreamIds } }
          : undefined,
      _count: { _all: true },
    });
    return rows.map((r) => ({
      livestreamId: r.livestreamId,
      count: r._count._all,
    }));
  }
}
