import { prisma } from "../config/prisma.js";
import {
  AccountStatus,
  Prisma,
  type AuthUser,
  type DeviceType,
} from "../generated/prisma/client.js";

/**
 * Read-only user list/detail queries for the Admin Panel (served live over
 * gRPC). Filtering/sorting/pagination mirror the backoffice user-management UI.
 */

/** Admin-facing status filter values exposed over the wire. */
type AdminStatusFilter = "ACTIVE" | "SUSPENDED" | "BANNED" | "DELETED";

const SORT_FIELDS = ["createdAt", "email", "account", "status"] as const;
type SortField = (typeof SORT_FIELDS)[number];

export interface AdminListUsersParams {
  search: string;
  status: string[];
  createdAfter: string;
  createdBefore: string;
  sortField: string;
  sortDir: string;
  limit: number;
  offset: number;
  userIds: string[];
  excludeUserIds: string[];
}

/**
 * Map one admin status filter to a Prisma `where` fragment. Multiple filters
 * are OR-ed together by the caller.
 *   ACTIVE    → live, non-deleted accounts
 *   SUSPENDED → ops-suspended accounts
 *   BANNED    → permanently banned accounts
 *   DELETED   → tombstoned, grace-period, or soft-deleted accounts
 */
function statusFilterToWhere(
  status: AdminStatusFilter
): Prisma.AuthUserWhereInput {
  switch (status) {
    case "ACTIVE":
      return { status: AccountStatus.ACTIVE, deletedAt: null };
    case "SUSPENDED":
      return { status: AccountStatus.SUSPENDED };
    case "BANNED":
      return { status: AccountStatus.BANNED };
    case "DELETED":
      return {
        OR: [
          { status: AccountStatus.DELETED },
          { status: AccountStatus.PENDING_DELETION },
          { deletedAt: { not: null } },
        ],
      };
  }
}

export const adminUsersRepository = {
  /**
   * Filterable, sortable, offset-paginated user list. Returns the page plus the
   * total count matching the same filter (for pagination).
   */
  /**
   * Distinct users holding at least one NON-REVOKED session whose deviceType is
   * in `deviceTypes` (empty = any type). This is the audience resolver behind
   * device-targeted announcements: "send to iOS" means the people who are
   * signed in on iOS right now, which is exactly what GET /auth/sessions shows
   * the user themselves.
   *
   * Ordered by userId (not by recency) so offset paging over a live table stays
   * stable — a session touched mid-fan-out must not shuffle users between pages
   * and cause one to be skipped.
   */
  async adminListUserIdsByDeviceType(params: {
    deviceTypes: string[];
    limit: number;
    offset: number;
  }): Promise<{ userIds: string[]; total: number }> {
    const valid = params.deviceTypes.filter((t): t is DeviceType =>
      ["ANDROID", "IOS", "WEB", "DESKTOP"].includes(t)
    );
    const where: Prisma.SessionWhereInput = {
      revokedAt: null,
      ...(valid.length > 0 ? { deviceType: { in: valid } } : {}),
    };

    const limit = Math.min(Math.max(params.limit || 100, 1), 500);
    const offset = Math.max(params.offset || 0, 0);

    const [rows, grouped] = await Promise.all([
      prisma.session.findMany({
        where,
        select: { userId: true },
        distinct: ["userId"],
        orderBy: { userId: "asc" },
        skip: offset,
        take: limit,
      }),
      prisma.session.groupBy({ by: ["userId"], where }),
    ]);

    return { userIds: rows.map((r) => r.userId), total: grouped.length };
  },

  async adminListUsers(
    params: AdminListUsersParams
  ): Promise<{ users: AuthUser[]; total: number }> {
    const and: Prisma.AuthUserWhereInput[] = [];

    // search: case-insensitive contains over email + account.
    const search = params.search.trim();
    if (search) {
      and.push({
        OR: [
          { email: { contains: search, mode: "insensitive" } },
          { account: { contains: search, mode: "insensitive" } },
        ],
      });
    }

    // status: OR the per-status fragments for the recognised values.
    const statusFragments = params.status
      .filter((s): s is AdminStatusFilter =>
        ["ACTIVE", "SUSPENDED", "BANNED", "DELETED"].includes(s)
      )
      .map(statusFilterToWhere);
    if (statusFragments.length > 0) {
      and.push({ OR: statusFragments });
    }

    // createdAfter / createdBefore → createdAt range (inclusive, ignore empty).
    const createdAt: Prisma.DateTimeFilter = {};
    const after = parseIso(params.createdAfter);
    const before = parseIso(params.createdBefore);
    if (after) createdAt.gte = after;
    if (before) createdAt.lte = before;
    if (createdAt.gte || createdAt.lte) {
      and.push({ createdAt });
    }

    // user_ids: when non-empty, constrain to these ids. `AuthUser.id` is a
    // `@db.Uuid` column — a non-UUID-shaped value (e.g. the backoffice
    // UserIndex mirror's dev-seed ids like "u_seed_29"; that table has no
    // cross-DB FK to this one, so nothing guarantees its ids stay valid
    // UUIDs) makes Postgres throw `invalid input syntax for type uuid`
    // instead of just matching zero rows. Filtering to well-formed UUIDs
    // first is behavior-preserving: a malformed id could never have matched
    // a real row anyway, so dropping it changes nothing about which rows
    // `in`/`notIn` select — it only avoids handing Postgres a value it can't
    // even parse as the column's type.
    const userIds = params.userIds.filter(isUuid);
    const excludeUserIds = params.excludeUserIds.filter(isUuid);

    if (userIds.length > 0) {
      and.push({ id: { in: userIds } });
    }

    // exclude_user_ids: when non-empty, drop these ids (used by the backoffice
    // status=ACTIVE filter to exclude users the UserIndex mirror has banned —
    // this table's own `status` column is never flipped to BANNED/SUSPENDED by
    // the admin ban/suspend flows, so it can't express that exclusion itself).
    if (excludeUserIds.length > 0) {
      and.push({ id: { notIn: excludeUserIds } });
    }

    const where: Prisma.AuthUserWhereInput = and.length > 0 ? { AND: and } : {};

    // sort: whitelist field, default createdAt; dir asc/desc, default desc.
    // Always tiebreak on id for stable pagination.
    const sortField: SortField = SORT_FIELDS.includes(
      params.sortField as SortField
    )
      ? (params.sortField as SortField)
      : "createdAt";
    const sortDir: Prisma.SortOrder = params.sortDir === "asc" ? "asc" : "desc";

    const orderBy: Prisma.AuthUserOrderByWithRelationInput[] = [
      { [sortField]: sortDir },
      { id: sortDir },
    ];

    // clamp limit 1..100 (default 20), offset >= 0.
    const take = clamp(
      Number.isFinite(params.limit) && params.limit ? params.limit : 20,
      1,
      100
    );
    const skip = Math.max(0, params.offset || 0);

    const [users, total] = await Promise.all([
      prisma.authUser.findMany({ where, orderBy, skip, take }),
      prisma.authUser.count({ where }),
    ]);

    return { users, total };
  },

  /** Single user by id, or null when not found. */
  async adminGetUser(userId: string): Promise<AuthUser | null> {
    return prisma.authUser.findUnique({ where: { id: userId } });
  },
};

/** RFC-4122-shaped UUID (any version/variant) — matches Postgres' own `uuid` input check. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is well-formed enough for `AuthUser.id` (a `@db.Uuid` column). */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Parse an ISO datetime string; returns undefined for empty/invalid input. */
function parseIso(value: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
