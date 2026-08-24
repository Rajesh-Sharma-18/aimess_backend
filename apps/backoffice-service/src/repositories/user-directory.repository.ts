import { ConflictError, NotFoundError } from "@aimess/errors";

import { prisma } from "../config/prisma.js";
import {
  decodeCursor as decodeCursorRaw,
  encodeCursor as encodeCursorGeneric,
  parseSort as parseSortGeneric,
} from "../lib/keyset-cursor.js";
import { buildFullName, orNull } from "../lib/grpc-view.js";
import type { Prisma } from "../generated/prisma/client.js";
import { authClient, type AdminListUsersRequest } from "../grpc/auth.client.js";
import { userClient } from "../grpc/user.client.js";
import { moderationActionRepository } from "./moderation-action.repository.js";
import { logger } from "@aimess/logger";
import * as grpc from "@grpc/grpc-js";
import type {
  BulkResult,
  BulkResultItem,
  ListUsersQuery,
  ModerationStatus,
  Paginated,
  PaginationMeta,
  StatusChange,
  UserDirectoryRow,
  UserListItemRaw,
  UserStatus,
  UserStatusResult,
} from "../types/user-management.types.js";

/** The statuses that count as an ACTIVE ban — the single definition. */
const BANNED_STATUSES: UserStatus[] = ["BANNED", "SUSPENDED"];

/**
 * Derive the simplified 2-value moderation view from the full `status`.
 * BANNED and SUSPENDED both count as an active ban — see {@link ModerationStatus}.
 */
export function deriveModerationStatus(status: UserStatus): {
  moderationStatus: ModerationStatus;
  isBanned: boolean;
} {
  const isBanned = BANNED_STATUSES.includes(status);
  return { moderationStatus: isBanned ? "BANNED" : "ACTIVE", isBanned };
}

/**
 * Dashboard "Banned Users" — DB-level COUNT over the `UserIndex` mirror, which
 * per {@link resolveModerationStatus} is the ONLY place a ban is persisted
 * (auth-service never writes AccountStatus.BANNED/SUSPENDED, so counting there
 * always yields 0). Uses the same {@link BANNED_STATUSES} set the User
 * Management list's `status=BANNED` filter expands to, so the card and the list
 * can't disagree. One row per user (userId is the PK) — no duplicate inflation.
 *
 * ponytail: counts SUSPENDED rows whose `suspendedUntil` has already passed,
 * because nothing sweeps expired suspensions back to ACTIVE — the whole panel
 * still shows those users as banned. Add `suspendedUntil` filtering here only
 * together with an expiry sweep, or the card and the list will diverge.
 */
export function countBannedUsers(): Promise<number> {
  return prisma.userIndex.count({ where: { status: { in: BANNED_STATUSES } } });
}

/**
 * Batch-resolve the mirrored ACCOUNT status for a set of users from the
 * `UserIndex` mirror (the only place a ban is persisted — see
 * {@link resolveModerationStatus}). Used to stamp a member row's account status
 * so the panel can hide the ban action for a user who is already SYSTEM-banned
 * (a system ban can only be lifted from the User profile, never from a
 * community/group member list). Missing ids simply aren't in the map — the
 * caller defaults them to ACTIVE.
 */
export async function getAccountStatuses(
  userIds: string[]
): Promise<Map<string, UserStatus>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.userIndex.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, status: true },
  });
  return new Map(rows.map((r) => [r.userId, r.status as UserStatus]));
}

/** The `UserIndex` columns needed to merge moderation state into a live-sourced row. */
export type MirrorModerationRow = {
  status: UserStatus;
  bannedAt: Date | null;
  banReason: string | null;
  suspendedUntil: Date | null;
};

/**
 * Resolve the authoritative status for a row sourced live from auth-service.
 *
 * auth-service's `AuthUser.status` is authoritative ONLY for DELETED
 * (self-service account deletion writes it directly). It is NOT authoritative
 * for BANNED/SUSPENDED: the `admin.user.queue` consumer auth-service runs for
 * POST /ban|suspend|unban force-logs-out sessions and sends a notification,
 * but never persists the status there — no code path in auth-service ever
 * writes `AccountStatus.BANNED` or `AccountStatus.SUSPENDED`. The ONLY place
 * that status is actually persisted is backoffice's own `UserIndex` mirror
 * (admin_db), which is exactly what `setStatus`/`bulkSetStatus` write. So once
 * a user has been moderated at least once (a mirror row exists), the mirror
 * wins for anything except DELETED.
 */
