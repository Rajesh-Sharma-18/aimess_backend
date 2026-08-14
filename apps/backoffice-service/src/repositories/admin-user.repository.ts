import { prisma } from "../config/prisma.js";
import { ROLE_KEYS } from "../constants/index.js";
import type {
  AdminStatus,
  Prisma,
  RoleKey,
} from "../generated/prisma/client.js";
import type { ListAdminAccountsQuery } from "../types/admin-account.types.js";

/** Whitelisted sort columns for the list endpoint (validator enforces the shape). */
type AdminAccountSortField =
  | "name"
  | "email"
  | "createdAt"
  | "lastLoginAt"
  | "status";

function parseAdminAccountSort(sort: string): {
  field: AdminAccountSortField;
  dir: "asc" | "desc";
} {
  const [field, dir] = sort.split(":") as [
    AdminAccountSortField,
    "asc" | "desc",
  ];
  return { field, dir };
}

export const adminUserRepository = {
  /** Lookup for login — includes the role (key needed for JWT claims). */
  findByEmail(email: string) {
    return prisma.adminUser.findUnique({
      where: { email },
      include: { role: true },
    });
  },

  findById(id: string) {
    return prisma.adminUser.findUnique({
      where: { id },
      include: { role: true },
    });
  },

  /** Case-insensitive username (`name`) lookup for the uniqueness check. */
  findByName(name: string) {
    return prisma.adminUser.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      include: { role: true },
    });
  },

  /**
   * Count of ACTIVE admins whose EFFECTIVE set contains `permissionKey` — the
   * same rule as `rbacRepository.getPermissionKeysForAdmin`, expressed as one
   * query: the role grants it and no deny-override takes it away, OR an
   * allow-override grants it regardless of role. `excludeAdminId` drops the
   * admin being changed so the count reflects the state AFTER the change.
   * Backs the "last admins.manage holder" lockout guards.
   */
  countActiveWithPermission(permissionKey: string, excludeAdminId?: string) {
    return prisma.adminUser.count({
      where: {
        status: "ACTIVE",
        ...(excludeAdminId ? { id: { not: excludeAdminId } } : {}),
        OR: [
          {
            role: {
              permissions: { some: { permission: { key: permissionKey } } },
            },
            permissionOverrides: {
              none: { permission: { key: permissionKey }, allow: false },
            },
          },
          {
            permissionOverrides: {
              some: { permission: { key: permissionKey }, allow: true },
            },
          },
        ],
      },
    });
  },

  updateLastLogin(id: string) {
    return prisma.adminUser.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  },

  updatePasswordHash(id: string, passwordHash: string) {
    return prisma.adminUser.update({
      where: { id },
      data: { passwordHash },
    });
  },

  createAdmin(input: {
    email: string;
    passwordHash: string;
    name: string;
    roleId: string;
    status?: AdminStatus;
  }) {
    return prisma.adminUser.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        name: input.name,
        roleId: input.roleId,
        status: input.status,
      },
      include: { role: true },
    });
  },

  setStatus(id: string, status: AdminStatus) {
    return prisma.adminUser.update({
      where: { id },
      data: { status },
    });
  },

  updateRole(id: string, roleId: string) {
    return prisma.adminUser.update({
      where: { id },
      data: { roleId },
      include: { role: true },
    });
  },

  updateProfile(
    id: string,
    input: {
      name?: string;
      email?: string;
      // `null` clears the avatar (self-service PATCH /me flow).
      avatarUrl?: string | null;
      // Preferred UI language; undefined leaves the stored value untouched.
      language?: string;
    }
  ) {
    return prisma.adminUser.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.avatarUrl !== undefined
          ? { avatarUrl: input.avatarUrl }
          : {}),
        ...(input.language !== undefined ? { language: input.language } : {}),
      },
      include: { role: true },
    });
  },

  /** Used by the seed to find a role id by its key. */
  findRoleByKey(key: RoleKey) {
    return prisma.adminRole.findUnique({ where: { key } });
  },

  /** Batch id→name lookup (moderator-stamp enrichment). Empty input → no query. */
  async findNamesByIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await prisma.adminUser.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  },

  /**
   * Paginated + filtered admin list (newest first by default). `excludeAdminId`
   * drops the caller's own row and `excludeSuperAdmins` drops every SUPER_ADMIN
   * row — filtering in the query (not after) keeps `total`/`totalPages` honest.
   * Both go through `AND` so the roleKey/search filters below can't override them.
   */
  async list(
    query: ListAdminAccountsQuery,
    opts: { excludeAdminId?: string; excludeSuperAdmins?: boolean } = {}
  ) {
    const { field, dir } = parseAdminAccountSort(query.sort);
    const where: Prisma.AdminUserWhereInput = {};
    const and: Prisma.AdminUserWhereInput[] = [];

    if (opts.excludeAdminId) {
      and.push({ id: { not: opts.excludeAdminId } });
    }
    if (opts.excludeSuperAdmins) {
      and.push({ role: { key: { not: ROLE_KEYS.SUPER_ADMIN } } });
    }
    if (and.length > 0) {
      where.AND = and;
    }
    if (query.status && query.status !== "all") {
      where.status = query.status;
    }
    if (query.roleKey && query.roleKey !== "all") {
      where.role = { key: query.roleKey as RoleKey };
    }
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: "insensitive" } },
        { email: { contains: query.search, mode: "insensitive" } },
      ];
    }
    if (query.fromDate || query.toDate) {
      where.createdAt = {
        ...(query.fromDate ? { gte: new Date(query.fromDate) } : {}),
        ...(query.toDate ? { lte: new Date(query.toDate) } : {}),
      };
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
      prisma.adminUser.findMany({
        where,
        // Tiebreak on id so pages are deterministic when two rows share a sort key.
        orderBy: [{ [field]: dir }, { id: "desc" }],
        skip,
        take: query.limit,
        include: { role: true },
      }),
      prisma.adminUser.count({ where }),
    ]);

    return { rows, total };
  },
};
