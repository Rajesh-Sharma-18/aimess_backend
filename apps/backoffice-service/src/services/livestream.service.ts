import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from "@aimess/errors";
import { logger } from "@aimess/logger";
import {
  assertObjectKeyOwnedBy,
  createUploadUrl,
  type UploadUrlResult,
} from "@aimess/storage";

import { getMediaConfirmClient } from "../grpc/media.client.js";

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
  EndLivestreamResult,
  LivestreamDetail,
  LivestreamListItem,
  LivestreamReportItem,
  LivestreamUserItem,
  ListLivestreamsQuery,
  ListLivestreamReportsQuery,
  ListLivestreamUsersQuery,
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

  /**
   * List the members of a stream's community (the admin "Livestream User List").
   * Repository 404s on an unknown stream id. Supports search + role/type filter
   * + pagination via the shared community-members gRPC read path.
   */
  async listLivestreamUsers(
    livestreamId: string,
    query: ListLivestreamUsersQuery
  ): Promise<{
    data: LivestreamUserItem[];
    pagination: PaginationMeta;
  }> {
    const page = await livestreamRepository.listUsers(livestreamId, query);
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
    // Light pre-read for the audit `before` snapshot (no enrichment). The repo's
    // end() re-validates and performs the gRPC force-end against stream-service
    // (the source of truth) — throwing NotFound/Conflict as appropriate.
    const before = await streamClient.adminGetStream(livestreamId);
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
    // Each item: repo.end() validates + force-ends against stream-service and
    // throws NotFound/Conflict, which the bulk runner records per item.
    const ref = buildActor(actor);
    const result = await livestreamRepository.bulkEnd(
      livestreamIds,
      input,
      ref
    );

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
  return { admin: toAdmin(actor), at: Date.now() };
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

    // The key must belong to THIS livestream. The route validator only checked
    // the `stream/thumbnail/` prefix — a condition every key in the category
    // satisfies — so a moderator could commit a key minted for a different
    // livestream. `ownerId` is the livestreamId for this category
    // (`presignUpload` passes it as such), which is exactly what makes the
    // standard ownership helper applicable here.
    if (!assertObjectKeyOwnedBy(objectKey, "stream/thumbnail", livestreamId)) {
      throw new BadRequestError("LIVESTREAM_THUMBNAIL_INVALID_KEY");
    }

    // Run the SHARED security pipeline over the uploaded bytes before the key is
    // persisted. Previously nothing inspected this object at all: no HeadObject,
    // no magic bytes, no structural checks, no AV scan — and the presigned PUT
    // signs only Content-Type, so the declared 5 MB was never enforced either.
    // media-service rejects and DELETES the object on failure.
    let verdict;
    try {
      verdict = await getMediaConfirmClient().confirmUpload(
        objectKey,
        livestreamId
      );
    } catch (err) {
      logger.warn("thumbnail: media-service unreachable — refusing to commit", {
        livestreamId,
        objectKey,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new ServiceUnavailableError("MEDIA_REGISTRY_UNAVAILABLE");
    }

    if (!verdict.downloadable) {
      logger.warn("media-security", {
        event: "media.thumbnail_rejected",
        livestreamId,
        objectKey,
        scanStatus: verdict.scanStatus,
        adminId: actor.id,
      });
      throw new BadRequestError(
        verdict.scanStatus === "INFECTED" ||
          verdict.scanStatus === "QUARANTINED"
          ? "MEDIA_MALWARE_DETECTED"
          : verdict.scanStatus === "REJECTED"
            ? "MEDIA_SECURITY_VALIDATION_FAILED"
            : "MEDIA_NOT_VERIFIED"
      );
    }

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
