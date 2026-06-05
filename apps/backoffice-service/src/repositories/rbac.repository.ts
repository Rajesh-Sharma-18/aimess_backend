import { prisma } from "../config/prisma.js";
import type { RoleKey } from "../generated/prisma/client.js";

export const rbacRepository = {
  /** Resolve the permission keys granted to a role (by role key). */
  async getPermissionKeysForRole(roleKey: RoleKey): Promise<string[]> {
    const role = await prisma.adminRole.findUnique({
      where: { key: roleKey },
      select: {
        permissions: { select: { permission: { select: { key: true } } } },
      },
    });
    if (!role) return [];
    return role.permissions.map((rp) => rp.permission.key);
  },

  listRoles() {
    return prisma.adminRole.findMany({
      orderBy: { key: "asc" },
      include: {
        permissions: { select: { permission: { select: { key: true } } } },
      },
    });
  },

  listPermissions() {
    return prisma.permission.findMany({ orderBy: { key: "asc" } });
  },
};
