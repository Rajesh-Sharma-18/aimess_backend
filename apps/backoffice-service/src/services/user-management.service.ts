import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "@aimess/errors";
import { logger } from "@aimess/logger";
import type { MediaObject } from "@aimess/shared-types";

import { prisma } from "../config/prisma.js";
import { AUDIT_ACTIONS } from "../constants/index.js";
import {
  publishUserBannedSafe,
  publishUserSuspendedSafe,
  publishUserUnbannedSafe,
} from "../messaging/publish-admin-user-event.js";
import {
  communityMembersRepository,
  deriveModerationStatus,
  moderationActionRepository,
  reportDetailRepository,
  userCommunitiesRepository,
  userDirectoryRepository,
} from "../repositories/index.js";
import { authClient } from "../grpc/auth.client.js";
import { chatClient } from "../grpc/chat.client.js";
import { communityClient } from "../grpc/community.client.js";
import { streamClient } from "../grpc/stream.client.js";
import type { RequestAdmin } from "../types/index.js";
import type {
  ListCommunityMembersQuery,
  ListUserCommunitiesQuery,
  Paginated as CommunityPaginated,
  UserCommunityRow,
} from "../types/community.types.js";
import type {
  BanUserInput,
  BulkActivateInput,
  BulkBanInput,
  SuspendUserInput,
  UnbanUserInput,
} from "../api/validators/index.js";
import type {
  BulkResult,
  ListUsersQuery,
  ModerationHistoryItem,
  PaginationMeta,
  ReportRow,
  StatusChange,
  UserDetail,
  UserListItem,
  UserStatus,
  UserStatusResult,
} from "../types/user-management.types.js";
import { auditService } from "./audit.service.js";
import { userAvatarService } from "./user-avatar.service.js";

/** Audit/request context derived from `getRequestContext(req)`. */
type RequestCtx = { ip: string; userAgent: string | null };

/**
 * Normalized co-member query as the validator emits it (post-transform): the
 * canonical member-query fields plus `searchIsEmail` flagging an email search to
 * resolve upstream. `sortField`/`sortDir` are "" when no explicit sort is chosen.
 */
type ListOtherMembersQuery = {
  search?: string;
  searchIsEmail: boolean;
  role?: "ADMIN" | "MODERATOR" | "MEMBER";
  sortField: string;
  sortDir: string;
  page: number;
  limit: number;
};

/** One row of the co-member grid (member view + hydrated email). */
type OtherCommunityMemberRow = {
  userId: string;
  username: string;
  /** Email hydrated from auth-service; null when unavailable. */
  email: string | null;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // no avatar is set. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
  role: string;
  joinedAt: number;
};

/** The acting admin + a precomputed timestamp for this mutation. */
type Actor = { actorId: string; at: number };

/**
 * One "Reported Details" row as returned to the client: the repo's `ReportRow`
 * with the reporter's raw avatar key replaced by a presigned GET URL.
 */
type UserReportRow = Omit<ReportRow, "reporter"> & {
  reporter: {
    userId: string;
    username: string | null;
    /** firstName + lastName (trimmed, single-spaced); null when both are absent. */
    fullname: string | null;
    /**
     * Standard avatar object (see @aimess/shared-types MediaObject); null
     * when no avatar is set. Replaces the legacy bare avatarUrl string.
     */
    avatar: MediaObject | null;
  };
};

function buildActor(actor: RequestAdmin): Actor {
  return { actorId: actor.id, at: Date.now() };
}