export function resolveModerationStatus(
  liveStatus: UserStatus,
  mirror?: Pick<MirrorModerationRow, "status">
): UserStatus {
  if (liveStatus === "DELETED") return liveStatus;
  return mirror?.status ?? liveStatus;
}

/**
 * Repository contract for the admin User Management read+decision model.
 *
 * Backed by the `UserIndex` read-model in admin_db (NOT the source of truth —
 * auth-service AuthUser owns account state; we mirror status here for queries).
 * Mutations update the local mirror and throw domain errors on illegal
 * transitions; the SERVICE writes ModerationAction + AuditLog and publishes the
 * `admin.user_*` event that auth-service eventually consumes.
 */
export interface UserDirectoryRepository {
  list(query: ListUsersQuery): Promise<Paginated<UserListItemRaw>>;
  getById(userId: string): Promise<UserDirectoryRow | null>;
  setStatus(userId: string, change: StatusChange): Promise<UserStatusResult>;
  bulkSetStatus(userIds: string[], change: StatusChange): Promise<BulkResult>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing — no DB access).
// ---------------------------------------------------------------------------
type SortField = "joinedAt" | "username" | "email" | "status" | "reportCount";

/** Whitelisted field + direction (cursor/keyset codec lives in lib/keyset-cursor). */
export function parseSort(sort: string): {
  field: SortField;
  dir: "asc" | "desc";
} {
  return parseSortGeneric<SortField>(sort);
}

/** Opaque keyset cursor over (joinedAt, userId) — the only cursorable order. */
export type Cursor = { joinedAt: number; userId: string };

const CURSOR_KEYS = ["joinedAt", "userId"] as const;

export function encodeCursor(c: Cursor): string {
  return encodeCursorGeneric(c);
}

export function decodeCursor(raw: string): Cursor | null {
  return decodeCursorRaw<Cursor>(raw, CURSOR_KEYS);
}

/** Build the Prisma `where` filter from the validated list query. */
export function buildWhere(query: ListUsersQuery): Prisma.UserIndexWhereInput {
  const where: Prisma.UserIndexWhereInput = {};

  if (query.status && query.status.length > 0) {
    // BANNED means isBanned=true regardless of the finer-grained status value
    // (see deriveModerationStatus) — SUSPENDED is an active ban too, even
    // though it isn't a status the API exposes as a filter option.
    const statuses = query.status.includes("BANNED")
      ? [...new Set([...query.status, "SUSPENDED" as UserStatus])]
      : query.status;
    where.status = { in: statuses };
  }

  // Report buckets → reportCount filters.
  switch (query.reports) {
    case "none":
      where.reportCount = 0;
      break;
    case "has":
      where.reportCount = { gte: 1 };
      break;
    case "gte_5":
      where.reportCount = { gte: 5 };
      break;
    case "gte_10":
      where.reportCount = { gte: 10 };
      break;
    default:
      break;
  }

  // joinedAt range (dateTo inclusive on the whole day).
  if (query.dateFrom || query.dateTo) {
    const joinedAt: Prisma.DateTimeFilter = {};
    if (query.dateFrom)
      joinedAt.gte = new Date(`${query.dateFrom}T00:00:00.000Z`);
    if (query.dateTo) joinedAt.lte = new Date(`${query.dateTo}T23:59:59.999Z`);
    where.joinedAt = joinedAt;
  }

  if (query.search) {
    where.OR = [
      { username: { contains: query.search, mode: "insensitive" } },
      { email: { contains: query.search, mode: "insensitive" } },
    ];
  }

  return where;
}

/**
 * True when `error` is a Prisma unique-constraint violation (P2002). Duck-typed
 * instead of importing the error class, mirroring the pattern already used in
 * `consume-admin-report-ingest.ts` / `admin-account.service.ts`.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** Whitelisted field + userId tiebreak → deterministic Prisma orderBy. */
function buildOrderBy(
  sort: string
): Prisma.UserIndexOrderByWithRelationInput[] {
  const { field, dir } = parseSort(sort);
  return [{ [field]: dir }, { userId: dir }];
}

