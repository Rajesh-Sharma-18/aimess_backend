import { prisma } from "../config/prisma.js";
import {
  AccountStatus,
  Prisma,
  type AuthUser,
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

    // user_ids: when non-empty, constrain to these ids.
    if (params.userIds.length > 0) {
      and.push({ id: { in: params.userIds } });
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

/** Parse an ISO datetime string; returns undefined for empty/invalid input. */
function parseIso(value: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