/** Add N days to an epoch-ms timestamp (UTC). */
function addDays(ms: number, days: number): Date {
  const d = new Date(ms);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * admin.user_* RabbitMQ events are a cross-service contract (auth-service is
 * the consumer) that predates and is independent of this ticket's HTTP
 * response format change — it still expects ISO strings, so the epoch-ms
 * `Actor.at`/`UserStatusResult` values are converted back at the publish
 * boundary only.
 */
function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Ban-vs-suspend mapping (documented decision):
 *   - POST /ban with `durationDays` null/absent  → PERMANENT ban (status BANNED,
 *     bannedAt set, suspendedUntil null) → publishes admin.user_banned.
 *   - POST /ban with `durationDays > 0`           → treated as a TIME-BOXED
 *     suspend (status SUSPENDED, suspendedUntil = now+days, bannedAt set as the
 *     moment the restriction began) → publishes admin.user_suspended.
 *   - POST /suspend                               → always SUSPENDED with the
 *     required durationDays → publishes admin.user_suspended.
 *   - POST /unban                                 → status ACTIVE, clears
 *     bannedAt/suspendedUntil/banReason → publishes admin.user_unbanned.
 * Bulk writes ONE AuditLog + ONE ModerationAction per AFFECTED user (mirroring
 * moderation's per-target audit granularity), not a single blanket log.
 */
export const userManagementService = {
  /** List users; controller attaches the response `meta` envelope. */
  async listUsers(
    query: ListUsersQuery,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<{
    data: UserListItem[];
    pagination: PaginationMeta;
  }> {
    const page = await userDirectoryRepository.list(query);
    // Presign each raw avatar key into a short-lived GET URL the admin panel can
    // render. Presigning is local signing (no MinIO round-trip) so mapping over
    // the page — bounded by `limit` — is not an N+1.
    const data = await Promise.all(
      page.data.map(async (item) => {
        // Presign-only (no HEAD), so this stays a local-signing map (bounded
        // by `limit`), not an N+1.
        const avatar = await userAvatarService.resolveAvatarOrNull(
          item.avatarUrl
        );
        // `item.avatarUrl` is the raw internal object key (never a response
        // field) — destructure it out so it can't leak via the spread below.
        const { avatarUrl: _avatarUrl, ...rest } = item;
        return {
          ...rest,
          avatar,
        };
      })
    );

    // Audit the list view with the resolved sort + active filters (mirrors the
    // GROUP_LIST_VIEWED precedent). `targetId` is null — this is a collection view.
    // Best-effort + non-blocking: a READ must never 500 because an audit insert
    // failed, so we fire-and-forget and log-and-continue on error. (Mutation
    // paths deliberately keep the blocking model — an unaudited ban is not OK.)
    void auditService
      .record({
        actorId: actor.id,
        action: AUDIT_ACTIONS.USER_LIST_VIEWED,
        targetType: "user",
        targetId: null,
        after: {
          sortBy: query.sortBy ?? "joinedDate",
          sortOrder: query.sortOrder ?? "desc",
          page: query.page,
          limit: query.limit,
          filters: {
            search: query.search ?? null,
            status: query.status ?? null,
            reports: query.reports ?? null,
            dateFrom: query.dateFrom ?? null,
            dateTo: query.dateTo ?? null,
          },
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      .catch((err: unknown) => {
        logger.warn("Failed to record USER_LIST_VIEWED audit", { err });
      });

    return { data, pagination: page.pagination };
  },

  /** Compose the full detail view; null → 404 by the controller. */
  async getUser(userId: string): Promise<UserDetail | null> {
    const row = await userDirectoryRepository.getById(userId);
    if (!row) return null;

    const [
      categoryCounts,
      otherReasons,
      latestReportPage,
      moderationHistory,
      avatar,
    ] = await Promise.all([
      // Single source of truth for report-reason counts (ALL reasons,
      // predefined + "OTHER") — topReasons/reportCount are both derived from
      // this ONE query below instead of each re-aggregating the Report table.
      reportDetailRepository.categoryCounts(userId),
      reportDetailRepository.otherReasonNotes(userId),
      // page 1, limit 1 → just the single most recent report. Reuses the
      // same paginated + gRPC-reporter-enriched query the "Reported
      // Details" list endpoint uses, instead of a bespoke lookup.
      reportDetailRepository.listForUser(userId, 1, 1),
      buildModerationHistory(userId),
      // Nested media descriptor for the avatar (presign-only, no HEAD).
      userAvatarService.resolveAvatarOrNull(row.avatarUrl),
    ]);

    const topReasons = categoryCounts.filter((c) => c.reason !== "OTHER");
    const reportCount = categoryCounts.reduce((sum, c) => sum + c.count, 0);
    const latestReport = latestReportPage.data[0];

    return {
      profile: {
        userId: row.userId,
        username: row.username,
        fullName: row.fullName,
        email: row.email,
        avatar,
        joinedAt: row.joinedAt,
        lastActiveAt: row.lastActiveAt,
      },
      accountStatus: {
        status: row.status,
        since: row.since,
        reason: row.reason,
        suspendedUntil: row.suspendedUntil,
        // moderationHistory is composed here for `appliedBy` only — it is no
        // longer part of the public response (removed per UI requirements).
        appliedBy: moderationHistory[0]?.actorId ?? null,
        ...deriveModerationStatus(row.status),
      },
      reportDetails: {
        reporter: latestReport?.reporter.username ?? null,
        reportDate: latestReport?.createdAt ?? null,
        reportCount,
        topReasons,
        otherReasons,
      },
    };
  },

  /**
   * Paginated "Reported Details" list for a user. Presigns each reporter avatar
   * key into a short-lived GET URL (mapping over the page is bounded by `limit`,
   * not an N+1 — same justification as `listUsers`). The raw key is dropped.
   */
  async listUserReports(
    userId: string,
    page: number,
    limit: number
  ): Promise<{
    data: UserReportRow[];
    pagination: PaginationMeta;
  }> {
    const result = await reportDetailRepository.listForUser(
      userId,
      page,
      limit
    );
    const data = await Promise.all(
      result.data.map(async (row) => {
        // Presign-only (no HEAD), so this stays a local-signing map (bounded
        // by `limit`), not an N+1 — same justification as `listUsers`.
        const avatar = await userAvatarService.resolveAvatarOrNull(
          row.reporter.avatarKey
        );
        const { avatarKey: _avatarKey, ...reporter } = row.reporter;
        return {
          ...row,
          reporter: {
            ...reporter,
            avatar,
          },
        };
      })
    );
    return { data, pagination: result.pagination };
  },

  /**
   * "Communities" grid on the User Management detail screen: the communities
   * the user is an ACTIVE member of (read-through from community-service over
   * gRPC; avatar already presigned upstream). Best-effort, non-blocking audit
   * (a READ must never 500 because an audit insert failed).
   */
  async listUserCommunities(
    userId: string,
    query: ListUserCommunitiesQuery,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<CommunityPaginated<UserCommunityRow>> {
    const result = await userCommunitiesRepository.listUserCommunities(
      userId,
      query
    );

    void auditService
      .record({
        actorId: actor.id,
        action: AUDIT_ACTIONS.USER_COMMUNITIES_VIEWED,
        targetType: "user",
        targetId: userId,
        after: {
          page: query.page,
          limit: query.limit,
          sortField: query.sortField,
          sortDir: query.sortDir,
          filters: { search: query.search ?? null },
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      .catch((err: unknown) => {
        logger.warn("Failed to record USER_COMMUNITIES_VIEWED audit", { err });
      });

    return result;
  },

  /**
   * Co-member grid: the OTHER members of a community the viewed user belongs to
   * (the viewed user is excluded at the DB level via `excludeUserId`, never in
   * memory). Reuses the shared member read-through pipeline, then:
   *   - resolves an email search (`q` containing `@`) to a userId via
   *     auth-service BEFORE the member query (so it filters on the wire), and
   *   - hydrates each returned member's email with ONE batch auth-service call
   *     keyed by the page's userIds (no N+1).
   * Also fetches the community {name, memberCount} block via adminGetCommunity
   * (one extra read; documented). Best-effort, non-blocking audit.
   */
  async listOtherCommunityMembers(
    userId: string,
    communityId: string,
    query: ListOtherMembersQuery,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<{
    community: { communityId: string; name: string; memberCount: number };
    items: OtherCommunityMemberRow[];
    pagination: PaginationMeta;
  }> {
    // Email → userId resolution. An `@`-bearing search is an email; resolve it
    // to a single userId via auth-service (the email owner) and pass THAT as the
    // member-query search (userId match). No match → an empty, valid page.
    let memberSearch = query.search;
    let emailResolvedEmpty = false;
    if (query.searchIsEmail && query.search) {
      const resolvedId = await resolveEmailToUserId(query.search);
      if (resolvedId) {
        memberSearch = resolvedId;
      } else {
        emailResolvedEmpty = true;
      }
    }

    // The community {name, memberCount} header block. One extra read — cheapest
    // source that carries both (adminGetCommunity → community.name + membersTotal).
    const detailPromise = communityClient.adminGetCommunity(communityId);

    const memberQuery: ListCommunityMembersQuery = {
      search: memberSearch,
      role: query.role,
      page: query.page,
      limit: query.limit,
      excludeUserId: userId,
      sortField: query.sortField,
      sortDir: query.sortDir,
    };

    // When an email search resolved to nobody, skip the member round-trip and
    // return an empty page (the header block is still fetched/awaited below).
    const membersPromise = emailResolvedEmpty
      ? Promise.resolve({
          data: [],
          pagination: emptyOffsetMeta(query.page, query.limit),
        })
      : communityMembersRepository.listMembers(communityId, memberQuery);

    const [detail, members] = await Promise.all([
      detailPromise,
      membersPromise,
    ]);

    // Email hydration: ONE batch auth-service call keyed by the page's userIds.
    const ids = members.data.map((m) => m.userId);
    const emailMap = await emailMapForUserIds(ids);

    const items: OtherCommunityMemberRow[] = members.data.map((m) => ({
      userId: m.userId,
      username: m.username,
      email: emailMap.get(m.userId) ?? null,
      avatar: m.avatar,
      role: m.role,
      joinedAt: m.joinedAt,
    }));

    const community = {
      communityId,
      name: detail.community?.name ?? "",
      memberCount: detail.membersTotal,
    };

    void auditService
      .record({
        actorId: actor.id,
        action: AUDIT_ACTIONS.USER_COMMUNITY_MEMBERS_VIEWED,
        targetType: "user",
        targetId: userId,
        after: {
          communityId,
          page: query.page,
          limit: query.limit,
          sortField: query.sortField || null,
          sortDir: query.sortDir || null,
          filters: { search: query.search ?? null, role: query.role ?? null },
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      .catch((err: unknown) => {
        logger.warn("Failed to record USER_COMMUNITY_MEMBERS_VIEWED audit", {
          err,
        });
      });

    return { community, items, pagination: members.pagination };
  },

  async banUser(
    userId: string,
    input: BanUserInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<UserStatusResult> {
    // Community-scoped ban: a completely different operation that happens to
    // share an endpoint. It touches ONE membership and nothing else — the
    // account keeps working everywhere else, so none of the system-ban
    // machinery below (auth status, sessions, cascade) may run.
    if (input.banType === "COMMUNITY") {
      return banFromCommunity(userId, input, actor, ctx);
    }

    // Group-scoped ban: same shape as COMMUNITY — touches ONE group membership
    // (or closes the group if the target owns it) and leaves the account intact.
    if (input.banType === "GROUP") {
      return banFromGroup(userId, input, actor, ctx);
    }

    const ref = buildActor(actor);
    const before = await userDirectoryRepository.getById(userId);

    const timeBoxed = input.durationDays != null && input.durationDays > 0;
    const change: StatusChange = timeBoxed
      ? {
          status: "SUSPENDED",
          reason: input.reason,
          bannedAt: new Date(ref.at),
          suspendedUntil: addDays(ref.at, input.durationDays as number),
        }
      : {
          status: "BANNED",
          reason: input.reason,
          bannedAt: new Date(ref.at),
          suspendedUntil: null,
        };

    // Pre-flight the mirror's transition guard BEFORE touching auth-service.
    //
    // `setStatus` below is what rejects BANNED -> BANNED, and it runs AFTER the
    // auth-service write. Without this check a re-ban of an already-banned
    // account would genuinely ban them (sessions killed, login blocked) and
    // THEN 409 with "user is already banned", so the admin sees an error,
    // assumes nothing happened, and the two stores disagree. Fail first or not
    // at all.
    if (!timeBoxed && before?.status === "BANNED") {
      throw new ConflictError("USER_ALREADY_BANNED");
    }

    // FIRST, and awaited: auth-service owns AuthUser.status, and until this
    // write lands the ban does not exist — the account still logs in on every
    // client. If it fails we abort rather than writing a mirror row that
    // claims a ban nobody is enforcing.
    let revokedSessions = 0;
    if (!timeBoxed) {
      const applied = await authClient
        .adminSetAccountStatus({
          userId,
          status: "BANNED",
          reason: input.reason,
          actorAdminId: ref.actorId,
        })
        .catch((err: unknown) => {
          logger.error("auth-service refused the permanent ban", { err });
          throw new ServiceUnavailableError("USER_BAN_NOT_APPLIED");
        });
      if (!applied.ok) {
        throw applied.errorCode === "USER_NOT_FOUND"
          ? new NotFoundError("USER_NOT_FOUND")
          : new ServiceUnavailableError("USER_BAN_NOT_APPLIED");
      }
      revokedSessions = applied.revokedSessions;
    }

    const result = await userDirectoryRepository.setStatus(userId, change);

    // Space cascade. Best-effort by design: the ban itself has already landed
    // and must not be rolled back because one downstream service blipped — a
    // banned user with a stale membership is far better than a user who is not
    // banned at all. Every id is recorded on the audit row so an operator can
    // see (and re-run) what the ban actually took down.
    const cascade = timeBoxed
      ? emptyCascade()
      : await applySpaceCascade(userId, ref.actorId, input.reason);

    await moderationActionRepository.create({
      actorId: ref.actorId,
      type: timeBoxed ? "suspend_user" : "ban_user",
      targetType: "user",
      targetId: userId,
      reason: input.reason,
      metadata: buildMetadata(input.note ?? null),
      reportId: input.reportId ?? null,
      expiresAt: change.suspendedUntil ?? null,
    });

    await auditService.record({
      actorId: ref.actorId,
      action: timeBoxed
        ? AUDIT_ACTIONS.USER_SUSPENDED
        : AUDIT_ACTIONS.USER_BANNED,
      targetType: "user",
      targetId: userId,
      before: { status: before?.status ?? null },
      after: {
        status: result.status,
        reason: input.reason,
        note: input.note ?? null,
        suspendedUntil: result.suspendedUntil,
        forceLogout: input.forceLogout,
        notifyUser: input.notifyUser,
        banType: timeBoxed ? "SYSTEM_TIMEBOXED" : "SYSTEM",
        permanent: !timeBoxed,
        revokedSessions,
        closedCommunityIds: cascade.closedCommunityIds,
        removedCommunityIds: cascade.removedCommunityIds,
        closedGroupIds: cascade.closedGroupIds,
        removedGroupIds: cascade.removedGroupIds,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    await recordCascadeAudits(ref.actorId, userId, cascade, ctx);

    if (timeBoxed) {
      publishUserSuspendedSafe({
        userId,
        reason: input.reason,
        suspendedUntil:
          result.suspendedUntil != null ? toIso(result.suspendedUntil) : null,
        notifyUser: input.notifyUser,
        actorId: ref.actorId,
        at: toIso(ref.at),
      });
    } else {
      publishUserBannedSafe({
        userId,
        reason: input.reason,
        // Not `input.forceLogout`: a permanent ban always ends every session.
        // Sessions were already revoked synchronously above; this keeps the
        // RabbitMQ safety net consistent if the gRPC call had been lost.
        forceLogout: true,
        notifyUser: input.notifyUser,
        actorId: ref.actorId,
        at: toIso(ref.at),
        banType: "SYSTEM",
        permanent: true,
      });
    }
    // Best-effort: an account ban/suspend must not leave an existing
    // broadcast running on a still-valid access token until it expires.
    void streamClient.forceEndStreamsByCreator(
      userId,
      timeBoxed ? "ACCOUNT_SUSPENDED" : "ACCOUNT_BANNED"
    );

    return result;
  },

  async suspendUser(
    userId: string,
    input: SuspendUserInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<UserStatusResult> {
    const ref = buildActor(actor);
    const before = await userDirectoryRepository.getById(userId);
    const suspendedUntil = addDays(ref.at, input.durationDays);

    const result = await userDirectoryRepository.setStatus(userId, {
      status: "SUSPENDED",
      reason: input.reason,
      bannedAt: new Date(ref.at),
      suspendedUntil,
    });

    await moderationActionRepository.create({
      actorId: ref.actorId,
      type: "suspend_user",
      targetType: "user",
      targetId: userId,
      reason: input.reason,
      metadata: buildMetadata(input.note ?? null),
      expiresAt: suspendedUntil,
    });

    await auditService.record({
      actorId: ref.actorId,
      action: AUDIT_ACTIONS.USER_SUSPENDED,
      targetType: "user",
      targetId: userId,
      before: { status: before?.status ?? null },
      after: {
        status: result.status,
        reason: input.reason,
        note: input.note ?? null,
        suspendedUntil: result.suspendedUntil,
        notifyUser: input.notifyUser,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    publishUserSuspendedSafe({
      userId,
      reason: input.reason,
      suspendedUntil:
        result.suspendedUntil != null ? toIso(result.suspendedUntil) : null,
      notifyUser: input.notifyUser,
      actorId: ref.actorId,
      at: toIso(ref.at),
    });
    // Best-effort — see banUser's identical call for why.
    void streamClient.forceEndStreamsByCreator(userId, "ACCOUNT_SUSPENDED");

    return result;
  },

  // Lifting a ban restores the ability to LOG IN and nothing else.
  //
  // Deliberately does not re-create the community/group memberships the ban
  // removed, and does not reopen the communities/groups that were closed
  // because this user owned them — reviving a space needs its own
  // administrative action (ownership has to be reassigned first). Anything the
  // ban tore down is recorded on the ban's audit row so an operator can see
  // exactly what is NOT coming back.
  async unbanUser(
    userId: string,
    input: UnbanUserInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<UserStatusResult> {
    if (input.banType === "COMMUNITY") {
      return unbanFromCommunity(userId, input, actor, ctx);
    }

    if (input.banType === "GROUP") {
      return unbanFromGroup(userId, input, actor, ctx);
    }

    const ref = buildActor(actor);
    const before = await userDirectoryRepository.getById(userId);

    // Same pre-flight as the ban, for the same reason: the mirror rejects
    // ACTIVE -> ACTIVE, and that rejection must not land after auth-service has
    // already reinstated the account.
    //
    // Deliberately NOT symmetric beyond that: an account whose mirror is out of
    // step with auth-service (a ban that half-applied before this guard existed)
    // must still be recoverable, so anything that is not already ACTIVE is
    // allowed through to the unban.
    if (before?.status === "ACTIVE") {
      throw new ConflictError("USER_NOT_BANNED");
    }

    // Same ordering rule as the ban: auth-service is the source of truth, so
    // the mirror is only updated once the account can genuinely sign in again.
    const lifted = await authClient
      .adminSetAccountStatus({
        userId,
        status: "ACTIVE",
        reason: null,
        actorAdminId: ref.actorId,
      })
      .catch((err: unknown) => {
        logger.error("auth-service refused the unban", { err });
        throw new ServiceUnavailableError("USER_UNBAN_NOT_APPLIED");
      });
    if (!lifted.ok) {
      throw lifted.errorCode === "USER_NOT_FOUND"
        ? new NotFoundError("USER_NOT_FOUND")
        : new ServiceUnavailableError("USER_UNBAN_NOT_APPLIED");
    }

    const result = await userDirectoryRepository.setStatus(userId, {
      status: "ACTIVE",
      reason: null,
      bannedAt: null,
      suspendedUntil: null,
    });

    await moderationActionRepository.create({
      actorId: ref.actorId,
      type: "unban_user",
      targetType: "user",
      targetId: userId,
      reason: input.note ?? "Reinstated by admin",
      metadata: buildMetadata(input.note ?? null),
    });

    await auditService.record({
      actorId: ref.actorId,
      action: AUDIT_ACTIONS.USER_UNBANNED,
      targetType: "user",
      targetId: userId,
      before: { status: before?.status ?? null },
      after: {
        status: result.status,
        note: input.note ?? null,
        banType: "SYSTEM",
        // Recorded explicitly so the trail can never be read as "everything
        // was put back". Nothing the ban removed is restored here.
        membershipsRestored: false,
        spacesReopened: false,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    publishUserUnbannedSafe({
      userId,
      actorId: ref.actorId,
      at: toIso(ref.at),
      banType: "SYSTEM",
    });

    return result;
  },

  async bulkBan(
    userIds: string[],
    input: BulkBanInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<BulkResult> {
    const ref = buildActor(actor);
    const timeBoxed = input.durationDays != null && input.durationDays > 0;
    const change: StatusChange = timeBoxed
      ? {
          status: "SUSPENDED",
          reason: input.reason,
          bannedAt: new Date(ref.at),
          suspendedUntil: addDays(ref.at, input.durationDays as number),
        }
      : {
          status: "BANNED",
          reason: input.reason,
          bannedAt: new Date(ref.at),
          suspendedUntil: null,
        };

    const beforeStatus = await snapshotStatuses(userIds);
    const result = await userDirectoryRepository.bulkSetStatus(userIds, change);

    // One ModerationAction + AuditLog + event per AFFECTED (ok) user.
    for (const item of result.results) {
      if (!item.ok) continue;
      await moderationActionRepository.create({
        actorId: ref.actorId,
        type: timeBoxed ? "suspend_user" : "ban_user",
        targetType: "user",
        targetId: item.userId,
        reason: input.reason,
        metadata: buildMetadata(input.note ?? null, true),
        reportId: input.reportId ?? null,
        expiresAt: change.suspendedUntil ?? null,
      });
      await auditService.record({
        actorId: ref.actorId,
        action: AUDIT_ACTIONS.USER_BULK_BANNED,
        targetType: "user",
        targetId: item.userId,
        before: { status: beforeStatus.get(item.userId) ?? null },
        after: {
          status: item.status,
          reason: input.reason,
          note: input.note ?? null,
          suspendedUntil: change.suspendedUntil?.toISOString() ?? null,
          bulk: true,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      if (timeBoxed) {
        publishUserSuspendedSafe({
          userId: item.userId,
          reason: input.reason,
          suspendedUntil: change.suspendedUntil?.toISOString() ?? null,
          notifyUser: input.notifyUser,
          actorId: ref.actorId,
          at: toIso(ref.at),
        });
      } else {
        publishUserBannedSafe({
          userId: item.userId,
          reason: input.reason,
          forceLogout: input.forceLogout,
          notifyUser: input.notifyUser,
          actorId: ref.actorId,
          at: toIso(ref.at),
        });
      }
      // Best-effort — see banUser's identical call for why.
      void streamClient.forceEndStreamsByCreator(
        item.userId,
        timeBoxed ? "ACCOUNT_SUSPENDED" : "ACCOUNT_BANNED"
      );
    }

    return result;
  },

  async bulkActivate(
    userIds: string[],
    input: BulkActivateInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<BulkResult> {
    const ref = buildActor(actor);

    const beforeStatus = await snapshotStatuses(userIds);
    const result = await userDirectoryRepository.bulkSetStatus(userIds, {
      status: "ACTIVE",
      reason: null,
      bannedAt: null,
      suspendedUntil: null,
      idempotentActive: true,
    });

    for (const item of result.results) {
      if (!item.ok) continue;
      // Already-ACTIVE no-op: counted as succeeded, but nothing changed so we
      // write no audit/moderation row and publish no unban event.
      if (item.changed === false) continue;
      await moderationActionRepository.create({
        actorId: ref.actorId,
        type: "unban_user",
        targetType: "user",
        targetId: item.userId,
        reason: input.note ?? "Reinstated by admin (bulk)",
        metadata: buildMetadata(input.note ?? null, true),
      });
      await auditService.record({
        actorId: ref.actorId,
        action: AUDIT_ACTIONS.USER_BULK_ACTIVATED,
        targetType: "user",
        targetId: item.userId,
        before: { status: beforeStatus.get(item.userId) ?? null },
        after: { status: item.status, note: input.note ?? null, bulk: true },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      publishUserUnbannedSafe({
        userId: item.userId,
        actorId: ref.actorId,
        at: toIso(ref.at),
      });
    }

    return result;
  },
};

// ---------------------------------------------------------------------------
// Detail composition + moderation-trail persistence (admin_db).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Permanent system ban: permission gate, space cascade, community scope.
// ---------------------------------------------------------------------------

// Everything a permanent ban took down, so the audit row can name it and an
// operator can tell what an unban will NOT restore.
type SpaceCascade = {
  closedCommunityIds: string[];
  removedCommunityIds: string[];
  closedGroupIds: string[];
  removedGroupIds: string[];
};

function emptyCascade(): SpaceCascade {
  return {
    closedCommunityIds: [],
    removedCommunityIds: [],
    closedGroupIds: [],
    removedGroupIds: [],
  };
}

// Close the communities and groups the banned user OWNED, and end every other
// membership they held.
//
// Closed, never deleted: the requirement is that the space stays visible in
// every other member's list carrying an explicit closed status, so clients can
// render it disabled instead of having it silently vanish. community-service
// and chat-service each own their half and do their own realtime fan-out.
//
// Both calls are independently guarded: one service being down must not stop
// the other's cascade, and neither can undo the ban that already landed.
async function applySpaceCascade(
  userId: string,
  actorAdminId: string,
  reason: string
): Promise<SpaceCascade> {
  const cascade = emptyCascade();

  const [communities, groups] = await Promise.allSettled([
    communityClient.adminApplySystemBan({ userId, actorAdminId, reason }),
    chatClient.adminApplySystemBan({ userId, actorAdminId, reason }),
  ]);

  if (communities.status === "fulfilled") {
    cascade.closedCommunityIds = communities.value.closedCommunityIds;
    cascade.removedCommunityIds = communities.value.removedCommunityIds;
  } else {
    logger.error("Community cascade failed for a permanent ban", {
      userId,
      err: communities.reason,
    });
  }

  if (groups.status === "fulfilled") {
    cascade.closedGroupIds = groups.value.closedGroupIds;
    cascade.removedGroupIds = groups.value.removedGroupIds;
  } else {
    logger.error("Group cascade failed for a permanent ban", {
      userId,
      err: groups.reason,
    });
  }

  return cascade;
}

// One audit row per closed space. The ban's own row already lists the ids, but
// a closed community is a content-management event in its own right — an
// operator investigating "why did this community go read-only" searches by the
// community, not by the user who happened to be banned that day.
async function recordCascadeAudits(
  actorId: string,
  userId: string,
  cascade: SpaceCascade,
  ctx: RequestCtx
): Promise<void> {
  for (const communityId of cascade.closedCommunityIds) {
    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.COMMUNITY_CLOSED_OWNER_BANNED,
      targetType: "community",
      targetId: communityId,
      after: { status: "CLOSED", reasonCode: "ADMIN_BANNED", ownerId: userId },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
  for (const groupId of cascade.closedGroupIds) {
    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.GROUP_CLOSED_OWNER_BANNED,
      targetType: "group",
      targetId: groupId,
      after: { status: "CLOSED", reasonCode: "ADMIN_BANNED", ownerId: userId },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}

// Ban from ONE community. Delegates to community-service's existing
// platform-admin path, which already performs the membership write, the roster
// + `community:membership:restricted` realtime fan-out, the push notification
// and the community-scoped livestream teardown. Nothing here may touch the
// account: the user keeps logging in and keeps using every other community.
async function banFromCommunity(
  userId: string,
  input: BanUserInput,
  actor: RequestAdmin,
  ctx: RequestCtx
): Promise<UserStatusResult> {
  const communityId = input.communityId as string;
  const result = await communityClient.adminBanCommunityMember({
    communityId,
    targetUserId: userId,
    reason: input.reason,
    actorAdminId: actor.id,
  });
  if (!result.ok) {
    throw mapCommunityScopeError(result.errorCode);
  }

  await moderationActionRepository.create({
    actorId: actor.id,
    type: "ban_community_member",
    targetType: "user",
    targetId: userId,
    reason: input.reason,
    metadata: { communityId, ...(input.note ? { note: input.note } : {}) },
    reportId: input.reportId ?? null,
  });

  await auditService.record({
    actorId: actor.id,
    action: AUDIT_ACTIONS.COMMUNITY_MEMBER_BANNED,
    targetType: "user",
    targetId: userId,
    after: {
      banType: "COMMUNITY",
      communityId,
      status: result.status,
      reason: input.reason,
      note: input.note ?? null,
      permanent: true,
      // Banning a community's own admin closes that community as a side effect;
      // the audit row has to name it or the blast radius is invisible.
      closedCommunity: result.closedCommunity ?? false,
    },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  // The ACCOUNT is untouched, so the account status the caller sees back is
  // whatever it already was — a community ban must never render as "banned"
  // on the user record.
  return currentAccountStatus(userId);
}

async function unbanFromCommunity(
  userId: string,
  input: UnbanUserInput,
  actor: RequestAdmin,
  ctx: RequestCtx
): Promise<UserStatusResult> {
  const communityId = input.communityId as string;
  const result = await communityClient.adminUnbanCommunityMember({
    communityId,
    targetUserId: userId,
    actorAdminId: actor.id,
  });
  if (!result.ok) {
    throw mapCommunityScopeError(result.errorCode);
  }

  await moderationActionRepository.create({
    actorId: actor.id,
    type: "unban_community_member",
    targetType: "user",
    targetId: userId,
    reason: input.note ?? "Community ban lifted by admin",
    metadata: { communityId },
  });

  await auditService.record({
    actorId: actor.id,
    action: AUDIT_ACTIONS.COMMUNITY_MEMBER_UNBANNED,
    targetType: "user",
    targetId: userId,
    after: {
      banType: "COMMUNITY",
      communityId,
      status: result.status,
      note: input.note ?? null,
      // Lifting a community ban leaves the row LEFT, not ACTIVE — the user has
      // to rejoin through the normal flow. Same asymmetry as a system unban.
      membershipRestored: false,
    },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return currentAccountStatus(userId);
}

// A community-scoped ban leaves the ACCOUNT untouched, so the endpoint answers
// with the account's unchanged status rather than reporting it as banned.
async function currentAccountStatus(userId: string): Promise<UserStatusResult> {
  const current = await userDirectoryRepository.getById(userId);
  return {
    userId,
    status: (current?.status ?? "ACTIVE") as UserStatus,
    suspendedUntil: current?.suspendedUntil ?? null,
    bannedAt: null,
  };
}

function mapCommunityScopeError(errorCode: string): Error {
  if (
    errorCode === "COMMUNITY_NOT_FOUND" ||
    errorCode === "COMMUNITY_MEMBER_NOT_FOUND"
  ) {
    return new NotFoundError(errorCode);
  }
  return new ConflictError(errorCode || "COMMUNITY_BAN_FAILED");
}

// Group-scoped ban: the exact community-scoped analogue. Delegates to
// chat-service (owner of aimess_chat) over the AdminBanGroupMember RPC — a
// normal member's membership goes BANNED (evicted, rejoin-blocked); the group
// OWNER instead has the whole group CLOSED (ADMIN_BANNED banner, roster kept).
// The ACCOUNT is never touched, so the caller sees back the unchanged status.
async function banFromGroup(
  userId: string,
  input: BanUserInput,
  actor: RequestAdmin,
  ctx: RequestCtx
): Promise<UserStatusResult> {
  const groupId = input.groupId as string;
  const result = await chatClient.adminBanGroupMember({
    groupId,
    userId,
    actorAdminId: actor.id,
    reason: input.reason,
  });
  if (!result.ok) {
    throw mapGroupScopeError(result.errorCode);
  }

  await moderationActionRepository.create({
    actorId: actor.id,
    type: "ban_group_member",
    targetType: "user",
    targetId: userId,
    reason: input.reason,
    metadata: { groupId, ...(input.note ? { note: input.note } : {}) },
    reportId: input.reportId ?? null,
  });

  await auditService.record({
    actorId: actor.id,
    action: AUDIT_ACTIONS.GROUP_MEMBER_BANNED,
    targetType: "user",
    targetId: userId,
    after: {
      banType: "GROUP",
      groupId,
      reason: input.reason,
      note: input.note ?? null,
      permanent: true,
      // Banning a group's own owner closes that group as a side effect; the
      // audit row names it or the blast radius is invisible.
      closedGroup: result.closedGroup ?? false,
    },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return currentAccountStatus(userId);
}

async function unbanFromGroup(
  userId: string,
  input: UnbanUserInput,
  actor: RequestAdmin,
  ctx: RequestCtx
): Promise<UserStatusResult> {
  const groupId = input.groupId as string;
  const result = await chatClient.adminUnbanGroupMember({
    groupId,
    userId,
    actorAdminId: actor.id,
  });
  if (!result.ok) {
    throw mapGroupScopeError(result.errorCode);
  }

  await moderationActionRepository.create({
    actorId: actor.id,
    type: "unban_group_member",
    targetType: "user",
    targetId: userId,
    reason: input.note ?? "Group ban lifted by admin",
    metadata: { groupId },
  });

  await auditService.record({
    actorId: actor.id,
    action: AUDIT_ACTIONS.GROUP_MEMBER_UNBANNED,
    targetType: "user",
    targetId: userId,
    after: {
      banType: "GROUP",
      groupId,
      note: input.note ?? null,
      // Same asymmetry as community/system unban: the membership stays LEFT (the
      // user must rejoin), and a group CLOSED by an owner ban stays CLOSED.
      membershipRestored: false,
    },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return currentAccountStatus(userId);
}

// chat-service emits CHAT_GROUP_NOT_FOUND / CHAT_GROUP_NOT_ACTIVE /
// CHAT_NOT_A_MEMBER. CHAT_NOT_A_MEMBER is a localized END-USER key (renders as
// "You are not a member of this group") — wrong for a platform admin who was
// never a member — so re-code it to an admin-scoped conflict.
function mapGroupScopeError(errorCode: string): Error {
  if (errorCode === "CHAT_GROUP_NOT_FOUND") {
    return new NotFoundError("GROUP_NOT_FOUND");
  }
  if (errorCode === "CHAT_NOT_A_MEMBER") {
    return new ConflictError("GROUP_MEMBER_NOT_ACTIVE");
  }
  return new ConflictError(errorCode || "GROUP_BAN_FAILED");
}

/**
 * Resolve an email to its owning userId via auth-service. auth-service's
 * `adminListUsers.search` matches account/email; we take the FIRST exact
 * (case-insensitive) email match. Returns null when nobody owns the email.
 * One gRPC call (opossum-wrapped); no N+1.
 */
async function resolveEmailToUserId(email: string): Promise<string | null> {
  const needle = email.trim().toLowerCase();
  let users: Awaited<ReturnType<typeof authClient.adminListUsers>>["users"];
  try {
    ({ users } = await authClient.adminListUsers({
      search: needle,
      limit: 10,
      offset: 0,
    }));
  } catch (err: unknown) {
    logger.warn(
      "Failed to resolve email search via auth-service; degrading to no match",
      { err }
    );
    return null;
  }
  const hit = users.find((u) => u.email.toLowerCase() === needle);
  return hit?.id ?? null;
}

/**
 * Build a userId → email map for a page of members with ONE batch auth-service
 * call (the `userIds` filter), so email hydration is never an N+1. Empty input
 * skips the round-trip.
 */
async function emailMapForUserIds(
  userIds: string[]
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  let users: Awaited<ReturnType<typeof authClient.adminListUsers>>["users"];
  try {
    ({ users } = await authClient.adminListUsers({
      userIds,
      limit: userIds.length,
      offset: 0,
    }));
  } catch (err: unknown) {
    logger.warn(
      "Failed to hydrate member emails from auth-service; degrading to null",
      { err }
    );
    return new Map();
  }
  return new Map(users.map((u) => [u.id, u.email]));
}

/** Empty offset-mode PaginationMeta (zero results) for short-circuit pages. */
function emptyOffsetMeta(page: number, limit: number): PaginationMeta {
  return {
    mode: "offset",
    page,
    limit,
    total: 0,
    totalApprox: 0,
    totalPages: 0,
    hasNext: false,
    hasPrev: page > 1,
    nextCursor: null,
  };
}

/** Build the ModerationAction.metadata JSON (note + bulk marker), or undefined. */
function buildMetadata(
  note: string | null,
  bulk = false
): { note?: string; bulk?: boolean } | undefined {
  if (!note && !bulk) return undefined;
  return {
    ...(note ? { note } : {}),
    ...(bulk ? { bulk: true } : {}),
  };
}

/**
 * Snapshot current status for a set of users before a bulk mutation, so the
 * per-item audit log can carry an accurate `before:{status}` (mirrors the
 * single-mutation paths). Missing users simply don't appear in the map.
 */
async function snapshotStatuses(
  userIds: string[]
): Promise<Map<string, UserStatus>> {
  const rows = await prisma.userIndex.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, status: true },
  });
  return new Map(rows.map((r) => [r.userId, r.status as UserStatus]));
}

/** Moderation trail for a user, newest first. */
async function buildModerationHistory(
  userId: string
): Promise<ModerationHistoryItem[]> {
  const rows = await prisma.moderationAction.findMany({
    where: { targetType: "user", targetId: userId },
    orderBy: { createdAt: "desc" },
  });

  return rows.map((m) => ({
    id: m.id,
    type: m.type,
    actorId: m.actorId,
    reason: m.reason,
    note:
      m.metadata && typeof m.metadata === "object" && "note" in m.metadata
        ? String((m.metadata as { note: unknown }).note)
        : null,
    reportId: m.reportId,
    expiresAt: m.expiresAt?.getTime() ?? null,
    createdAt: m.createdAt.getTime(),
  }));
}
