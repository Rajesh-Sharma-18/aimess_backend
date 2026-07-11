import { prisma } from "../config/prisma.js";
import type {
  AdminStatus,
  Prisma,
  RoleKey,
} from "../generated/prisma/client.js";
import type { ListAdminAccountsQuery } from "../types/admin-account.types.js";

/** Whitelisted sort columns for the list endpoint (validator enforces the shape). */
type AdminAccountSortField = "name" | "email" | "createdAt" | "lastLoginAt";

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

  /** Paginated + filtered admin list (newest first by default). */
  async list(query: ListAdminAccountsQuery) {
    const { field, dir } = parseAdminAccountSort(query.sort);
    const where: Prisma.AdminUserWhereInput = {};

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
