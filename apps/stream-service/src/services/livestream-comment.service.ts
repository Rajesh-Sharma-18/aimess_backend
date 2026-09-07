import { logger } from "@aimess/logger";
import { ForbiddenError, NotFoundError } from "@aimess/errors";
import { env } from "../config/env.js";
import { publishAdminReportIngestSafe } from "../events/publish-admin-report.js";
import type { communityGrpcClient as CommunityGrpcClient } from "../grpc/community.client.js";

import type { LivestreamComment } from "../generated/prisma/index.js";
import type { LivestreamCommentRepository } from "../repositories/livestream-comment.repository.js";
import type { LivestreamCommentReportRepository } from "../repositories/livestream-comment-report.repository.js";
import type { LivestreamRepository } from "../repositories/livestream.repository.js";
import type { LivestreamBanRepository } from "../repositories/livestream-ban.repository.js";
import type { redis as RedisClient } from "../config/redis.js";
import type { userGrpcClient as UserGrpcClient } from "../grpc/user.client.js";
import {
  resolveAvatarUrl,
  resolveAvatarUrlMap,
  avatarUrlFromMap,
} from "../lib/avatar-resolve.js";
import { isSystemBanned } from "../lib/system-ban.js";

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
  /** Reporter's display-name/avatar snapshot (best-effort; "" fields on user-service outage). */
  reporterUsername: string;
  reporterDisplayName: string;
  reporterAvatar: string;
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

/**
 * Persisted rows keep the raw MinIO object key; every read boundary (REST,
 * gRPC, Redis broadcast) resolves it to a full download URL here so no
 * caller ever has to know about the object-key/URL distinction.
 */
async function toDto(c: LivestreamComment): Promise<CommentDto> {
  return {
    id: c.id,
    sentBy: c.sentBy,
    senderName: c.senderName ?? "",
    senderAvatar: await resolveAvatarUrl(c.senderAvatar),
    message: c.message,
    createdAt: c.createdAt,
  };
}

