import { ConflictError, NotFoundError } from "@aimess/errors";
import { createUploadUrl, type UploadUrlResult } from "@aimess/storage";

import { AUDIT_ACTIONS } from "../constants/index.js";
import { livestreamRepository } from "../repositories/index.js";
import type {
  ActorRef,
  EndInput,
  ReviewReportsInput,
} from "../repositories/livestream.repository.js";
import type { RequestAdmin } from "../types/index.js";
import type {
  BulkResult,
  BulkResultItem,
  EndLivestreamResult,
  LivestreamDetail,
  LivestreamListItem,
  LivestreamReportItem,
  ListLivestreamsQuery,
  ListLivestreamReportsQuery,
  PaginationMeta,
} from "../types/livestream.types.js";
import { auditService } from "./audit.service.js";
import { streamClient } from "../grpc/stream.client.js";
import { env } from "../config/env.js";
import {
  presignClient,
  STREAM_THUMBNAIL_UPLOAD_DEF,
} from "../config/storage.js";

/** Audit/request context derived from `getRequestContext(req)`. */
type RequestCtx = { ip: string; userAgent: string | null };

export interface ThumbnailPresignResult extends UploadUrlResult {
  expiresIn: number;
}

/** Map req.admin → the admin stamp recorded on a moderation action. */
function toAdmin(actor: RequestAdmin): { id: string; name: string } {
  // TODO Phase 2: RequestAdmin has no display name; stamp real name once token carries it.
  return { id: actor.id, name: actor.id };
}