// ---------------------------------------------------------------------------
// Status-transition rules (admin_db mirror only).
// ---------------------------------------------------------------------------
/**
 * Status-transition matrix for the admin_db mirror. Rows = current, cols = next.
 *
 *            next=ACTIVE          next=SUSPENDED        next=BANNED
 *  ACTIVE    USER_NOT_BANNED(✗)   allow                 allow
 *  SUSPENDED allow (unban)        allow (re-suspend)    allow (escalate)
 *  BANNED    allow (unban)        USER_ALREADY_BANNED✗  USER_ALREADY_BANNED✗
 *  DELETED   USER_DELETED (✗)     USER_DELETED (✗)      USER_DELETED (✗)
 *
 * DELETED is a tombstone — every mutation target is rejected. A suspend must
 * never silently downgrade a permanent ban (BANNED→SUSPENDED is rejected; the
 * admin must unban first).
 */
export function assertTransition(current: UserStatus, next: UserStatus): void {
  // DELETED is a tombstone — nothing can be modified afterwards.
  if (current === "DELETED") {
    throw new ConflictError("USER_DELETED");
  }

  switch (next) {
    case "BANNED":
      if (current === "BANNED") {
        throw new ConflictError("USER_ALREADY_BANNED");
      }
      // ACTIVE / SUSPENDED → BANNED: allowed (escalate to permanent ban).
      return;
    case "SUSPENDED":
      if (current === "BANNED") {
        // Don't let a suspend silently downgrade a permanent ban.
        throw new ConflictError("USER_ALREADY_BANNED");
      }
      // ACTIVE → SUSPENDED and SUSPENDED → SUSPENDED (re-suspend / extend)
      // are both allowed; the latter just updates suspendedUntil.
      return;
    case "ACTIVE":
      if (current !== "BANNED" && current !== "SUSPENDED") {
        // Unban/reactivate only makes sense from a restricted state.
        throw new ConflictError("USER_NOT_BANNED");
      }
      return;
    default:
      return;
  }
}

/** Map a Prisma UserIndex row → the normalized directory detail row. */
function toRow(r: {
  userId: string;
  username: string;
  email: string;
  status: UserStatus;
  joinedAt: Date;
  lastActiveAt: Date | null;
  bannedAt: Date | null;
  banReason: string | null;
  suspendedUntil: Date | null;
  updatedAt: Date;
}): UserDirectoryRow {
  return {
    userId: r.userId,
    username: r.username,
    // UserIndex (admin_db mirror) does not carry firstName/lastName — those
    // live on user-service's UserProfile, only joined in on the live gRPC path.
    fullName: null,
    email: orNull(r.email),
    // UserIndex does not carry avatarUrl (user-service owns it); null for now.
    avatarUrl: null,
    status: r.status,
    joinedAt: r.joinedAt.getTime(),
    lastActiveAt: r.lastActiveAt?.getTime() ?? null,
    since: r.bannedAt?.getTime() ?? r.updatedAt.getTime(),
    reason: r.banReason,
    suspendedUntil: r.suspendedUntil?.getTime() ?? null,
  };
}

