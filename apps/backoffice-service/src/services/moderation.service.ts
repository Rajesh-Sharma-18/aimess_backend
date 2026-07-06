import { AUDIT_ACTIONS } from "../constants/index.js";
import { communityClient } from "../grpc/community.client.js";
import {
  adminUserRepository,
  reportRepository,
} from "../repositories/index.js";
import type {
  ActorRef,
  DismissInput,
  ResolveInput,
} from "../repositories/report.repository.js";
import type { RequestAdmin } from "../types/index.js";
import type {
  BulkResult,
  CommunityReportBlock,
  DismissResult,
  EvidenceItem,
  HistoryItem,
  ListReportEvidenceQuery,
  ListReportHistoryQuery,
  ListReportRelatedQuery,
  ListReportsQuery,
  ModeratorRef,
  Paginated,
  RelatedReport,
  ReportCore,
  ReportDetail,
  ReportListItem,
  ReportModerationDetail,
  ReportModerationUserRef,
  ReportTarget,
  PaginationMeta,
  ResolveResult,
} from "../types/moderation.types.js";
import { auditService } from "./audit.service.js";
import { userAvatarService } from "./user-avatar.service.js";

/** Audit/request context derived from `getRequestContext(req)`. */
type RequestCtx = { ip: string; userAgent: string | null };

/**
 * Map req.admin → the moderator stamp recorded on a decision. RequestAdmin
 * (the JWT claims) has no display name, but AdminUser.name is one same-DB
 * lookup away — falls back to the id only if the admin row is somehow gone.
 */
async function toModerator(actor: RequestAdmin): Promise<ModeratorRef> {
  const admin = await adminUserRepository.findById(actor.id);
  return { id: actor.id, name: admin?.name ?? actor.id };
}

/**
 * Reshape an already-enriched report-core user ref (id/username/displayName/
 * avatar — populated by {@link reportRepository.getCore} via user-service)
 * into the Reports & Moderation Details page's compact shape. No new profile
 * lookup or re-presign — the avatar is already resolved.
 */
function toModerationUserRef(
  ref: {
    id: string;
    username: string;
    displayName: string;
    avatar: import("@aimess/shared-types").MediaObject | null;
  } | null
): ReportModerationUserRef | null {
  if (!ref) return null;
  return {
    id: ref.id,
    username: ref.username,
    fullName: ref.displayName,
    avatar: ref.avatar,
  };
}

/**
 * "Community Report Details" block: name/avatar/category from the existing
 * batch `adminGetCommunitiesByIds` gRPC (community-service). Avatar is presigned
 * via the user-avatar service. `reportedMessage` carries only the message id —
 * no admin RPC exists to fetch message content by id, so it is not fabricated here.
 */
async function buildCommunityReportBlock(
  communityId: string,
  reportedDate: string,
  target: ReportTarget
): Promise<CommunityReportBlock> {
  const communities = await communityClient.adminGetCommunitiesByIds([
    communityId,
  ]);
  const c = communities.get(communityId);
  const avatar = await userAvatarService.resolveAvatarOrNull(
    c?.avatarUrl || null
  );
  return {
    id: communityId,
    name: c?.name ?? "",
    avatar,
    category: { id: c?.categoryId ?? "", name: c?.categoryName ?? "" },
    reportedDate,
    reportedMessage: target.type === "MESSAGE" ? { id: target.id } : null,
  };
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

  getReportCore(reportId: string): Promise<ReportCore | null> {
    return reportRepository.getCore(reportId);
  },

  /**
   * "Reports & Moderation Details" page aggregate for GET /reports/{reportId}:
   * the report block and the "Community Report Details" block — reusing
   * {@link reportRepository.getCore} (already enriches reportedUser/reporterUser
   * via user-service) and `communityClient` (community name/avatar/category).
   * Null (→ 404) when the report doesn't exist. `community` is null when the
   * report has no associated community.
   */
  async getReportModerationDetail(
    reportId: string
  ): Promise<ReportModerationDetail | null> {
    const core = await reportRepository.getCore(reportId);
    if (!core) return null;

    const reportedUser = toModerationUserRef(core.reportedUser);
    const reporter = toModerationUserRef(core.reporterUser);
    const community = core.communityId
      ? await buildCommunityReportBlock(
          core.communityId,
          core.createdAt,
          core.target
        )
      : null;

    return {
      report: {
        id: core.reportId,
        type: core.reportType,
        status: core.status,
        createdAt: core.createdAt,
        ...(core.reportType === "OTHER"
          ? { otherReason: core.reporterNote }
          : {}),
        reportedUser,
        reporter,
      },
      community,
    };
  },

  listReportEvidence(
    reportId: string,
    query: ListReportEvidenceQuery
  ): Promise<Paginated<EvidenceItem>> {
    return reportRepository.listEvidence(reportId, query);
  },

  listReportHistory(
    reportId: string,
    query: ListReportHistoryQuery
  ): Promise<Paginated<HistoryItem>> {
    return reportRepository.listHistory(reportId, query);
  },

  listReportRelated(
    reportId: string,
    query: ListReportRelatedQuery
  ): Promise<Paginated<RelatedReport>> {
    return reportRepository.listRelated(reportId, query);
  },

  async resolveReport(
    reportId: string,
    input: ResolveInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<ResolveResult> {
    const ref = await buildActor(actor);
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
    const ref = await buildActor(actor);
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
    const ref = await buildActor(actor);
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
    const ref = await buildActor(actor);
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
async function buildActor(actor: RequestAdmin): Promise<ActorRef> {
  return { moderator: await toModerator(actor), at: new Date().toISOString() };
}