/** Batch variant of {@link toDto} — resolves each distinct avatar key once. */
async function toDtoList(rows: LivestreamComment[]): Promise<CommentDto[]> {
  const urlMap = await resolveAvatarUrlMap(rows.map((r) => r.senderAvatar));
  return rows.map((c) => ({
    id: c.id,
    sentBy: c.sentBy,
    senderName: c.senderName ?? "",
    senderAvatar: avatarUrlFromMap(urlMap, c.senderAvatar),
    message: c.message,
    createdAt: c.createdAt,
  }));
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

  /**
   * True when a moderator has muted this user in the stream's community.
   * Fail-open: a community-service outage must not silence the whole chat.
   */
  private async isMuted(communityId: string, userId: string): Promise<boolean> {
    try {
      const mute = await this.communityClient.checkMute(communityId, userId);
      return mute.isMuted;
    } catch (error) {
      logger.warn(
        `mute check failed for community=${communityId} user=${userId}: ${String(error)}`
      );
      return false;
    }
  }

  /**
   * True when an ADMIN has banned this user from the stream's community.
   * Fail-open: consistent with {@link isMuted} — an outage never silences the
   * whole chat on its own; the local per-stream ban (checked separately, always
   * available) remains the synchronous hard gate.
   */
  private async isCommunityBanned(
    communityId: string,
    userId: string
  ): Promise<boolean> {
    try {
      const ban = await this.communityClient.checkBan(communityId, userId);
      return ban.isBanned;
    } catch (error) {
      logger.warn(
        `community ban check failed for community=${communityId} user=${userId}: ${String(error)}`
      );
      return false;
    }
  }

  /**
   * Membership + community-closed snapshot for the comment write path. Single
   * `validateMembership` call backing both {@link addComment} checks below —
   * mirrors `LivestreamService.checkAccess`'s exact fail-open semantics: a
   * community-service outage must not silence the whole chat, so it degrades
   * to "member, not closed" rather than throwing/denying.
   */
  private async checkMembership(
    communityId: string,
    userId: string
  ): Promise<{ isMember: boolean; isCommunityClosed: boolean }> {
    try {
      const membership = await this.communityClient.validateMembership(
        communityId,
        userId
      );
      return {
        isMember: membership.isMember,
        isCommunityClosed: membership.isCommunityClosed,
      };
    } catch (error) {
      logger.warn(
        `membership check failed for community=${communityId} user=${userId}: ${String(error)}`
      );
      return { isMember: true, isCommunityClosed: false };
    }
  }

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

  /** Resolves a user's rank for comment-delete authorization. Throws on a community-service outage (fail-closed). */
  private async resolveDeleteRank(
    stream: { creatorId: string; communityId: string },
    userId: string
  ): Promise<"OWNER" | "ADMIN" | "MODERATOR" | "MEMBER"> {
    if (stream.creatorId === userId) return "OWNER";
    const membership = await this.communityClient.validateMembership(
      stream.communityId,
      userId
    );
    if (membership.isMember && membership.role === "ADMIN") return "ADMIN";
    if (membership.isMember && membership.role === "MODERATOR")
      return "MODERATOR";
    return "MEMBER";
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
    // User-scoped and stream-independent, so it runs before the idempotency
    // replay too — a banned account gets nothing back, not even its own row.
    // Fail-open, matching the ban/mute checks below.
    if (
      await isSystemBanned(this.redis, params.userId, { denyOnError: false })
    ) {
      throw new ForbiddenError("ACCOUNT_BANNED");
    }

    // Idempotency: replay of the same client comment returns the original row.
    if (params.clientCommentId) {
      const existing = await this.commentRepo.findByClientCommentId(
        params.livestreamId,
        params.userId,
        params.clientCommentId
      );
      if (existing) return await toDto(existing);
    }

    // Enforce ban (local + community-wide) + commentStatus + moderator mute
    // (defend at write path, not just join gate).
    const stream = await this.streamRepo.findById(params.livestreamId);
    if (
      stream &&
      (await this.banRepo.isBanned(params.livestreamId, params.userId))
    ) {
      throw new ForbiddenError("COMMENTS_BANNED");
    }
    if (
      stream &&
      (await this.isCommunityBanned(stream.communityId, params.userId))
    ) {
      throw new ForbiddenError("COMMENTS_BANNED");
    }
    if (stream && !stream.commentStatus) {
      throw new ForbiddenError("COMMENTS_DISABLED");
    }
    if (stream && (await this.isMuted(stream.communityId, params.userId))) {
      throw new ForbiddenError("COMMENTS_MUTED");
    }
    // Membership gate — mirrors LivestreamService.checkAccess's canComment logic
    // exactly: only enforced when STREAM_REQUIRE_MEMBERSHIP is on, and skipped
    // for the stream owner (checkAccess short-circuits the owner before this
    // check too). Without this, a non-member who merely knows the streamId
    // could post a comment without ever joining — the socket layer's join-time
    // cache is a pre-check optimization, not a substitute for this server-side
    // enforcement (a never-joined caller isn't gated by it either).
    if (
      stream &&
      env.STREAM_REQUIRE_MEMBERSHIP &&
      stream.creatorId !== params.userId
    ) {
      const { isMember, isCommunityClosed } = await this.checkMembership(
        stream.communityId,
        params.userId
      );
      if (!isMember) {
        throw new ForbiddenError("STREAM_NOT_A_COMMUNITY_MEMBER");
      }
      if (isCommunityClosed) {
        throw new ForbiddenError("COMMUNITY_IS_CLOSED");
      }
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

    const dto = await toDto(saved);

    // Broadcast to the livestream channel (gateway fans out to viewers).
    try {
      const sentAt = dto.createdAt.getTime();
      await this.redis.publish(
        `stream:${params.livestreamId}`,
        JSON.stringify({
          event: "stream:comment:new",
          // Mirrors the canonical community/private chat message shape (see
          // chat-service's buildChatMessageEvent) so a livestream comment
          // renders through the same message component as chat. `parentCommentId`,
          // `quoteData` and `content.files` are reserved for future reply/media
          // support and are always empty until that ships.
          data: {
            id: dto.id,
            commentId: dto.id,
            streamId: params.livestreamId,
            senderId: dto.sentBy,
            senderName: dto.senderName,
            senderAvatar: dto.senderAvatar,
            parentCommentId: "",
            quoteData: null,
            content: { text: dto.message, files: [] },
            message: dto.message,
            contentType: "TEXT",
            isEdited: false,
            editedAt: 0,
            clientCommentId: saved.clientCommentId ?? "",
            serverTs: sentAt,
            sentAt,
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

    // Authorization:
    // - Any user may delete their own comment.
    // - Stream owner / community ADMIN may delete anyone's comment.
    // - Community MODERATOR may delete their own comment plus any plain
    //   MEMBER's comment, but not an OWNER/ADMIN/MODERATOR's comment.
    const isAuthor = comment.sentBy === requesterId;
    if (!isAuthor) {
      let requesterRank: "OWNER" | "ADMIN" | "MODERATOR" | "MEMBER";
      try {
        requesterRank = await this.resolveDeleteRank(stream, requesterId);
      } catch {
        throw new ForbiddenError("COMMENT_DELETE_FORBIDDEN"); // fail-closed
      }

      if (requesterRank === "MEMBER") {
        throw new ForbiddenError("COMMENT_DELETE_FORBIDDEN");
      }

      if (requesterRank === "MODERATOR") {
        let authorRank: "OWNER" | "ADMIN" | "MODERATOR" | "MEMBER";
        try {
          authorRank = await this.resolveDeleteRank(stream, comment.sentBy);
        } catch {
          throw new ForbiddenError("COMMENT_DELETE_FORBIDDEN"); // fail-closed
        }
        if (authorRank !== "MEMBER") {
          throw new ForbiddenError("COMMENT_DELETE_FORBIDDEN");
        }
      }
      // requesterRank === "OWNER" || "ADMIN" -> allowed unconditionally
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

    // Mirror community-service: fan the report into the backoffice via
    // admin.report.ingest so it surfaces in the Admin Reports list/details.
    // Best-effort — stream-service owns the source of truth (stream_comment_reports),
    // so a publish failure never blocks the reporter.
    const stream = await this.streamRepo.findById(params.livestreamId);
    publishAdminReportIngestSafe({
      type: "stream",
      targetId: params.livestreamId,
      reporterId: params.reportedBy,
      reason: params.reason,
      details: params.details ?? null,
      communityId: stream?.communityId ?? null,
      reportedUserId: comment.sentBy,
      eventAt: new Date().toISOString(),
      sourceReportId: report.id,
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

    // Enrich each reporter's display-name/avatar snapshot (best-effort; degrades
    // to empty strings on user-service outage — never blocks the reports list).
    const reporterIds = [...new Set(page.map((r) => r.reportedBy))];
    const reporterSnapshots = new Map<
      string,
      { username: string; displayName: string; avatarObjectKey: string }
    >();
    try {
      const snaps = await this.userClient.bulkGetUserSnapshots(reporterIds);
      for (const snap of snaps) reporterSnapshots.set(snap.userId, snap);
    } catch (error) {
      logger.warn(
        `reporter snapshot enrichment failed for reports of stream=${params.livestreamId}: ${String(error)}`
      );
    }

    const items: CommentReportView[] = page.map((r) => {
      const c = byId.get(r.commentId);
      const reporter = reporterSnapshots.get(r.reportedBy);
      return {
        id: r.id,
        commentId: r.commentId,
        livestreamId: r.livestreamId,
        reportedBy: r.reportedBy,
        reporterUsername: reporter?.username ?? "",
        reporterDisplayName: reporter?.displayName ?? "",
        reporterAvatar: reporter?.avatarObjectKey ?? "",
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
   * Bulk report counts for the admin Livestream Management screen. Passing a
   * non-empty `livestreamIds` scopes the aggregation to that set (missing keys
   * ⇒ 0). Passing an empty/undefined `livestreamIds` returns every livestream
   * with `count >= minCount` (used by the has-reports/min-reports filter).
   * Backs the `AdminGetLivestreamReportCounts` gRPC.
   */
  async adminGetReportCounts(params: {
    livestreamIds?: string[];
    minCount?: number;
  }): Promise<{ livestreamId: string; count: number }[]> {
    const rows = await this.reportRepo.groupCountsByLivestream(
      params.livestreamIds
    );
    const scoped = params.livestreamIds && params.livestreamIds.length > 0;
    if (scoped) return rows;
    const min = Math.max(1, params.minCount ?? 1);
    return rows.filter((r) => r.count >= min);
  }

  /**
   * Cursor-paged comment fetch.
   * - `before`: newest-first (history scroll). nextCursor = oldest item's id.
   * - `after`:  oldest-first (reconnect catch-up). nextCursor = newest item's id.
   * Pass nextCursor back as the same cursor direction for the next page.
   *
   * `userId` optional, and when present it is the access gate: local
   * per-stream ban, community-wide ban, and — for a PRIVATE community —
   * membership. Same gate `LivestreamService.checkAccess` and `getStream` run,
   * so chat history cannot be read through a door the stream itself is closed
   * behind.
   *
   * Both REST (`GET /streams/:id/comments`) and both socket paths
   * (`stream:join`'s backfill and `stream:load_more`) DO pass the authenticated
   * caller — the gateway sets `requesterId` on every `GetComments` call. It
   * stays optional only for trusted in-process/internal callers that have no
   * user to attribute; anything user-facing must pass one, or it is reading
   * ungated.
   */
  async getComments(
    livestreamId: string,
    options: { limit: number; before?: string; after?: string },
    userId?: string
  ): Promise<GetCommentsResult> {
    if (userId) {
      if (await this.banRepo.isBanned(livestreamId, userId)) {
        throw new ForbiddenError("STREAM_BANNED");
      }
      const stream = await this.streamRepo.findById(livestreamId);
      // One call covers the community-wide ban AND the membership/visibility
      // gate — `checkCommunityAccess` is the same `checkCommunityMembership`
      // RPC `isCommunityBanned` used, with two more fields read off the reply.
      // Without the membership half, any authenticated caller who knew a
      // streamId could page out a PRIVATE community's whole chat history,
      // author names and avatars included, without ever joining the stream.
      if (stream && stream.creatorId !== userId) {
        try {
          const access = await this.communityClient.checkCommunityAccess(
            stream.communityId,
            userId
          );
          if (access.isBanned) throw new ForbiddenError("STREAM_BANNED");
          if (!access.isMember && !access.isPublicCommunity) {
            throw new ForbiddenError("STREAM_NOT_A_COMMUNITY_MEMBER");
          }
        } catch (error) {
          // A deny decided above must survive the fail-open catch.
          if (error instanceof ForbiddenError) throw error;
          // Fail-open on a community-service outage, same posture as
          // isCommunityBanned: an outage must not black out chat history on its
          // own. The local per-stream ban above stays the synchronous hard gate.
          logger.warn(
            `getComments: community access check failed for stream=${livestreamId} user=${userId}: ${String(error)}`
          );
        }
      }
    }

    const rows = await this.commentRepo.findByLivestreamId(livestreamId, {
      limit: options.limit + 1,
      before: options.before,
      after: options.after,
    });
    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const items = await toDtoList(page);
    const nextCursor =
      hasMore && items.length > 0 ? items[items.length - 1]!.id : null;
    return { items, nextCursor, hasMore };
  }
}
