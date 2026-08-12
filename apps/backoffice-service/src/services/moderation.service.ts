import { NotFoundError } from "@aimess/errors";

import { AUDIT_ACTIONS } from "../constants/index.js";
import { communityClient } from "../grpc/community.client.js";
import { userClient } from "../grpc/user.client.js";
import { streamClient } from "../grpc/stream.client.js";
import type { RawAdminCommunityRow } from "../grpc/community.client.js";
import {
  adminUserRepository,
  communityMembersRepository,
  livestreamRepository,
  reportRepository,
} from "../repositories/index.js";
import type { CommunityMemberRole } from "../types/community.types.js";
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
  LivestreamReportBlock,
  ListReportEvidenceQuery,
  ListReportHistoryQuery,
  ListReportRelatedQuery,
  ListReportsQuery,
  ListReportUsersQuery,
  MessageReportBlock,
  ModeratorRef,
  Paginated,
  RelatedReport,
  ReportCore,
  ReportDetail,
  ReportListItem,
  ReportModerationDetail,
  ReportModerationKind,
  ReportModerationUserRef,
  ReportUserItem,
  ReportUsersPagination,
  PaginationMeta,
  ResolveResult,
} from "../types/moderation.types.js";
import { normalizeReportReason } from "../lib/report-reason.js";
import {
  resolveAvatarOrNull,
  resolveCommunityImageOrNull,
  resolveStreamThumbnailOrNull,
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

/** first+last name, falling back to username; "" when no profile at all. */
function fullNameOf(
  p?: { firstName: string; lastName: string; username: string } | null
): string {
  if (!p) return "";
  const full = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  return full || p.username;
}

/**
 * Report-kind derivation from the reported ENTITY (never the reason category):
 * a community is never reportable, so a reported user carrying a `communityId`
 * is a community MEMBER report (COMMUNITY) while one without is a private USER
 * report; a `stream`/`message` target maps to LIVESTREAM/MESSAGE. Legacy
 * `community`-typed rows (pre-rule) also surface as COMMUNITY. Exhaustive/
 * default-safe so an unexpected target type degrades to USER rather than
 * throwing.
 */
export function toReportKind(
  core: Pick<ReportCore, "targetType" | "communityId">
): ReportModerationKind {
  switch (core.targetType) {
    case "STREAM":
      return "LIVESTREAM";
    case "MESSAGE":
      return "MESSAGE";
    case "COMMUNITY":
      return "COMMUNITY";
    case "USER":
    default:
      return core.communityId ? "COMMUNITY" : "USER";
  }
}

/**
 * A community's current ADMIN member (the `communityAdmin` block). Falls back
 * to community-service's own admin-snapshot fields (name/username) if the
 * user-service profile lookup misses, so a stale/deleted user-service record
 * can't blank the field.
 */
async function resolveCommunityAdmin(
  row: RawAdminCommunityRow
): Promise<ReportModerationUserRef> {
  const [adminProfile, adminAvatar] = await Promise.all([
    userClient.adminGetProfile(row.adminId),
    resolveAvatarOrNull(row.adminAvatarUrl),
  ]);
  return adminProfile
    ? {
        id: row.adminId,
        username: adminProfile.username,
        firstName: adminProfile.firstName,
        lastName: adminProfile.lastName,
        fullName: fullNameOf(adminProfile),
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
}

/**
 * `community` + `communityAdmin` blocks, shared by COMMUNITY / LIVESTREAM /
 * MESSAGE reports. Sourced from the existing `adminGetCommunity` RPC (same one
 * the Community Detail page uses) plus one admin-profile lookup. Both null when
 * the community can't be found (deleted since the report was filed).
 */
async function buildCommunityBlocks(communityId: string): Promise<{
  community: CommunityReportBlock | null;
  communityAdmin: ReportModerationUserRef | null;
}> {
  const detail = await communityClient.adminGetCommunity(communityId);
  if (!detail.found || !detail.community) {
    return { community: null, communityAdmin: null };
  }
  const row = detail.community;
  const [avatar, communityAdmin] = await Promise.all([
    resolveCommunityImageOrNull(row.communityAvatarUrl),
    resolveCommunityAdmin(row),
  ]);
  return {
    community: {
      id: row.communityId,
      name: row.name,
      handle: row.handle,
      avatar,
    },
    communityAdmin,
  };
}

/**
 * `livestream` block for a LIVESTREAM report — sourced from `adminGetStream`
 * (all existing useful stream fields) plus the host profile. Returns the
 * stream's owning `communityId` alongside so the caller can resolve the
 * community/communityAdmin blocks without re-fetching the stream. Null when the
 * stream can't be found.
 */
async function buildLivestreamBlock(streamId: string): Promise<{
  livestream: LivestreamReportBlock;
  communityId: string;
} | null> {
  const stream = await streamClient.adminGetStream(streamId);
  if (!stream) return null;

  const host = await userClient.adminGetProfile(stream.creatorId);
  const [thumbnail, hostAvatar] = await Promise.all([
    resolveStreamThumbnailOrNull(stream.thumbnail || null),
    resolveAvatarOrNull(host?.avatarUrl),
  ]);

  // Mirrors livestreamRepository's viewer-count rule: ended streams report the
  // distinct-user count; live streams report the currently-watching count.
  const ended = stream.endedAt > 0 || /ENDED/i.test(stream.status);
  const live = !ended && /LIVE/i.test(stream.status);

  return {
    communityId: stream.communityId,
    livestream: {
      id: stream.id,
      title: stream.title,
      description: stream.description,
      status: stream.status,
      thumbnail,
      viewerCount: ended ? stream.uniqueViewerCount : stream.totalViews,
      activeViewerCount: live ? stream.viewerCount : 0,
      duration: stream.durationSeconds * 1000,
      startedAt: stream.livedAt || null,
      endedAt: stream.endedAt || null,
      host: host
        ? {
            id: stream.creatorId,
            username: host.username,
            firstName: host.firstName,
            lastName: host.lastName,
            fullName: fullNameOf(host),
            avatar: hostAvatar,
          }
        : null,
    },
  };
}

/**
 * `message` block for a MESSAGE report (community, group or private message —
 * `roomType` says which). Content/media are
 * best-effort null: there is no admin message-content-fetch RPC into
 * chat-service yet, so only the identifiers carried on the report row are
 * populated (`id` = the reported messageId; `senderId` = the resolved reported
 * user when available). The shape matches the eventual full contract so the FE
 * can type against it now; wire the content fields when that RPC lands.
 */
function buildMessageBlock(core: ReportCore): MessageReportBlock {
  return {
    id: core.target.id,
    messageType: null,
    text: null,
    content: null,
    media: [],
    sentAt: null,
    senderId: core.reportedUser?.id ?? null,
    roomId: core.roomId,
    roomType: core.roomType,
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
   * "Reports & Moderation Details" page aggregate for GET /reports/{reportId}.
   * Preserves the flat structure (id / reportReason / reportMessage /
   * reportStatus / reporter / reportedUser / community / communityAdmin) and
   * adds `reportType` (the reported-entity kind) plus the entity-specific
   * `livestream` / `message` blocks. Related entities are fetched only when the
   * report type needs them: USER hits no extra service; COMMUNITY/MESSAGE fetch
   * community + admin; LIVESTREAM additionally fetches the stream. Null (→ 404)
   * when the report doesn't exist.
   */
  async getReportModerationDetail(
    reportId: string
  ): Promise<ReportModerationDetail | null> {
    const core = await reportRepository.getCore(reportId);
    if (!core) return null;

    const reportType = toReportKind(core);
    const base: ReportModerationDetail = {
      id: core.reportId,
      reportType,
      reportReason: normalizeReportReason(core.reason).label,
      reportMessage: core.reporterNote,
      reportStatus: core.status,
      createdAt: core.createdAt,
      updatedAt: core.updatedAt,
      reporter: toModerationUserRef(core.reporterUser),
      reportedUser: toModerationUserRef(core.reportedUser),
      roomId: core.roomId,
      roomType: core.roomType,
    };

    switch (reportType) {
      case "USER":
        return base;

      case "COMMUNITY": {
        const blocks = core.communityId
          ? await buildCommunityBlocks(core.communityId)
          : { community: null, communityAdmin: null };
        return { ...base, ...blocks };
      }

      case "MESSAGE": {
        const blocks = core.communityId
          ? await buildCommunityBlocks(core.communityId)
          : { community: null, communityAdmin: null };
        return { ...base, ...blocks, message: buildMessageBlock(core) };
      }

      case "LIVESTREAM": {
        // Fetch the stream and (when the report carries a communityId) its
        // community in parallel; fall back to the stream's own community when
        // the report row lacks one.
        const [built, preFetched] = await Promise.all([
          buildLivestreamBlock(core.target.id),
          core.communityId
            ? buildCommunityBlocks(core.communityId)
            : Promise.resolve(null),
        ]);
        const blocks =
          preFetched ??
          (built
            ? await buildCommunityBlocks(built.communityId)
            : { community: null, communityAdmin: null });
        return {
          ...base,
          ...blocks,
          livestream: built?.livestream ?? null,
        };
      }
    }
  },

  /**
   * Users list at the bottom of the Report Details page (GET
   * /reports/:reportId/users). One endpoint for both report kinds — reuses the
   * existing read paths rather than duplicating any roster logic:
   *   LIVESTREAM              → the stream's viewer sessions (livestreamRepository.listUsers)
   *   COMMUNITY / MESSAGE     → the reported community's members (communityMembersRepository.listMembers)
   *   USER (no community)     → empty page (no roster to show)
   * Returns null (→ 404) only when the report itself doesn't exist.
   */
  async listReportUsers(
    reportId: string,
    query: ListReportUsersQuery
  ): Promise<{
    items: ReportUserItem[];
    pagination: ReportUsersPagination;
  } | null> {
    const core = await reportRepository.getCore(reportId);
    if (!core) return null;

    if (toReportKind(core) === "LIVESTREAM") {
      return listLivestreamReportUsers(core.target.id, query);
    }
    if (core.communityId) {
      return listCommunityReportUsers(core.communityId, query);
    }
    return { items: [], pagination: emptyUsersPagination(query) };
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

// ---------------------------------------------------------------------------
// Report Details "Users" list helpers (GET /reports/:reportId/users).
// ---------------------------------------------------------------------------

function emptyUsersPagination(q: {
  page: number;
  limit: number;
}): ReportUsersPagination {
  return { page: q.page, limit: q.limit, total: 0, totalPages: 0 };
}

/** Slim the shared PaginationMeta down to the FE's {page,limit,total,totalPages}. */
function toUsersPagination(p: PaginationMeta): ReportUsersPagination {
  return {
    page: p.page,
    limit: p.limit,
    total: p.total ?? 0,
    totalPages: p.totalPages,
  };
}

/** COMMUNITY / MESSAGE report → the reported community's members. */
async function listCommunityReportUsers(
  communityId: string,
  query: ListReportUsersQuery
): Promise<{ items: ReportUserItem[]; pagination: ReportUsersPagination }> {
  // Unified sortBy → community-members gRPC sortField. All three are honored at
  // the DB level in community-service (username|joinedAt|role), each respecting
  // sortDir asc/desc.
  const sortField =
    query.sortBy === "username"
      ? "username"
      : query.sortBy === "joinedAt"
        ? "joinedAt"
        : "role";

  const page = await communityMembersRepository.listMembers(communityId, {
    search: query.search,
    // community-service honors ADMIN|MODERATOR|MEMBER; any other value (e.g.
    // BANNED) is passed through and ignored there rather than 400ing.
    role: query.role as CommunityMemberRole | undefined,
    page: query.page,
    limit: query.limit,
    sortField,
    sortDir: query.sortDir,
  });

  const items: ReportUserItem[] = page.data.map((m) => ({
    userId: m.userId,
    username: m.handle.replace(/^@/, ""),
    displayName: m.username,
    avatar: m.avatar,
    // A banned member surfaces role BANNED (status, not role, upstream).
    role: m.status === "BANNED" ? "BANNED" : m.role,
    joinedAt: m.joinedAt,
  }));
  return { items, pagination: toUsersPagination(page.pagination) };
}

/** LIVESTREAM report → the stream's actual viewer sessions. */
async function listLivestreamReportUsers(
  streamId: string,
  query: ListReportUsersQuery
): Promise<{ items: ReportUserItem[]; pagination: ReportUsersPagination }> {
  try {
    // Unified sortBy → listUsers sortField. joinedAt sorts natively; username/
    // role (and any search/role filter) route through livestreamRepository's
    // bounded candidate-set enrichment path (viewer sessions carry no
    // username/display-name/role column). role filter matches the viewer's
    // community role (Admin|Moderator|Member) — the only implemented viewer role.
    const sortField =
      query.sortBy === "username"
        ? "username"
        : query.sortBy === "role"
          ? "role"
          : "joinedAt";
    const page = await livestreamRepository.listUsers(streamId, {
      page: query.page,
      limit: query.limit,
      sortField,
      sortDir: query.sortDir,
      search: query.search,
      role: query.role,
    });

    const items: ReportUserItem[] = page.data.map((v) => ({
      userId: v.userId,
      username: v.username,
      // Viewer sessions carry no separate display name — fall back to username.
      displayName: v.username,
      avatar: v.avatar,
      role: v.type,
      joinedAt: v.joinedAt,
    }));
    return { items, pagination: toUsersPagination(page.pagination) };
  } catch (err) {
    // The report exists but its stream was deleted → no viewers, not a 404.
    if (err instanceof NotFoundError) {
      return { items: [], pagination: emptyUsersPagination(query) };
    }
    throw err;
  }
}
