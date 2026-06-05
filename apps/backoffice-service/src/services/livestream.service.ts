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
  ListLivestreamsQuery,
  ListLivestreamReportsQuery,
  PaginationMeta,
} from "../types/livestream.types.js";
import { auditService } from "./audit.service.js";

/** Audit/request context derived from `getRequestContext(req)`. */
type RequestCtx = { ip: string; userAgent: string | null };

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
  getLivestream(livestreamId: string): Promise<LivestreamDetail | null> {
    return livestreamRepository.getById(livestreamId);
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
  return { admin: toAdmin(actor), at: new Date().toISOString() };
}
