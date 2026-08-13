/**
 * The seed's prune pass. Everything else in prisma/seed is upsert-only, so this
 * is the only thing that can remove a permission (or a role's grant of one)
 * from an already-seeded database. It runs against a SHARED Postgres, so what
 * matters here is that it deletes EXACTLY the rows the constants no longer
 * declare, in FK-safe order, and nothing on a second run.
 *
 * The Prisma client is faked with real filtering semantics (not jest.fn stubs)
 * so "run it twice" genuinely exercises the post-delete state.
 */
import { PERMISSION_CATALOGUE } from "../../prisma/seed/permissions.catalogue.js";
import { prunePermissions } from "../../prisma/seed/prune.js";
import { ROLE_MATRIX } from "../../prisma/seed/role-matrix.js";

type PermissionRow = { id: string; key: string };
type RolePermissionRow = { roleId: string; permissionId: string };
type OverrideRow = { adminId: string; permissionId: string };

type FakeDb = {
  permissions: PermissionRow[];
  rolePermissions: RolePermissionRow[];
  overrides: OverrideRow[];
};

const calls: string[] = [];

// Minimal stand-in for the four delegates prunePermissions touches.
function fakePrisma(db: FakeDb) {
  const keyOf = (permissionId: string) =>
    db.permissions.find((p) => p.id === permissionId)?.key ?? "?";

  return {
    rolePermission: {
      findMany: async () =>
        db.rolePermissions.map((row) => ({
          ...row,
          role: { key: row.roleId },
          permission: { key: keyOf(row.permissionId) },
        })),
      deleteMany: async ({ where }: { where: { OR: RolePermissionRow[] } }) => {
        calls.push("rolePermission.deleteMany");
        db.rolePermissions = db.rolePermissions.filter(
          (row) =>
            !where.OR.some(
              (pair) =>
                pair.roleId === row.roleId &&
                pair.permissionId === row.permissionId
            )
        );
      },
    },
    permission: {
      findMany: async ({ where }: { where: { key: { notIn: string[] } } }) =>
        db.permissions.filter((p) => !where.key.notIn.includes(p.key)),
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        calls.push("permission.deleteMany");
        db.permissions = db.permissions.filter(
          (p) => !where.id.in.includes(p.id)
        );
      },
    },
    adminPermissionOverride: {
      count: async ({ where }: { where: { permissionId: { in: string[] } } }) =>
        db.overrides.filter((o) =>
          where.permissionId.in.includes(o.permissionId)
        ).length,
      deleteMany: async ({
        where,
      }: {
        where: { permissionId: { in: string[] } };
      }) => {
        calls.push("adminPermissionOverride.deleteMany");
        db.overrides = db.overrides.filter(
          (o) => !where.permissionId.in.includes(o.permissionId)
        );
      },
    },
  };
}

// A database seeded from the CURRENT constants, plus whatever extra stale rows
// the test wants. Role ids double as role keys — the fake joins on them.
function seededDb(extra: Partial<FakeDb> = {}): FakeDb {
  const permissions = PERMISSION_CATALOGUE.map(({ key }) => ({
    id: `perm-${key}`,
    key,
  }));
  const rolePermissions = ROLE_MATRIX.flatMap((role) =>
    role.permissions.map((key) => ({
      roleId: role.key,
      permissionId: `perm-${key}`,
    }))
  );
  return {
    permissions: [...permissions, ...(extra.permissions ?? [])],
    rolePermissions: [...rolePermissions, ...(extra.rolePermissions ?? [])],
    overrides: [...(extra.overrides ?? [])],
  };
}

const STALE = { id: "perm-users.delete", key: "users.delete" };

let logSpy: jest.SpyInstance;

