import { logger } from "@aimess/logger";
import { ForbiddenError, NotFoundError } from "@aimess/errors";
import type { communityGrpcClient as CommunityGrpcClient } from "../grpc/community.client.js";

import type { LivestreamComment } from "../generated/prisma/index.js";
import type { LivestreamCommentRepository } from "../repositories/livestream-comment.repository.js";
import type { LivestreamCommentReportRepository } from "../repositories/livestream-comment-report.repository.js";
import type { LivestreamRepository } from "../repositories/livestream.repository.js";
import type { LivestreamBanRepository } from "../repositories/livestream-ban.repository.js";
import type { redis as RedisClient } from "../config/redis.js";
import type { userGrpcClient as UserGrpcClient } from "../grpc/user.client.js";

export const COMMENT_REPORT_REASONS = [
  "OFFENSIVE_LANGUAGE",
  "SPAM",
  "INAPPROPRIATE_CONTENT",
  "SCAM_OR_FRAUD",
  "IMPERSONATION",
  "OTHER",
] as const;
export type CommentReportReason = (typeof COMMENT_REPORT_REASONS)[number];

export interface CommentReportDto {
  id: string;
  commentId: string;
  livestreamId: string;
  reportedBy: string;
  reason: string;
  details: string | null;
  createdAt: Date;
}

export interface CommentReportView {
  id: string;
  commentId: string;
  livestreamId: string;
  reportedBy: string;
  reason: string;
  details: string | null;
  createdAt: Date;
  comment: {
    id: string;
    sentBy: string;
    senderName: string;
    message: string;
    createdAt: Date;
  } | null; // null when the reported comment has been deleted
}

