import { logger } from "@aimess/logger";
import { ForbiddenError, NotFoundError } from "@aimess/errors";
import type { communityGrpcClient as CommunityGrpcClient } from "../grpc/community.client.js";

import type { LivestreamComment } from "../generated/prisma/index.js";
import type { LivestreamCommentRepository } from "../repositories/livestream-comment.repository.js";
import type { LivestreamRepository } from "../repositories/livestream.repository.js";
import type { LivestreamBanRepository } from "../repositories/livestream-ban.repository.js";
import type { redis as RedisClient } from "../config/redis.js";
import type { userGrpcClient as UserGrpcClient } from "../grpc/user.client.js";

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
    private readonly communityClient: typeof CommunityGrpcClient
  ) {}

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
        senderName = snap.displayName || snap.username || "";
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
    const isHost = stream.creatorId === requesterId;

    if (!isAuthor && !isHost) {
      // Fail-closed: circuit-open or gRPC error = deny
      let allowed = false;
      try {
        const membership = await this.communityClient.validateMembership(
          stream.communityId,
          requesterId
        );
        allowed =
          membership.isMember &&
          (membership.role === "ADMIN" || membership.role === "MODERATOR");
      } catch {
        // deliberately let circuit-open propagate as deny
      }
      if (!allowed) throw new ForbiddenError("COMMENT_DELETE_FORBIDDEN");
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
