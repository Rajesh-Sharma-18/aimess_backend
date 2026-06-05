import { prisma } from "../config/prisma.js";
import { AUDIT_ACTIONS } from "../constants/index.js";
import {
  publishUserBannedSafe,
  publishUserSuspendedSafe,
  publishUserUnbannedSafe,
} from "../messaging/publish-admin-user-event.js";
import {
  moderationActionRepository,
  reportDetailRepository,
  userDirectoryRepository,
} from "../repositories/index.js";
import type { RequestAdmin } from "../types/index.js";
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
  ReportsSummary,
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

/** The acting admin + a precomputed timestamp for this mutation. */
type Actor = { actorId: string; at: string };

/**
 * One "Reported Details" row as returned to the client: the repo's `ReportRow`
 * with the reporter's raw avatar key replaced by a presigned GET URL.
 */
type UserReportRow = Omit<ReportRow, "reporter"> & {
  reporter: {
    userId: string;
    username: string | null;
    /** Presigned GET URL for the reporter's avatar, or null. */
    avatarUrl: string | null;
    /** Lifetime of `avatarUrl` in seconds; null when avatarUrl is null. */
    avatarUrlExpiresIn: number | null;
  };
};

function buildActor(actor: RequestAdmin): Actor {
  return { actorId: actor.id, at: new Date().toISOString() };
}

/** Add N days to an ISO timestamp (UTC). */
function addDays(iso: string, days: number): Date {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
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
  async listUsers(query: ListUsersQuery): Promise<{
    data: UserListItem[];
    pagination: PaginationMeta;
  }> {
    const page = await userDirectoryRepository.list(query);
    // Presign each raw avatar key into a short-lived GET URL the admin panel can
    // render. Presigning is local signing (no MinIO round-trip) so mapping over
    // the page — bounded by `limit` — is not an N+1.
    const data = await Promise.all(
      page.data.map(async (item) => {
        const av = await userAvatarService.resolveViewUrl(item.avatarUrl);
        return {
          ...item,
          avatarUrl: av?.url ?? null,
          avatarUrlExpiresIn: av?.expiresIn ?? null,
        };
      })
    );
    return { data, pagination: page.pagination };
  },

  /** Compose the full detail view; null → 404 by the controller. */
  async getUser(userId: string): Promise<UserDetail | null> {
    const row = await userDirectoryRepository.getById(userId);
    if (!row) return null;

    const [reportsSummary, reportCategories, moderationHistory, avatar] =
      await Promise.all([
        buildReportsSummary(userId),
        reportDetailRepository.categoryCounts(userId),
        buildModerationHistory(userId),
        // Presign the raw avatar key (from user-service via gRPC) into a GET URL.
        userAvatarService.resolveViewUrl(row.avatarUrl),
      ]);

    return {
      profile: {
        userId: row.userId,
        username: row.username,
        email: row.email,
        // Presigned GET URL (null when unset / presign unavailable).
        avatarUrl: avatar?.url ?? null,
        avatarUrlExpiresIn: avatar?.expiresIn ?? null,
        joinedAt: row.joinedAt,
        lastActiveAt: row.lastActiveAt,
      },
      accountStatus: {
        status: row.status,
        since: row.since,
        reason: row.reason,
        suspendedUntil: row.suspendedUntil,
        appliedBy: moderationHistory[0]?.actorId ?? null,
      },
      reportsSummary,
      reportCategories,
      // Deliberately empty: the User Management Details screen sources community
      // data from the dedicated endpoints (GET /communities/:id and
      // /communities/:id/members). A user's *own* membership list needs a
      // user→communities reverse-lookup RPC that community-service does not
      // expose yet — deferred until that screen requires it.
      communities: [],
      moderationHistory,
      // reportCount mirrors the aggregated reports total (admin_db); the live
      // directory row no longer carries a denormalized count.
      stats: { reportCount: reportsSummary.total },
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
        const av = await userAvatarService.resolveViewUrl(
          row.reporter.avatarKey
        );
        const { avatarKey: _avatarKey, ...reporter } = row.reporter;
        return {
          ...row,
          reporter: {
            ...reporter,
            avatarUrl: av?.url ?? null,
            avatarUrlExpiresIn: av?.expiresIn ?? null,
          },
        };
      })
    );
    return { data, pagination: result.pagination };
  },

  async banUser(
    userId: string,
    input: BanUserInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<UserStatusResult> {
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

    const result = await userDirectoryRepository.setStatus(userId, change);

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
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    if (timeBoxed) {
      publishUserSuspendedSafe({
        userId,
        reason: input.reason,
        suspendedUntil: result.suspendedUntil,
        notifyUser: input.notifyUser,
        actorId: ref.actorId,
        at: ref.at,
      });
    } else {
      publishUserBannedSafe({
        userId,
        reason: input.reason,
        forceLogout: input.forceLogout,
        notifyUser: input.notifyUser,
        actorId: ref.actorId,
        at: ref.at,
      });
    }

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
      suspendedUntil: result.suspendedUntil,
      notifyUser: input.notifyUser,
      actorId: ref.actorId,
      at: ref.at,
    });

    return result;
  },

  async unbanUser(
    userId: string,
    input: UnbanUserInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<UserStatusResult> {
    const ref = buildActor(actor);
    const before = await userDirectoryRepository.getById(userId);

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
      after: { status: result.status, note: input.note ?? null },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    publishUserUnbannedSafe({
      userId,
      actorId: ref.actorId,
      at: ref.at,
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
          at: ref.at,
        });
      } else {
        publishUserBannedSafe({
          userId: item.userId,
          reason: input.reason,
          forceLogout: input.forceLogout,
          notifyUser: input.notifyUser,
          actorId: ref.actorId,
          at: ref.at,
        });
      }
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
        at: ref.at,
      });
    }

    return result;
  },
};

// ---------------------------------------------------------------------------
// Detail composition + moderation-trail persistence (admin_db).
// ---------------------------------------------------------------------------

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

/** Aggregate Reports filed against a user (type='user', targetId=userId). */
async function buildReportsSummary(userId: string): Promise<ReportsSummary> {
  const grouped = await prisma.report.groupBy({
    by: ["status"],
    where: { type: "user", targetId: userId },
    _count: { _all: true },
  });

  const byStatus = new Map<string, number>();
  let total = 0;
  for (const g of grouped) {
    const c = g._count._all;
    byStatus.set(g.status, c);
    total += c;
  }

  const topGrouped = await prisma.report.groupBy({
    by: ["reason"],
    where: { type: "user", targetId: userId },
    _count: { _all: true },
    orderBy: { _count: { reason: "desc" } },
    take: 5,
  });

  return {
    total,
    open: byStatus.get("open") ?? 0,
    resolved: byStatus.get("resolved") ?? 0,
    dismissed: byStatus.get("dismissed") ?? 0,
    topReasons: topGrouped.map((g) => ({
      reason: g.reason,
      count: g._count._all,
    })),
  };
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
    expiresAt: m.expiresAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  }));
}