export interface ListReportsResult {
  items: CommentReportView[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Public comment shape (REST + gRPC + Redis broadcast share this). */
export interface CommentDto {
  id: string;
  sentBy: string;
  senderName: string;
  senderAvatar: string;
  message: string;
  createdAt: Date;
}

export interface GetCommentsResult {
  items: CommentDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

function toDto(c: LivestreamComment): CommentDto {
  return {
    id: c.id,
    sentBy: c.sentBy,
    senderName: c.senderName ?? "",
    senderAvatar: c.senderAvatar ?? "",
    message: c.message,
    createdAt: c.createdAt,
  };
}

export class LivestreamCommentService {
  constructor(
    private readonly commentRepo: LivestreamCommentRepository,
    private readonly streamRepo: LivestreamRepository,
    private readonly userClient: typeof UserGrpcClient,
    private readonly redis: typeof RedisClient,
    private readonly banRepo: LivestreamBanRepository,
    private readonly communityClient: typeof CommunityGrpcClient,
    private readonly reportRepo: LivestreamCommentReportRepository
  ) {}

  /** True if requester is the stream owner or a community ADMIN/MODERATOR (fail-closed). */
  private async hasModeratorAccess(
    stream: { creatorId: string; communityId: string },
    requesterId: string
  ): Promise<boolean> {
    if (stream.creatorId === requesterId) return true;
    try {
      const membership = await this.communityClient.validateMembership(
        stream.communityId,
        requesterId
      );
      return (
        membership.isMember &&
        (membership.role === "ADMIN" || membership.role === "MODERATOR")
      );
    } catch {
      return false; // circuit-open / error = deny
    }
  }

  /**
   * Persist a comment with author enrichment + idempotency, then broadcast it on
   * the livestream's Redis channel for the realtime gateway. Returns the DTO.
   */
  async addComment(params: {
    livestreamId: string;
    userId: string;
    message: string;
    clientCommentId?: string | null;
  }): Promise<CommentDto> {
    // Idempotency: replay of the same client comment returns the original row.
    if (params.clientCommentId) {
      const existing = await this.commentRepo.findByClientCommentId(
        params.livestreamId,
        params.userId,
        params.clientCommentId
      );
      if (existing) return toDto(existing);
    }

    // Enforce ban + commentStatus (defend at write path, not just join gate).
    const stream = await this.streamRepo.findById(params.livestreamId);
    if (
      stream &&
      (await this.banRepo.isBanned(params.livestreamId, params.userId))
    ) {
      throw new ForbiddenError("COMMENTS_BANNED");
    }
    if (stream && !stream.commentStatus) {
      throw new ForbiddenError("COMMENTS_DISABLED");
    }

    // Enrich author snapshot (best-effort; degrades to empty on user-service down).
    let senderName = "";
    let senderAvatar = "";
    try {
      const snaps = await this.userClient.bulkGetUserSnapshots([params.userId]);
      const snap = snaps.find((s) => s.userId === params.userId);
      if (snap) {
        // Live chat shows the username, not the full display name.
        senderName = snap.username || snap.displayName || "";
        senderAvatar = snap.avatarObjectKey || "";
      }
    } catch (error) {
      logger.warn(
        `comment author enrichment failed for user=${params.userId}: ${String(error)}`
      );
    }

    const saved = await this.commentRepo.createComment({
      livestreamId: params.livestreamId,
      sentBy: params.userId,
      senderName,
      senderAvatar,
      message: params.message,
      clientCommentId: params.clientCommentId ?? null,
    });

    // Best-effort counter — never block the comment response on a counter update.
    this.streamRepo
      .incrementTotalComments(params.livestreamId)
      .catch((err: unknown) =>
        logger.warn(
          `incrementTotalComments failed stream=${params.livestreamId}: ${String(err)}`
        )
      );

    const dto = toDto(saved);

    // Broadcast to the livestream channel (gateway fans out to viewers).
    try {
      await this.redis.publish(
        `stream:${params.livestreamId}`,
        JSON.stringify({
          event: "stream:comment:new",
          // Canonical comment shape — identical field names to the gRPC/REST
          // `CommentDto` so a client renders a live comment and a backfilled
          // `recentComments[]` item through one code path. `streamId` is an
          // extra routing hint on the live event (harmless if ignored).
          data: {
            id: dto.id,
            streamId: params.livestreamId,
            sentBy: dto.sentBy,
            senderName: dto.senderName,
            senderAvatar: dto.senderAvatar,
            message: dto.message,
            createdAt: dto.createdAt.getTime(),
          },
        })
      );
    } catch (error) {
      logger.warn(
        `comment broadcast failed for stream=${params.livestreamId}: ${String(error)}`
      );
    }

    return dto;
  }

  async deleteComment(
    commentId: string,
    requesterId: string
  ): Promise<{ commentId: string; livestreamId: string }> {
    const comment = await this.commentRepo.findById(commentId);
    if (!comment) throw new NotFoundError("COMMENT_NOT_FOUND");

    const stream = await this.streamRepo.findById(comment.livestreamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");

    // Authorization: author OR stream owner OR community admin/mod
    const isAuthor = comment.sentBy === requesterId;
    if (!isAuthor && !(await this.hasModeratorAccess(stream, requesterId))) {
      throw new ForbiddenError("COMMENT_DELETE_FORBIDDEN");
    }

    await this.commentRepo.deleteById(commentId);

    // Broadcast deletion (best-effort)
    try {
      await this.redis.publish(
        `stream:${comment.livestreamId}`,
        JSON.stringify({
          event: "stream:comment:deleted",
          data: {
            commentId: comment.id,
            streamId: comment.livestreamId,
            deletedBy: requesterId,
          },
        })
      );
    } catch (err) {
      logger.warn(
        `comment delete broadcast failed stream=${comment.livestreamId}: ${String(err)}`
      );
    }

    return { commentId: comment.id, livestreamId: comment.livestreamId };
  }

  /**
   * Submit a report on a live chat comment. Idempotent — a second report from
   * the same user on the same comment returns the original row unchanged.
   * The comment must belong to the given `livestreamId` (path param guard).
   */
  async reportComment(params: {
    commentId: string;
    livestreamId: string;
    reportedBy: string;
    reason: CommentReportReason;
    details?: string;
  }): Promise<CommentReportDto> {
    const comment = await this.commentRepo.findById(params.commentId);
    if (!comment) throw new NotFoundError("COMMENT_NOT_FOUND");
    if (comment.livestreamId !== params.livestreamId) {
      throw new NotFoundError("COMMENT_NOT_FOUND");
    }

    const report = await this.reportRepo.upsert({
      commentId: params.commentId,
      livestreamId: params.livestreamId,
      reportedBy: params.reportedBy,
      reason: params.reason,
      details: params.details ?? null,
    });

    return {
      id: report.id,
      commentId: report.commentId,
      livestreamId: report.livestreamId,
      reportedBy: report.reportedBy,
      reason: report.reason,
      details: report.details ?? null,
      createdAt: report.createdAt,
    };
  }

  /**
   * List reports for a stream (newest-first, cursor-paged), each enriched with the
   * reported comment's current content. Owner or community ADMIN/MODERATOR only.
   */
  async listReports(params: {
    livestreamId: string;
    requesterId: string;
    limit: number;
    before?: string;
  }): Promise<ListReportsResult> {
    const stream = await this.streamRepo.findById(params.livestreamId);
    if (!stream) throw new NotFoundError("STREAM_NOT_FOUND");
    if (!(await this.hasModeratorAccess(stream, params.requesterId))) {
      throw new ForbiddenError("REPORTS_VIEW_FORBIDDEN");
    }

    const rows = await this.reportRepo.findByLivestream(params.livestreamId, {
      limit: params.limit + 1,
      before: params.before,
    });
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;

    const commentIds = [...new Set(page.map((r) => r.commentId))];
    const comments = await this.commentRepo.findByIds(commentIds);
    const byId = new Map(comments.map((c) => [c.id, c]));

    const items: CommentReportView[] = page.map((r) => {
      const c = byId.get(r.commentId);
      return {
        id: r.id,
        commentId: r.commentId,
        livestreamId: r.livestreamId,
        reportedBy: r.reportedBy,
        reason: r.reason,
        details: r.details ?? null,
        createdAt: r.createdAt,
        comment: c
          ? {
              id: c.id,
              sentBy: c.sentBy,
              senderName: c.senderName ?? "",
              message: c.message,
              createdAt: c.createdAt,
            }
          : null,
      };
    });

    const nextCursor =
      hasMore && page.length > 0 ? page[page.length - 1]!.id : null;
    return { items, nextCursor, hasMore };
  }

  /**
   * Cursor-paged comment fetch.
   * - `before`: newest-first (history scroll). nextCursor = oldest item's id.
   * - `after`:  oldest-first (reconnect catch-up). nextCursor = newest item's id.
   * Pass nextCursor back as the same cursor direction for the next page.
   */
  async getComments(
    livestreamId: string,
    options: { limit: number; before?: string; after?: string }
  ): Promise<GetCommentsResult> {
    const rows = await this.commentRepo.findByLivestreamId(livestreamId, {
      limit: options.limit + 1,
      before: options.before,
      after: options.after,
    });
    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const items = page.map(toDto);
    const nextCursor =
      hasMore && items.length > 0 ? items[items.length - 1]!.id : null;
    return { items, nextCursor, hasMore };
  }
}