beforeEach(() => {
  calls.length = 0;
  delete process.env.SEED_PRUNE_DRY_RUN;
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("constants", () => {
  it("no longer declares the phantom users.delete key", () => {
    expect(PERMISSION_CATALOGUE.map(({ key }) => key)).not.toContain(
      "users.delete"
    );
    for (const role of ROLE_MATRIX) {
      expect(role.permissions).not.toContain("users.delete");
    }
  });

  it("grants only keys the catalogue declares (else seedRoles throws)", () => {
    const catalogue = new Set(PERMISSION_CATALOGUE.map(({ key }) => key));
    for (const role of ROLE_MATRIX) {
      for (const key of role.permissions) {
        expect(catalogue.has(key)).toBe(true);
      }
    }
  });
});

describe("prunePermissions", () => {
  it("deletes nothing and logs nothing when the database matches the constants", async () => {
    const db = seededDb();
    await prunePermissions(fakePrisma(db) as never);

    expect(calls).toEqual([]);
    expect(logSpy).not.toHaveBeenCalled();
    expect(db.permissions).toHaveLength(PERMISSION_CATALOGUE.length);
  });

  it("deletes a permission the catalogue dropped, its overrides first, and leaves every declared key", async () => {
    const db = seededDb({
      permissions: [STALE],
      overrides: [{ adminId: "admin-1", permissionId: STALE.id }],
    });

    await prunePermissions(fakePrisma(db) as never);

    expect(calls).toEqual([
      "adminPermissionOverride.deleteMany",
      "permission.deleteMany",
    ]);
    expect(db.permissions.map(({ key }) => key)).toEqual(
      PERMISSION_CATALOGUE.map(({ key }) => key)
    );
    expect(db.overrides).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith(
      "Pruned 1 Permission row(s): users.delete (+ 1 AdminPermissionOverride row(s) referencing them)"
    );
  });

  it("deletes only the RolePermission pairs the matrix dropped", async () => {
    const db = seededDb({
      permissions: [STALE],
      rolePermissions: [
        { roleId: "SUPER_ADMIN", permissionId: STALE.id },
        { roleId: "ADMIN", permissionId: STALE.id },
      ],
    });
    const declared = db.rolePermissions.length - 2;

    await prunePermissions(fakePrisma(db) as never);

    expect(calls[0]).toBe("rolePermission.deleteMany");
    expect(db.rolePermissions).toHaveLength(declared);
    expect(
      db.rolePermissions.some((row) => row.permissionId === STALE.id)
    ).toBe(false);
    expect(
      db.rolePermissions.filter(
        (row) =>
          row.roleId === "ADMIN" && row.permissionId === "perm-users.moderate"
      )
    ).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(
      "Pruned 2 RolePermission row(s): SUPER_ADMIN->users.delete, ADMIN->users.delete"
    );
  });

  it("revokes a role's grant without touching the permission when only the matrix dropped it", async () => {
    // admins.manage stays in the catalogue; SUPPORT_AGENT is not granted it.
    const db = seededDb({
      rolePermissions: [
        { roleId: "SUPPORT_AGENT", permissionId: "perm-admins.manage" },
      ],
    });

    await prunePermissions(fakePrisma(db) as never);

    expect(calls).toEqual(["rolePermission.deleteMany"]);
    expect(db.permissions).toHaveLength(PERMISSION_CATALOGUE.length);
    expect(
      db.rolePermissions.some(
        (row) =>
          row.roleId === "SUPPORT_AGENT" &&
          row.permissionId === "perm-admins.manage"
      )
    ).toBe(false);
  });

  it("is idempotent — a second run deletes nothing and logs nothing", async () => {
    const db = seededDb({
      permissions: [STALE],
      rolePermissions: [{ roleId: "ADMIN", permissionId: STALE.id }],
      overrides: [{ adminId: "admin-1", permissionId: STALE.id }],
    });
    const prisma = fakePrisma(db);

    await prunePermissions(prisma as never);
    expect(calls.length).toBeGreaterThan(0);

    calls.length = 0;
    logSpy.mockClear();
    await prunePermissions(prisma as never);

    expect(calls).toEqual([]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("SEED_PRUNE_DRY_RUN=true logs the same rows but deletes none of them", async () => {
    process.env.SEED_PRUNE_DRY_RUN = "true";
    const db = seededDb({
      permissions: [STALE],
      rolePermissions: [{ roleId: "ADMIN", permissionId: STALE.id }],
      overrides: [{ adminId: "admin-1", permissionId: STALE.id }],
    });

    await prunePermissions(fakePrisma(db) as never);

    expect(calls).toEqual([]);
    expect(db.permissions).toContainEqual(STALE);
    expect(db.overrides).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(
      "[dry-run] would delete 1 RolePermission row(s): ADMIN->users.delete"
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[dry-run] would delete 1 Permission row(s): users.delete (+ 1 AdminPermissionOverride row(s) referencing them)"
    );
  });
});
