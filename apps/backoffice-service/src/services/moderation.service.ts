import { AUDIT_ACTIONS } from "../constants/index.js";
import { reportRepository } from "../repositories/index.js";
import type {
  ActorRef,
  DismissInput,
  ResolveInput,
} from "../repositories/report.repository.js";
import type { RequestAdmin } from "../types/index.js";
import type {
  BulkResult,
  DismissResult,
  ListReportsQuery,
  ModeratorRef,
  ReportDetail,
  ReportListItem,
  PaginationMeta,
  ResolveResult,
} from "../types/moderation.types.js";
import { auditService } from "./audit.service.js";

/** Audit/request context derived from `getRequestContext(req)`. */
type RequestCtx = { ip: string; userAgent: string | null };

/** Map req.admin → the moderator stamp recorded on a decision. */
function toModerator(actor: RequestAdmin): ModeratorRef {
  // TODO Phase 2: RequestAdmin has no display name; stamp real name once token carries it.
  return { id: actor.id, name: actor.id };
}

export const moderationService = {
  /** List reports; controller attaches the response `meta` envelope. */
  async listReports(query: ListReportsQuery): Promise<{
    data: ReportListItem[];
    pagination: PaginationMeta;
  }> {
    const page = await reportRepository.list(query);
    return {
      data: page.data,
      pagination: page.pagination,
    };
  },

  /** Fetch one report; null is translated to 404 by the controller. */
  getReport(reportId: string): Promise<ReportDetail | null> {
    return reportRepository.getById(reportId);
  },

  async resolveReport(
    reportId: string,
    input: ResolveInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<ResolveResult> {
    const ref = buildActor(actor);
    const before = await reportRepository.getById(reportId);
    const result = await reportRepository.resolve(reportId, input, ref);

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.REPORT_RESOLVED,
      targetType: "report",
      targetId: reportId,
      before: { status: before?.status ?? null },
      after: {
        status: result.status,
        resolution: result.resolution,
        actionOnReportedUser: input.actionOnReportedUser,
        note: input.note ?? null,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return result;
  },

  async dismissReport(
    reportId: string,
    input: DismissInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<DismissResult> {
    const ref = buildActor(actor);
    const before = await reportRepository.getById(reportId);
    const result = await reportRepository.dismiss(reportId, input, ref);

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.REPORT_DISMISSED,
      targetType: "report",
      targetId: reportId,
      before: { status: before?.status ?? null },
      after: {
        status: result.status,
        dismissReason: result.dismissReason,
        note: input.note ?? null,
        // Captured in the audit `after` but intentionally not persisted on the
        // report in Phase 1 (no reporter-reputation store yet).
        flagFalseReport: input.flagFalseReport ?? false,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return result;
  },

  async bulkResolve(
    reportIds: string[],
    input: ResolveInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<BulkResult> {
    const ref = buildActor(actor);
    const result = await reportRepository.bulkResolve(reportIds, input, ref);

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.REPORT_BULK_RESOLVED,
      targetType: "report",
      targetId: null,
      after: {
        requested: result.requested,
        succeeded: result.succeeded,
        failed: result.failed,
        reportIds,
        resolution: input.resolution,
        actionOnReportedUser: input.actionOnReportedUser,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return result;
  },

  async bulkDismiss(
    reportIds: string[],
    input: DismissInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<BulkResult> {
    const ref = buildActor(actor);
    const result = await reportRepository.bulkDismiss(reportIds, input, ref);

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.REPORT_BULK_DISMISSED,
      targetType: "report",
      targetId: null,
      after: {
        requested: result.requested,
        succeeded: result.succeeded,
        failed: result.failed,
        reportIds,
        reason: input.reason,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return result;
  },
};

/** Build the repository ActorRef (moderator stamp + decision timestamp). */
function buildActor(actor: RequestAdmin): ActorRef {
  return { moderator: toModerator(actor), at: new Date().toISOString() };
}
