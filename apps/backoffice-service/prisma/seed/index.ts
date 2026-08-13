import dotenv from "dotenv";

dotenv.config();

import { env } from "../../src/config/env.js";
import { prisma } from "../../src/config/prisma.js";
import { hashPassword } from "../../src/lib/password.js";
import type { RoleKey } from "../../src/generated/prisma/client.js";
import { PERMISSION_CATALOGUE } from "./permissions.catalogue.js";
import { prunePermissions } from "./prune.js";
import { ROLE_MATRIX } from "./role-matrix.js";
import { seedUserIndex } from "./user-index.seed.js";

async function seedPermissions(): Promise<Map<string, string>> {
  const keyToId = new Map<string, string>();
  for (const { key, group } of PERMISSION_CATALOGUE) {
    const perm = await prisma.permission.upsert({
      where: { key },
      update: { group },
      create: { key, group },
    });
    keyToId.set(key, perm.id);
  }
  return keyToId;
}

async function seedRoles(permKeyToId: Map<string, string>): Promise<void> {
  for (const role of ROLE_MATRIX) {
    const roleRow = await prisma.adminRole.upsert({
      where: { key: role.key as RoleKey },
      update: { name: role.name, description: role.description },
      create: {
        key: role.key as RoleKey,
        name: role.name,
        description: role.description,
      },
    });

    for (const permKey of role.permissions) {
      const permissionId = permKeyToId.get(permKey);
      if (!permissionId) {
        throw new Error(
          `Role ${role.key} references unknown permission "${permKey}"`
        );
      }
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: roleRow.id, permissionId },
        },
        update: {},
        create: { roleId: roleRow.id, permissionId },
      });
    }
  }
}

async function seedPlatformStats(): Promise<void> {
  await prisma.platformStats.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
}

async function bootstrapSuperAdmin(): Promise<void> {
  const email = env.BOOTSTRAP_SUPER_ADMIN_EMAIL;
  const password = env.BOOTSTRAP_SUPER_ADMIN_PASSWORD;

  if (!email || !password) {
    // eslint-disable-next-line no-console
    console.log(
      "BOOTSTRAP_SUPER_ADMIN_EMAIL/PASSWORD not set — skipping super-admin creation."
    );
    return;
  }

  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`Super-admin already exists (${email}) — skipping.`);
    return;
  }

  const superRole = await prisma.adminRole.findUnique({
    where: { key: "SUPER_ADMIN" },
  });
  if (!superRole) {
    throw new Error("SUPER_ADMIN role missing — seed roles first.");
  }

  await prisma.adminUser.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      name: env.BOOTSTRAP_SUPER_ADMIN_NAME,
      roleId: superRole.id,
      status: "ACTIVE",
    },
  });

  // Never log the password.
  // eslint-disable-next-line no-console
  console.log(`Created bootstrap SUPER_ADMIN: ${email}`);
}

async function main(): Promise<void> {
  const permKeyToId = await seedPermissions();
  await seedRoles(permKeyToId);
  await prunePermissions(prisma);
  await seedPlatformStats();
  await bootstrapSuperAdmin();

  // The UserIndex seed inserts ~40 INVENTED users (u_seed_NN) with fabricated
  // ban reasons and statuses. They render in the admin User Management screen
  // indistinguishably from real accounts, which is useful for UI work and
  // misleading anywhere else. Opt out with SEED_USER_INDEX=false.
  //
  // Defaults to true so existing local workflows are unchanged.
  const seedDemoUsers = process.env.SEED_USER_INDEX !== "false";
  const userIndexCount = seedDemoUsers ? await seedUserIndex(prisma) : 0;

  // eslint-disable-next-line no-console
  console.log(
    `Seeded ${String(PERMISSION_CATALOGUE.length)} permissions, ${String(
      ROLE_MATRIX.length
    )} roles, RolePermission matrix, PlatformStats singleton, and ${String(
      userIndexCount
    )} UserIndex rows${seedDemoUsers ? "" : " (demo users skipped via SEED_USER_INDEX=false)"}.`
  );
}

main()
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