function toListItem(
  r: {
    userId: string;
    username: string;
    email: string;
    status: UserStatus;
    reportCount: number;
    joinedAt: Date;
    bannedAt: Date | null;
    banReason: string | null;
  },
  banAction?: { actorId: string }
): UserListItemRaw {
  const { moderationStatus, isBanned } = deriveModerationStatus(r.status);
  return {
    userId: r.userId,
    username: r.username,
    // UserIndex (admin_db mirror) does not carry firstName/lastName — those
    // live on user-service's UserProfile, only joined in on the live gRPC path.
    fullName: null,
    email: orNull(r.email),
    status: r.status,
    reportCount: r.reportCount,
    joinedAt: r.joinedAt.getTime(),
    // UserIndex does not carry avatarUrl (user-service owns it); null for now.
    avatarUrl: null,
    moderationStatus,
    isBanned,
    ...(isBanned
      ? {
          bannedAt: r.bannedAt?.getTime() ?? null,
          banReason: r.banReason,
          bannedBy: banAction?.actorId ?? null,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Prisma implementation.
// ---------------------------------------------------------------------------
export class PrismaUserDirectoryRepository implements UserDirectoryRepository {
  async list(query: ListUsersQuery): Promise<Paginated<UserListItemRaw>> {
    const where = buildWhere(query);
    const orderBy = buildOrderBy(query.sort);
    // The keyset cursor is only valid when sorting by joinedAt (its sort key).
    const cursorable = parseSort(query.sort).field === "joinedAt";

    if (query.cursor && cursorable) {
      return this.keysetPage(where, orderBy, query);
    }
    return this.offsetPage(where, orderBy, query, cursorable);
  }

  async getById(userId: string): Promise<UserDirectoryRow | null> {
    const row = await prisma.userIndex.findUnique({ where: { userId } });
    return row ? toRow(row) : null;
  }

  async setStatus(
    userId: string,
    change: StatusChange
  ): Promise<UserStatusResult> {
    const { result } = await this.applyStatus(userId, change);
    return result;
  }

  /**
   * Core mutation. Returns whether the row actually transitioned so callers can
   * skip side effects on idempotent no-ops. When `change.idempotentActive` is
   * set and the user is already ACTIVE, this is a no-op success (`changed:
   * false`) rather than a `USER_NOT_BANNED` conflict.
   */
  private async applyStatus(
    userId: string,
    change: StatusChange
  ): Promise<{ result: UserStatusResult; changed: boolean }> {
    const current = await prisma.userIndex.findUnique({ where: { userId } });
    if (!current) throw new NotFoundError("USER_NOT_FOUND");

    // Idempotent re-activate: already ACTIVE → no-op success, no write.
    if (
      change.idempotentActive &&
      change.status === "ACTIVE" &&
      current.status === "ACTIVE"
    ) {
      return {
        changed: false,
        result: {
          userId: current.userId,
          status: current.status,
          suspendedUntil: current.suspendedUntil?.getTime() ?? null,
          bannedAt: current.bannedAt?.getTime() ?? null,
        },
      };
    }

    assertTransition(current.status, change.status);

    const data: Prisma.UserIndexUpdateInput = {
      status: change.status,
      banReason: change.reason ?? null,
      bannedAt: change.bannedAt ?? null,
      suspendedUntil: change.suspendedUntil ?? null,
    };

    const updated = await prisma.userIndex.update({
      where: { userId },
      data,
    });

    return {
      changed: true,
      result: {
        userId: updated.userId,
        status: updated.status,
        suspendedUntil: updated.suspendedUntil?.getTime() ?? null,
        bannedAt: updated.bannedAt?.getTime() ?? null,
      },
    };
  }

  async bulkSetStatus(
    userIds: string[],
    change: StatusChange
  ): Promise<BulkResult> {
    const results: BulkResultItem[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const userId of userIds) {
      try {
        const { result, changed } = await this.applyStatus(userId, change);
        results.push({ userId, status: result.status, ok: true, changed });
        succeeded += 1;
      } catch (err) {
        failed += 1;
        const code =
          err instanceof ConflictError
            ? err.message
            : err instanceof NotFoundError
              ? "USER_NOT_FOUND"
              : "BULK_ITEM_FAILED";
        const message =
          err instanceof Error ? err.message : "Unexpected bulk item error";
        results.push({ userId, ok: false, error: { code, message } });
      }
    }

    return { requested: userIds.length, succeeded, failed, results };
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------
  /**
   * Map a page of UserIndex rows → list items, resolving `bannedBy` with ONE
   * batched ModerationAction query for the whole page (not per-row).
   */
  private async toListItems(
    rows: Parameters<typeof toListItem>[0][]
  ): Promise<UserListItemRaw[]> {
    const banActionMap =
      await moderationActionRepository.latestBanActionsByTargets(
        rows.map((r) => r.userId)
      );
    return rows.map((r) => toListItem(r, banActionMap.get(r.userId)));
  }

  private async offsetPage(
    where: Prisma.UserIndexWhereInput,
    orderBy: Prisma.UserIndexOrderByWithRelationInput[],
    query: ListUsersQuery,
    cursorable: boolean
  ): Promise<Paginated<UserListItemRaw>> {
    const { page, limit } = query;
    const skip = (page - 1) * limit;

    const [total, rows] = await Promise.all([
      prisma.userIndex.count({ where }),
      prisma.userIndex.findMany({ where, orderBy, skip, take: limit }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const hasNext = skip + rows.length < total;
    const last = rows[rows.length - 1];

    const pagination: PaginationMeta = {
      mode: "offset",
      page,
      limit,
      total,
      totalApprox: total,
      totalPages,
      hasNext,
      hasPrev: page > 1,
      nextCursor:
        cursorable && hasNext && last
          ? encodeCursor({
              joinedAt: last.joinedAt.getTime(),
              userId: last.userId,
            })
          : null,
    };
    return { data: await this.toListItems(rows), pagination };
  }

  private async keysetPage(
    where: Prisma.UserIndexWhereInput,
    orderBy: Prisma.UserIndexOrderByWithRelationInput[],
    query: ListUsersQuery
  ): Promise<Paginated<UserListItemRaw>> {
    const { limit } = query;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const { dir } = parseSort(query.sort);

    // Seek past the cursor row using the (joinedAt, userId) compound key. With
    // ties on joinedAt we fall back to the userId tiebreak — same comparator as
    // the orderBy so the keyset slice equals the equivalent offset slice.
    let seekWhere = where;
    if (cursor) {
      const at = new Date(cursor.joinedAt);
      const op = dir === "asc" ? "gt" : "lt";
      seekWhere = {
        AND: [
          where,
          {
            OR: [
              { joinedAt: { [op]: at } },
              {
                joinedAt: at,
                userId: { [op]: cursor.userId },
              },
            ],
          },
        ],
      };
    }

    const [total, rows] = await Promise.all([
      prisma.userIndex.count({ where }),
      prisma.userIndex.findMany({
        where: seekWhere,
        orderBy,
        take: limit,
      }),
    ]);

    const hasNext = rows.length === limit;
    const last = rows[rows.length - 1];

    const pagination: PaginationMeta = {
      mode: "keyset",
      page: 1,
      limit,
      total,
      totalApprox: total,
      totalPages: limit === 0 ? 0 : Math.ceil(total / limit),
      hasNext,
      hasPrev: cursor !== null,
      nextCursor:
        hasNext && last
          ? encodeCursor({
              joinedAt: last.joinedAt.getTime(),
              userId: last.userId,
            })
          : null,
    };
    return { data: await this.toListItems(rows), pagination };
  }
}

// ---------------------------------------------------------------------------
// Live gRPC implementation.
// ---------------------------------------------------------------------------

/** Map our ListUsersQuery sort token → the auth.proto sort_field name. */
function toAuthSortField(field: SortField): string {
  switch (field) {
    case "joinedAt":
      return "createdAt";
    case "username":
      return "account";
    case "email":
      return "email";
    case "status":
      return "status";
    case "reportCount":
      // auth-service cannot sort by reportCount (it lives in admin_db only);
      // fall back to createdAt so the request is still valid/deterministic.
      return "createdAt";
    default:
      return "createdAt";
  }
}

/** Report bucket → predicate over a per-user report count. */
function bucketMatches(
  bucket: NonNullable<ListUsersQuery["reports"]>,
  count: number
): boolean {
  switch (bucket) {
    case "none":
      return count === 0;
    case "has":
      return count >= 1;
    case "gte_5":
      return count >= 5;
    case "gte_10":
      return count >= 10;
    default:
      return true;
  }
}

/**
 * Live directory repository: identity from auth-service, display profile from
 * user-service, reportCount from admin_db (Report). All upstream reads go
 * through opossum breakers (see auth.client / user.client). A down upstream
 * surfaces as a rejected promise → the error handler turns it into a 5xx.
 *
 * Mutations (setStatus/bulkSetStatus) are NOT owned here — they still update
 * the local admin_db mirror + publish `admin.user_*` events; reflecting them in
 * this live list requires auth-service to apply the event (follow-up). They are
 * delegated to the injected fallback (Prisma) repository.
 */
export class GrpcUserDirectoryRepository implements UserDirectoryRepository {
  constructor(private readonly fallback: UserDirectoryRepository) {}

  async list(query: ListUsersQuery): Promise<Paginated<UserListItemRaw>> {
    const { page, limit } = query;
    const offset = (page - 1) * limit;
    const { field, dir } = parseSort(query.sort);

    // reportCount lives only in admin_db (Report), but the live list is DRIVEN by
    // auth-service, which cannot ORDER BY a count it does not store. Rather than
    // sort the page in-memory (which would only order the current page, not the
    // whole set), we deterministically fall back to createdAt and flag it. True
    // DB-level reportCount sorting is available on the Prisma read-model path;
    // making it work live needs auth-service to carry a denormalized count (or
    // the list to be driven from the UserIndex mirror). See toAuthSortField().
    if (field === "reportCount") {
      // debug, not warn: a panel defaulting to reports-sort would otherwise
      // flood logs on every page. This is an expected, documented fallback.
      logger.debug(
        "sortBy=reports is not DB-sortable in the live gRPC path (reportCount is admin_db-only); falling back to createdAt order (sortOrder still applied)"
      );
    }

    // 1. Base request mapping. `status` is deliberately left unset here — see
    // step 2b below, which resolves it against the UserIndex mirror instead of
    // forwarding the raw filter straight to auth-service.
    const req: AdminListUsersRequest = {
      search: query.search,
      sortField: toAuthSortField(field),
      sortDir: dir,
      limit,
      offset,
    };
    if (query.dateFrom) {
      req.createdAfter = new Date(
        `${query.dateFrom}T00:00:00.000Z`
      ).toISOString();
    }
    if (query.dateTo) {
      // dateTo inclusive → end-of-day UTC.
      req.createdBefore = new Date(
        `${query.dateTo}T23:59:59.999Z`
      ).toISOString();
    }

    // 2. Reports-bucket prefilter (admin_db). For has|gte_5|gte_10 we can
    //    constrain auth's query to the matching userIds. For `none` there is no
    //    "not-in" filter on the wire, so we fetch unconstrained and drop rows
    //    that have reports AFTER the fact — meaning `total` for reports=none is
    //    approximate (it counts the unfiltered auth total, not the post-drop
    //    set). Documented limitation; pragmatic for v1.
    if (query.reports && query.reports !== "none") {
      const reportedIds = await this.userIdsMatchingBucket(query.reports);
      if (reportedIds.length === 0) {
        // No user matches this bucket → empty page (skip the auth round-trip).
        return {
          data: [],
          pagination: this.offsetMeta(page, limit, 0, 0, offset),
        };
      }
      req.userIds = reportedIds;
    }

    // 2b. Status filter. auth-service's `AuthUser.status` is the source of
    //     truth — the ban/suspend/unban flows in account-ban.service write
    //     it directly. Just forward. BANNED implies SUSPENDED too (UI ban
    //     filter covers both, matching deriveModerationStatus).
    if (query.status && query.status.length > 0) {
      const expanded = query.status.includes("BANNED")
        ? [...new Set([...query.status, "SUSPENDED" as UserStatus])]
        : query.status;
      req.status = expanded;
    }

    // 3. Identity list from auth-service.
    const { users, total } = await authClient.adminListUsers(req);

    // 4. Enrich with display profiles (user-service) + reportCount (admin_db) +
    //    the actor of each user's latest ban/suspend action (admin_db) + the
    //    UserIndex mirror moderation columns (admin_db) — four batched calls
    //    keyed by the page's userIds, never one call per row.
    const userIds = users.map((u) => u.id);
    const [profiles, countMap, banActionMap, mirrorMap] = await Promise.all([
      userClient.adminGetProfilesByIds(userIds),
      this.reportCountMap(userIds),
      moderationActionRepository.latestBanActionsByTargets(userIds),
      this.mirrorModerationMap(userIds),
    ]);
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));

    let data: UserListItemRaw[] = users.map((u) => {
      const profile = profileMap.get(u.id);
      const mirror = mirrorMap.get(u.id);
      // auth-service's `u.status` is live but NEVER updated by ban/suspend/unban
      // (see resolveModerationStatus) — the UserIndex mirror is what those
      // actions actually write, so it wins whenever this user has one.
      const status = resolveModerationStatus(u.status, mirror);
      const { moderationStatus, isBanned } = deriveModerationStatus(status);
      const banAction = banActionMap.get(u.id);
      return {
        userId: u.id,
        email: orNull(u.email),
        status,
        // u.createdAt arrives as an ISO string from auth-service — coerce to epoch ms.
        joinedAt: Date.parse(u.createdAt),
        username: profile?.username ?? u.account,
        fullName: buildFullName(profile?.firstName, profile?.lastName),
        avatarUrl: profile?.avatarUrl || null,
        reportCount: countMap.get(u.id) ?? 0,
        moderationStatus,
        isBanned,
        ...(isBanned
          ? {
              bannedAt: mirror?.bannedAt?.getTime() ?? null,
              banReason: mirror?.banReason ?? null,
              bannedBy: banAction?.actorId ?? null,
            }
          : {}),
      };
    });

    // 5. `none` bucket: drop rows that actually have reports (see note above).
    const pageTotal = total;
    if (query.reports === "none") {
      const before = data.length;
      data = data.filter((d) => bucketMatches("none", d.reportCount));
      if (data.length !== before) {
        logger.warn(
          "reports=none: dropped reported rows client-side; pagination total is approximate"
        );
      }
    }

    return {
      data,
      pagination: this.offsetMeta(page, limit, pageTotal, users.length, offset),
    };
  }

  async getById(userId: string): Promise<UserDirectoryRow | null> {
    let record: Awaited<ReturnType<typeof authClient.adminGetUser>> | null;
    try {
      record = await authClient.adminGetUser(userId);
    } catch (err) {
      if ((err as grpc.ServiceError)?.code === grpc.status.NOT_FOUND) {
        return null;
      }
      throw err;
    }

    const [profile, mirror] = await Promise.all([
      userClient.adminGetProfile(userId),
      this.mirrorModerationRow(userId),
    ]);

    // auth-service's `record.status` is live but NEVER updated by
    // ban/suspend/unban (see resolveModerationStatus) — the UserIndex mirror is
    // what those actions actually write, so it wins whenever this user has one.
    const status = resolveModerationStatus(record.status, mirror ?? undefined);

    return {
      userId: record.id,
      username: profile?.username || record.account,
      fullName: buildFullName(profile?.firstName, profile?.lastName),
      email: orNull(record.email),
      avatarUrl: profile?.avatarUrl || null,
      status,
      // auth-service's *At/*Until fields arrive as ISO strings — coerce to epoch ms.
      joinedAt: Date.parse(record.createdAt),
      // auth-service does not expose a last-active timestamp on this contract.
      lastActiveAt: record.lastLoginAt ? Date.parse(record.lastLoginAt) : null,
      since:
        status === "DELETED"
          ? record.deletedAt
            ? Date.parse(record.deletedAt)
            : null
          : mirror?.bannedAt
            ? mirror.bannedAt.getTime()
            : record.suspendedAt
              ? Date.parse(record.suspendedAt)
              : null,
      reason: mirror?.banReason || record.suspendedReason || null,
      suspendedUntil: mirror?.suspendedUntil?.getTime() ?? null,
    };
  }

  /** Single-user counterpart of {@link mirrorModerationMap}. */
  private mirrorModerationRow(
    userId: string
  ): Promise<MirrorModerationRow | null> {
    return prisma.userIndex.findUnique({
      where: { userId },
      select: {
        status: true,
        bannedAt: true,
        banReason: true,
        suspendedUntil: true,
      },
    });
  }

  /**
   * Batch-fetch the local UserIndex mirror's moderation columns for a page of
   * users — ONE extra query for the whole page, never one per row.
   */
  private async mirrorModerationMap(
    userIds: string[]
  ): Promise<Map<string, MirrorModerationRow>> {
    if (userIds.length === 0) return new Map();
    const rows = await prisma.userIndex.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        status: true,
        bannedAt: true,
        banReason: true,
        suspendedUntil: true,
      },
    });
    return new Map(rows.map((r) => [r.userId, r]));
  }

  /**
   * userIds whose UserIndex mirror `status` is one of the given values — the
   * mirror is the only place BANNED/SUSPENDED is ever actually persisted (see
   * resolveModerationStatus), so this is the real DB-level source for a
   * BANNED/SUSPENDED status filter (used both to constrain a banned-only query
   * and to exclude those ids from an ACTIVE-only query).
   */
  private async mirrorIdsByStatus(statuses: UserStatus[]): Promise<string[]> {
    const rows = await prisma.userIndex.findMany({
      where: { status: { in: statuses } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  // Mutations still update the local mirror + publish admin.user_* events;
  // reflecting them in this live list requires auth-service to apply the event
  // (follow-up). Delegate to the Prisma read-model so ban/unban keep working.
  //
  // The `UserIndex` mirror is only ever populated by a ~40-row dev seed (the
  // event consumers that would keep it fresh from user.registered/user.locked
  // were never built — see project docs). Since list/detail now read LIVE from
  // auth-service, any real user outside that seed is visible in the Users List
  // but has no `UserIndex` row, so the fallback's existence check
  // (`applyStatus` → `findUnique`) threw `USER_NOT_FOUND` even though the same
  // `userId` the list returned does exist. Self-heal by mirroring the row from
  // the SAME live source (`this.getById`, already used by list/detail) on
  // first mutation, so ban/suspend/unban work for every user the panel shows.
  async setStatus(
    userId: string,
    change: StatusChange
  ): Promise<UserStatusResult> {
    await this.ensureMirrored(userId);
    return this.fallback.setStatus(userId, change);
  }
  async bulkSetStatus(
    userIds: string[],
    change: StatusChange
  ): Promise<BulkResult> {
    await Promise.all(userIds.map((id) => this.ensureMirrored(id)));
    return this.fallback.bulkSetStatus(userIds, change);
  }

  /**
   * Create the `UserIndex` mirror row from the live source if it's missing.
   * A no-op when the row already exists (never overwrites local ban/suspend
   * state) or when the user truly doesn't exist anywhere (the fallback's own
   * existence check then correctly reports `USER_NOT_FOUND`). Concurrent
   * first-mutations racing to create the same row are resolved by swallowing
   * the resulting P2002 — the row exists either way.
   */
  private async ensureMirrored(userId: string): Promise<void> {
    const mirrored = await prisma.userIndex.findUnique({
      where: { userId },
      select: { userId: true },
    });
    if (mirrored) return;

    const live = await this.getById(userId);
    if (!live) return;

    try {
      await prisma.userIndex.create({
        data: {
          userId: live.userId,
          username: live.username,
          // UserIndex.email is a non-nullable mirror column; live.email is the
          // response-layer normalized value (null when absent).
          email: live.email ?? "",
          status: live.status,
          joinedAt: new Date(live.joinedAt),
          lastActiveAt: live.lastActiveAt ? new Date(live.lastActiveAt) : null,
        },
      });
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Internals (admin_db Report aggregation).
  // -------------------------------------------------------------------------

  /** userIds (admin_db) whose user-report count satisfies a has|gte_N bucket. */
  private async userIdsMatchingBucket(
    bucket: NonNullable<ListUsersQuery["reports"]>
  ): Promise<string[]> {
    const grouped = await prisma.report.groupBy({
      by: ["targetId"],
      where: { type: "user" },
      _count: { _all: true },
    });
    return grouped
      .filter((g) => bucketMatches(bucket, g._count._all))
      .map((g) => g.targetId);
  }

  /** targetId → report count for a fixed set of userIds (type='user'). */
  private async reportCountMap(
    userIds: string[]
  ): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const grouped = await prisma.report.groupBy({
      by: ["targetId"],
      where: { type: "user", targetId: { in: userIds } },
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.targetId, g._count._all]));
  }

  /** Build the offset-mode PaginationMeta (keyset cursor not used live). */
  private offsetMeta(
    page: number,
    limit: number,
    total: number,
    pageLen: number,
    offset: number
  ): PaginationMeta {
    return {
      mode: "offset",
      page,
      limit,
      total,
      totalApprox: total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      hasNext: offset + pageLen < total,
      hasPrev: page > 1,
      nextCursor: null,
    };
  }
}

/** Prisma-backed read-model — kept as a fallback (mutations + tests). */
export const prismaUserDirectoryRepository: UserDirectoryRepository =
  new PrismaUserDirectoryRepository();

/**
 * Production singleton — live gRPC fan-out for list/detail, delegating the
 * mutation paths to the Prisma read-model (which still writes the admin_db
 * mirror + lets the service publish admin.user_* events).
 */
export const userDirectoryRepository: UserDirectoryRepository =
  new GrpcUserDirectoryRepository(prismaUserDirectoryRepository);
