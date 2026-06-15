import { logger } from "@aimess/logger";

import type { LivestreamComment } from "../generated/prisma/index.js";
import type { LivestreamCommentRepository } from "../repositories/livestream-comment.repository.js";
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
    private readonly userClient: typeof UserGrpcClient,
    private readonly redis: typeof RedisClient
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

  /** Newest-first page. `nextCursor` is the last item's id (pass back as `before`). */
  async getComments(
    livestreamId: string,
    options: { limit: number; before?: string }
  ): Promise<GetCommentsResult> {
    const rows = await this.commentRepo.findByLivestreamId(livestreamId, {
      limit: options.limit + 1,
      before: options.before,
    });
    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const items = page.map(toDto);
    const nextCursor =
      hasMore && items.length > 0 ? items[items.length - 1]!.id : null;
    return { items, nextCursor, hasMore };
  }
}
