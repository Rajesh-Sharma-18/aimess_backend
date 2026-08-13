/**
 * Effective-permission resolution: (role UNION allow-overrides) MINUS
 * deny-overrides — per admin (rbacRepository.getPermissionKeysForAdmin) and as
 * a set-level count (adminUserRepository.countActiveWithPermission, which backs
 * the lockout guards). Only the Prisma client is mocked — this is the rule the
 * permission grid's delta model rests on, so it is asserted against the real
 * query-shaping code.
 */
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    adminRole: { findUnique: jest.fn() },
    adminPermissionOverride: { findMany: jest.fn() },
    adminUser: { count: jest.fn(async () => 0) },
  },
}));

import { prisma } from "../../src/config/prisma.js";
import { adminUserRepository } from "../../src/repositories/admin-user.repository.js";
import { rbacRepository } from "../../src/repositories/rbac.repository.js";

const db = prisma as unknown as {
  adminRole: { findUnique: jest.Mock };
  adminPermissionOverride: { findMany: jest.Mock };
  adminUser: { count: jest.Mock };
};

const ADMIN_ID = "55555555-5555-4555-8555-555555555555";

function roleGranting(...keys: string[]) {
  return { permissions: keys.map((key) => ({ permission: { key } })) };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.adminRole.findUnique.mockResolvedValue(
    roleGranting("dashboard.read", "users.read")
  );
  db.adminPermissionOverride.findMany.mockResolvedValue([]);
});

describe("rbacRepository.getPermissionKeysForAdmin", () => {
  it("returns the bare role baseline when there are no overrides", async () => {
    const keys = await rbacRepository.getPermissionKeysForAdmin(
      ADMIN_ID,
      "MODERATOR"
    );
    expect(keys.sort()).toEqual(["dashboard.read", "users.read"]);
  });

  it("adds allow-overrides and removes deny-overrides — a deny beats the role grant", async () => {
    db.adminPermissionOverride.findMany.mockResolvedValue([
      { allow: true, permission: { key: "reports.read" } },
      { allow: false, permission: { key: "users.read" } },
    ]);

    const keys = await rbacRepository.getPermissionKeysForAdmin(
      ADMIN_ID,
      "MODERATOR"
    );

    expect(keys.sort()).toEqual(["dashboard.read", "reports.read"]);
    expect(keys).not.toContain("users.read");
  });

  it("implies <module>.read from an action key, on the role and on an allow-override", async () => {
    db.adminRole.findUnique.mockResolvedValue(
      roleGranting("categories.manage")
    );
    db.adminPermissionOverride.findMany.mockResolvedValue([
      { allow: true, permission: { key: "admins.manage" } },
    ]);

    const keys = await rbacRepository.getPermissionKeysForAdmin(
      ADMIN_ID,
      "MODERATOR"
    );

    expect(keys.sort()).toEqual([
      "admins.manage",
      "admins.read",
      "categories.manage",
      "categories.read",
    ]);
  });

  it("never implies a read key the catalogue does not have (settings)", async () => {
    db.adminRole.findUnique.mockResolvedValue(roleGranting("settings.manage"));

    const keys = await rbacRepository.getPermissionKeysForAdmin(
      ADMIN_ID,
      "SUPER_ADMIN"
    );

    expect(keys).toEqual(["settings.manage"]);
  });

  it("lets an explicit deny of the read key beat the implication", async () => {
    db.adminRole.findUnique.mockResolvedValue(roleGranting("users.moderate"));
    db.adminPermissionOverride.findMany.mockResolvedValue([
      { allow: false, permission: { key: "users.read" } },
    ]);

    const keys = await rbacRepository.getPermissionKeysForAdmin(
      ADMIN_ID,
      "MODERATOR"
    );

    expect(keys).toEqual(["users.moderate"]);
  });

  it("returns an empty set for an unknown role", async () => {
    db.adminRole.findUnique.mockResolvedValue(null);
    await expect(
      rbacRepository.getPermissionKeysForAdmin(ADMIN_ID, "MODERATOR")
    ).resolves.toEqual([]);
  });
});

describe("adminUserRepository.countActiveWithPermission", () => {
  it("counts ACTIVE admins by role-minus-deny OR allow-override, excluding one id", async () => {
    await adminUserRepository.countActiveWithPermission(
      "admins.manage",
      ADMIN_ID
    );

    expect(db.adminUser.count).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        id: { not: ADMIN_ID },
        OR: [
          {
            role: {
              permissions: { some: { permission: { key: "admins.manage" } } },
            },
            permissionOverrides: {
              none: { permission: { key: "admins.manage" }, allow: false },
            },
          },
          {
            permissionOverrides: {
              some: { permission: { key: "admins.manage" }, allow: true },
            },
          },
        ],
      },
    });
  });

  it("omits the id filter when no admin is excluded", async () => {
    await adminUserRepository.countActiveWithPermission("admins.manage");
    expect(db.adminUser.count.mock.calls[0][0].where).not.toHaveProperty("id");
  });
});
