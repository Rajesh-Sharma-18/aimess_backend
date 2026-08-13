import { prisma } from "../config/prisma.js";
import type { RoleKey } from "../generated/prisma/client.js";
import { withImpliedReads } from "../lib/implied-reads.js";

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
    return withImpliedReads(role.permissions.map((rp) => rp.permission.key));
  },

  /**
   * Resolve one admin's EFFECTIVE permission keys: the role baseline plus the
   * per-admin allow-overrides, minus the per-admin deny-overrides. The role
   * stays the source of truth, so a later role-matrix change still propagates
   * except where a human explicitly overrode it.
   */
  async getPermissionKeysForAdmin(
    adminId: string,
    roleKey: RoleKey
  ): Promise<string[]> {
    const [roleKeys, overrides] = await Promise.all([
      this.getPermissionKeysForRole(roleKey),
      prisma.adminPermissionOverride.findMany({
        where: { adminId },
        select: { allow: true, permission: { select: { key: true } } },
      }),
    ]);

    // Implied reads resolve before the denies so an explicit deny still wins.
    const allowed = overrides
      .filter((o) => o.allow)
      .map((o) => o.permission.key);
    const effective = new Set(withImpliedReads([...roleKeys, ...allowed]));
    for (const o of overrides) {
      if (!o.allow) effective.delete(o.permission.key);
    }
    return [...effective];
  },

  /** The raw override rows for one admin (with their permission key). */
  listOverridesForAdmin(adminId: string) {
    return prisma.adminPermissionOverride.findMany({
      where: { adminId },
      select: {
        permissionId: true,
        allow: true,
        permission: { select: { key: true } },
      },
    });
  },

  /**
   * Full replace of an admin's overrides — the caller computes the complete
   * delta set every save, so anything absent from `rows` is no longer an
   * override and must fall back to the role baseline.
   */
  async replaceOverridesForAdmin(
    adminId: string,
    rows: { permissionId: string; allow: boolean }[]
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.adminPermissionOverride.deleteMany({ where: { adminId } });
      if (rows.length > 0) {
        await tx.adminPermissionOverride.createMany({
          data: rows.map((r) => ({ adminId, ...r })),
        });
      }
    });
  },

  /** Validate incoming permission keys against the DB catalogue, not a TS constant. */
  findPermissionsByKeys(keys: string[]) {
    return prisma.permission.findMany({
      where: { key: { in: keys } },
      select: { id: true, key: true },
    });
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
