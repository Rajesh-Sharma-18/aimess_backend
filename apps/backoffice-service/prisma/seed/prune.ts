import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { PERMISSION_CATALOGUE } from "./permissions.catalogue.js";
import { ROLE_MATRIX } from "./role-matrix.js";

/**
 * Deletes what the constants no longer declare. The rest of the seed is
 * upsert-only, so without this a key dropped from PERMISSION_CATALOGUE — or
 * from one role's list in ROLE_MATRIX — survives forever in an already-seeded
 * database and roles stay over-granted.
 *
 * Prunes strictly by "absent from those two constants", never by any other
 * heuristic. Safe because the seed is the sole author of Permission and
 * RolePermission: no runtime code writes either table.
 *
 * Order is forced by the FKs — AdminPermissionOverride.permissionId and
 * RolePermission.permissionId are both ON DELETE RESTRICT (see the init
 * migration and 20260812130000_add_admin_permission_override) — so dependent
 * rows go first.
 *
 * Logs every row it removes, because this runs against a shared database.
 * Idempotent: a second run finds nothing and logs nothing. Set
 * SEED_PRUNE_DRY_RUN=true to log the same lines without deleting anything.
 */
export async function prunePermissions(prisma: PrismaClient): Promise<void> {
  const dryRun = process.env.SEED_PRUNE_DRY_RUN === "true";
  const verb = dryRun ? "[dry-run] would delete" : "Pruned";

  // 1. RolePermission pairs the matrix no longer declares.
  const declaredPairs = new Set(
    ROLE_MATRIX.flatMap((role) =>
      role.permissions.map((key) => `${role.key}:${key}`)
    )
  );
  const pairs = await prisma.rolePermission.findMany({
    select: {
      roleId: true,
      permissionId: true,
      role: { select: { key: true } },
      permission: { select: { key: true } },
    },
  });
  const stalePairs = pairs.filter(
    (row) => !declaredPairs.has(`${row.role.key}:${row.permission.key}`)
  );

  if (stalePairs.length > 0) {
    if (!dryRun) {
      await prisma.rolePermission.deleteMany({
        where: {
          OR: stalePairs.map(({ roleId, permissionId }) => ({
            roleId,
            permissionId,
          })),
        },
      });
    }
    // eslint-disable-next-line no-console
    console.log(
      `${verb} ${String(stalePairs.length)} RolePermission row(s): ${stalePairs
        .map((row) => `${row.role.key}->${row.permission.key}`)
        .join(", ")}`
    );
  }

  // 2. Permissions the catalogue no longer declares, and the per-admin
  //    overrides pointing at them — the grid toggle is gone, so is its delta.
  //    Step 1 has already cleared their RolePermission rows: a key absent from
  //    the catalogue cannot appear in the matrix (seedRoles throws on that), so
  //    the overrides are the only rows left holding the RESTRICT.
  const stale = await prisma.permission.findMany({
    where: { key: { notIn: PERMISSION_CATALOGUE.map(({ key }) => key) } },
    select: { id: true, key: true },
  });
  if (stale.length === 0) return;

  const permissionIds = stale.map(({ id }) => id);
  const overrides = await prisma.adminPermissionOverride.count({
    where: { permissionId: { in: permissionIds } },
  });

  if (!dryRun) {
    await prisma.adminPermissionOverride.deleteMany({
      where: { permissionId: { in: permissionIds } },
    });
    await prisma.permission.deleteMany({
      where: { id: { in: permissionIds } },
    });
  }
  // eslint-disable-next-line no-console
  console.log(
    `${verb} ${String(stale.length)} Permission row(s): ${stale
      .map(({ key }) => key)
      .join(", ")} (+ ${String(
      overrides
    )} AdminPermissionOverride row(s) referencing them)`
  );
}
