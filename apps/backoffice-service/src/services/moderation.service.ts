import { AUDIT_ACTIONS } from "../constants/index.js";
import { communityClient } from "../grpc/community.client.js";
import { userClient } from "../grpc/user.client.js";
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
  PaginationMeta,
  ResolveResult,
} from "../types/moderation.types.js";
import { normalizeReportReason } from "../lib/report-reason.js";
import {
  resolveAvatarOrNull,
  resolveCommunityImageOrNull,
} from "../lib/avatar-media.js";
import { auditService } from "./audit.service.js";

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
    firstName: string;
    lastName: string;
    avatar: import("@aimess/shared-types").MediaObject | null;
  } | null
): ReportModerationUserRef | null {
  if (!ref) return null;
  return {
    id: ref.id,
    username: ref.username,
    firstName: ref.firstName,
    lastName: ref.lastName,
    fullName: ref.displayName,
    avatar: ref.avatar,
  };
}

/**
 * Community + communityAdmin blocks for the Reports & Moderation Details page,
 * sourced from the existing `adminGetCommunity` RPC (same one
 * community.grpc.repository.ts uses for the Community Detail page) plus one
 * admin-profile lookup (user-service) for the community's current ADMIN
 * member's firstName/lastName. Falls back to community-service's own
 * admin-snapshot fields (name/username/avatar) if the profile lookup misses,
 * so a stale/deleted user-service record can't blank the whole block.
 */
async function buildCommunityBlocks(communityId: string): Promise<{
  community: CommunityReportBlock | null;
  communityAdmin: ReportModerationUserRef | null;
}> {
  const res = await communityClient.adminGetCommunity(communityId);
  if (!res.found || !res.community) {
    return { community: null, communityAdmin: null };
  }
  const row = res.community;

  const [avatar, adminProfile, adminAvatar] = await Promise.all([
    resolveCommunityImageOrNull(row.communityAvatarUrl),
    userClient.adminGetProfile(row.adminId),
    resolveAvatarOrNull(row.adminAvatarUrl),
  ]);

  const community: CommunityReportBlock = {
    id: row.communityId,
    name: row.name,
    handle: row.handle,
    avatar,
  };

  const communityAdmin: ReportModerationUserRef = adminProfile
    ? {
        id: row.adminId,
        username: adminProfile.username,
        firstName: adminProfile.firstName,
        lastName: adminProfile.lastName,
        fullName:
          [adminProfile.firstName, adminProfile.lastName]
            .filter(Boolean)
            .join(" ")
            .trim() || adminProfile.username,
        avatar: adminAvatar,
      }
    : {
        id: row.adminId,
        username: row.adminUsername,
        firstName: "",
        lastName: "",
        fullName: row.adminName,
        avatar: adminAvatar,
      };

  return { community, communityAdmin };
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
   * a flattened report block plus reporter/reportedUser/communityAdmin/community
   * — reusing {@link reportRepository.getCore} (already enriches
   * reportedUser/reporterUser via user-service) and `communityClient`
   * (community + its current admin). Null (→ 404) when the report doesn't
   * exist. `community`/`communityAdmin` are null when the report has no
   * associated community.
   */
  async getReportModerationDetail(
    reportId: string
  ): Promise<ReportModerationDetail | null> {
    const core = await reportRepository.getCore(reportId);
    if (!core) return null;

    const reportedUser = toModerationUserRef(core.reportedUser);
    const reporter = toModerationUserRef(core.reporterUser);
    const { community, communityAdmin } = core.communityId
      ? await buildCommunityBlocks(core.communityId)
      : { community: null, communityAdmin: null };

    return {
      id: core.reportId,
      type: core.reportType,
      reportReason: normalizeReportReason(core.reason).label,
      reportMessage: core.reporterNote,
      reportStatus: core.status,
      createdAt: core.createdAt,
      updatedAt: core.updatedAt,
      reporter,
      reportedUser,
      communityAdmin,
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
  return { moderator: await toModerator(actor), at: Date.now() };
}