export const livestreamService = {
  /** List livestreams; controller attaches the response `meta` envelope. */
  async listLivestreams(query: ListLivestreamsQuery): Promise<{
    data: LivestreamListItem[];
    pagination: PaginationMeta;
  }> {
    const page = await livestreamRepository.list(query);
    return {
      data: page.data,
      pagination: page.pagination,
    };
  },

  /** Fetch one livestream; null is translated to 404 by the controller. */
  async getLivestream(livestreamId: string): Promise<LivestreamDetail | null> {
    const detail = await livestreamRepository.getById(livestreamId);
    if (!detail) return null;

    // Overlay real-time stats from stream-service (fail-open: mock row is returned
    // unchanged if stream-service is unreachable or the stream is not found there).
    const stats = await streamClient.getStreamStats(livestreamId);
    if (stats.found) {
      detail.viewerStats.currentViewers = stats.viewerCount;
      detail.viewerStats.peakViewers = stats.peakViewers;
      detail.viewerStats.chatMessageCount = stats.totalComments;
    }

    return detail;
  },

  /** List a stream's reports; repository 404s on an unknown stream id. */
  async listLivestreamReports(
    livestreamId: string,
    query: ListLivestreamReportsQuery
  ): Promise<{
    data: LivestreamReportItem[];
    pagination: PaginationMeta;
  }> {
    const page = await livestreamRepository.listReports(livestreamId, query);
    return {
      data: page.data,
      pagination: page.pagination,
    };
  },

  async endLivestream(
    livestreamId: string,
    input: EndInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<EndLivestreamResult> {
    const ref = buildActor(actor);
    const before = await livestreamRepository.getById(livestreamId);
    // Fail-closed: must succeed before mutating admin_db.
    // If already ENDED (adminForceEnd returns {success:false}), still proceed
    // with the repo.end() which will throw ConflictError if appropriate.
    await streamClient.adminForceEnd(livestreamId, input.reasonCode);
    const result = await livestreamRepository.end(livestreamId, input, ref);

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.LIVESTREAM_ENDED,
      targetType: "livestream",
      targetId: livestreamId,
      before: { status: before?.status ?? null },
      after: {
        status: result.status,
        reasonCode: result.reasonCode,
        note: input.note ?? null,
        creatorNotified: result.creatorNotified,
        strikeIssued: result.strikeIssued,
        takedownRecording: input.takedownRecording ?? false,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return result;
  },

  async bulkEnd(
    livestreamIds: string[],
    input: EndInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<BulkResult> {
    // Call stream-service gRPC for each stream first (fail-closed per item).
    // already-ENDED is OK — repo.end() will throw ConflictError for those, handled below.
    const ref = buildActor(actor);
    const results: BulkResultItem[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const livestreamId of livestreamIds) {
      try {
        await streamClient.adminForceEnd(livestreamId, input.reasonCode);
      } catch (err) {
        failed += 1;
        results.push({
          id: livestreamId,
          ok: false,
          error: {
            code: "STREAM_SERVICE_UNAVAILABLE",
            message:
              err instanceof Error ? err.message : "stream-service gRPC failed",
          },
        });
        continue;
      }
      try {
        const r = await livestreamRepository.end(livestreamId, input, ref);
        results.push({ id: livestreamId, status: r.status, ok: true });
        succeeded += 1;
      } catch (err) {
        failed += 1;
        const code =
          err instanceof ConflictError
            ? "LIVESTREAM_ALREADY_ENDED"
            : err instanceof NotFoundError
              ? err.message
              : "BULK_ITEM_FAILED";
        const message = err instanceof Error ? err.message : "Unexpected error";
        results.push({ id: livestreamId, ok: false, error: { code, message } });
      }
    }

    const result: BulkResult = {
      requested: livestreamIds.length,
      succeeded,
      failed,
      results,
    };

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.LIVESTREAM_BULK_ENDED,
      targetType: "livestream",
      targetId: null,
      after: {
        requested: result.requested,
        succeeded: result.succeeded,
        failed: result.failed,
        livestreamIds,
        reasonCode: input.reasonCode,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return result;
  },

  async bulkReviewReports(
    reportIds: string[],
    input: ReviewReportsInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<BulkResult> {
    const ref = buildActor(actor);
    const result = await livestreamRepository.bulkReviewReports(
      reportIds,
      input,
      ref
    );

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.LIVESTREAM_REPORTS_BULK_REVIEWED,
      targetType: "livestream_report",
      targetId: null,
      after: {
        requested: result.requested,
        succeeded: result.succeeded,
        failed: result.failed,
        reportIds,
        status: input.status,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return result;
  },
};

/** Build the repository ActorRef (admin stamp + action timestamp). */
function buildActor(actor: RequestAdmin): ActorRef {
  return { admin: toAdmin(actor), at: new Date().toISOString() };
}

export const thumbnailService = {
  /**
   * Generate a presigned PUT URL so the admin client can upload a stream
   * thumbnail directly to MinIO. The livestream must exist (404 guard).
   * Throws StorageValidationError (UNSUPPORTED_CONTENT_TYPE / FILE_TOO_LARGE)
   * on invalid content — controllers map these to 400.
   */
  async presignUpload(
    livestreamId: string,
    {
      contentType,
      contentLength,
    }: { contentType: string; contentLength: number }
  ): Promise<ThumbnailPresignResult> {
    const exists = await livestreamRepository.getById(livestreamId);
    if (!exists) throw new NotFoundError("LIVESTREAM_NOT_FOUND");

    const result = await createUploadUrl({
      client: presignClient,
      def: STREAM_THUMBNAIL_UPLOAD_DEF,
      contentType,
      contentLength,
      ownerId: livestreamId,
      expiresIn: env.MINIO_STREAM_THUMBNAIL_UPLOAD_EXPIRES_IN,
    });

    return {
      ...result,
      expiresIn: env.MINIO_STREAM_THUMBNAIL_UPLOAD_EXPIRES_IN,
    };
  },

  /**
   * Persist the uploaded thumbnail objectKey by calling stream-service over
   * gRPC, then record an audit entry. The livestream must exist (404 guard).
   */
  async saveThumbnail(
    livestreamId: string,
    objectKey: string,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<void> {
    const exists = await livestreamRepository.getById(livestreamId);
    if (!exists) throw new NotFoundError("LIVESTREAM_NOT_FOUND");

    await streamClient.adminUpdateThumbnail(livestreamId, objectKey);

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.LIVESTREAM_THUMBNAIL_UPDATED,
      targetType: "livestream",
      targetId: livestreamId,
      before: { thumbnail: exists.thumbnailUrl ?? null },
      after: { thumbnail: objectKey },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  },
};
