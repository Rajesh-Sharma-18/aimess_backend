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
}
