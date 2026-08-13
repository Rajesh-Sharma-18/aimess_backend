/**
 * Admin Accounts service unit tests — the business rules that the route-level
 * spec (admin-account-management.test.ts) exercises only via mocked responses:
 * duplicate-email rejection, unique-constraint race, SUPER_ADMIN guardrails,
 * self-deactivation prevention, and session revocation on deactivate.
 */
jest.mock("../../src/repositories/index.js", () => ({
  adminUserRepository: {
    findByEmail: jest.fn(),
    findByName: jest.fn(async () => null),
    findById: jest.fn(),
    findRoleByKey: jest.fn(),
    createAdmin: jest.fn(),
    updateProfile: jest.fn(),
    setStatus: jest.fn(),
    updateRole: jest.fn(),
    countActiveWithPermission: jest.fn(async () => 5),
    list: jest.fn(),
  },
  adminSessionRepository: {
    listActiveByAdmin: jest.fn(async () => []),
    revokeAllForAdmin: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/lib/admin-session-cache.js", () => ({
  markAdminSessionsRevoked: jest.fn(async () => undefined),
}));
jest.mock("../../src/lib/password.js", () => ({
  hashPassword: jest.fn(async () => "hashed-password"),
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => undefined) },
}));
jest.mock("../../src/lib/admin-perms-cache.js", () => ({
  invalidateAdminPermissions: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/rbac.service.js", () => ({
  rbacService: {
    getPermissionKeysForRole: jest.fn(async () => ["dashboard.read"]),
    getPermissionKeysForAdmin: jest.fn(async () => ["dashboard.read"]),
    listOverridesForAdmin: jest.fn(async () => []),
    replaceOverridesForAdmin: jest.fn(async () => undefined),
    findPermissionsByKeys: jest.fn(async () => []),
    listPermissions: jest.fn(async () => []),
  },
}));

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@aimess/errors";

import { adminAccountService } from "../../src/services/admin-account.service.js";
import {
  adminSessionRepository,
  adminUserRepository,
} from "../../src/repositories/index.js";
import { markAdminSessionsRevoked } from "../../src/lib/admin-session-cache.js";
import { auditService } from "../../src/services/audit.service.js";
import { rbacService } from "../../src/services/rbac.service.js";
import type { RequestAdmin } from "../../src/types/index.js";

const repo = adminUserRepository as unknown as Record<string, jest.Mock>;
const rbac = rbacService as unknown as Record<string, jest.Mock>;
const sessionRepo = adminSessionRepository as unknown as Record<
  string,
  jest.Mock
>;

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const CTX = { ip: "127.0.0.1", userAgent: "jest" };

function actor(role: string): RequestAdmin {
  return { id: ACTOR_ID, role, permissions: [], sid: "sid" };
}

function adminRow(over: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    email: "target@aimess.local",
    name: "Target",
    avatarUrl: null,
    status: "ACTIVE",
    lastLoginAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    role: { key: "MODERATOR", name: "Moderator" },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("createAdminAccount", () => {
  const input = {
    email: "new@aimess.local",
    password: "Str0ng!Pass",
    name: "New Admin",
    roleKey: "MODERATOR",
  };

  it("rejects a duplicate email without hitting the DB unique constraint", async () => {
    repo.findByEmail.mockResolvedValue(adminRow());
    await expect(
      adminAccountService.createAdminAccount(input, actor("ADMIN"), CTX)
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repo.createAdmin).not.toHaveBeenCalled();
  });

  it("rejects a duplicate username", async () => {
    repo.findByEmail.mockResolvedValue(null);
    repo.findByName.mockResolvedValueOnce(adminRow());
    await expect(
      adminAccountService.createAdminAccount(input, actor("ADMIN"), CTX)
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repo.createAdmin).not.toHaveBeenCalled();
  });

  it("maps a P2002 unique-constraint race to ConflictError", async () => {
    repo.findByEmail.mockResolvedValue(null);
    repo.findRoleByKey.mockResolvedValue({ id: "role-1", key: "MODERATOR" });
    repo.createAdmin.mockRejectedValue({ code: "P2002" });
    await expect(
      adminAccountService.createAdminAccount(input, actor("ADMIN"), CTX)
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("throws NotFoundError when the role key doesn't resolve", async () => {
    repo.findByEmail.mockResolvedValue(null);
    repo.findRoleByKey.mockResolvedValue(null);
    await expect(
      adminAccountService.createAdminAccount(input, actor("ADMIN"), CTX)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a non-SUPER_ADMIN actor granting the SUPER_ADMIN role", async () => {
    await expect(
      adminAccountService.createAdminAccount(
        { ...input, roleKey: "SUPER_ADMIN" },
        actor("ADMIN"),
        CTX
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.findByEmail).not.toHaveBeenCalled();
  });

  it("allows a SUPER_ADMIN actor to grant the SUPER_ADMIN role", async () => {
    repo.findByEmail.mockResolvedValue(null);
    repo.findRoleByKey.mockResolvedValue({ id: "role-1", key: "SUPER_ADMIN" });
    repo.createAdmin.mockResolvedValue(
      adminRow({ role: { key: "SUPER_ADMIN", name: "Super Admin" } })
    );
    await expect(
      adminAccountService.createAdminAccount(
        { ...input, roleKey: "SUPER_ADMIN" },
        actor("SUPER_ADMIN"),
        CTX
      )
    ).resolves.toMatchObject({ role: { key: "SUPER_ADMIN" } });
    expect(auditService.record).toHaveBeenCalled();
  });
});

describe("deactivateAdminAccount", () => {
  it("rejects self-deactivation before any lookup", async () => {
    await expect(
      adminAccountService.deactivateAdminAccount(ACTOR_ID, actor("ADMIN"), CTX)
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when the target admin doesn't exist", async () => {
    repo.findById.mockResolvedValue(null);
    await expect(
      adminAccountService.deactivateAdminAccount(TARGET_ID, actor("ADMIN"), CTX)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects deactivating a SUPER_ADMIN unless the actor is one too", async () => {
    repo.findById.mockResolvedValue(
      adminRow({ role: { key: "SUPER_ADMIN", name: "Super Admin" } })
    );
    await expect(
      adminAccountService.deactivateAdminAccount(TARGET_ID, actor("ADMIN"), CTX)
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.setStatus).not.toHaveBeenCalled();
  });

  it("rejects deactivating an already-disabled admin", async () => {
    repo.findById.mockResolvedValue(adminRow({ status: "DISABLED" }));
    await expect(
      adminAccountService.deactivateAdminAccount(TARGET_ID, actor("ADMIN"), CTX)
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects deactivating the last effective admins.manage holder", async () => {
    repo.findById.mockResolvedValue(
      adminRow({ role: { key: "SUPER_ADMIN", name: "Super Admin" } })
    );
    repo.countActiveWithPermission.mockResolvedValue(0);
    await expect(
      adminAccountService.deactivateAdminAccount(
        TARGET_ID,
        actor("SUPER_ADMIN"),
        CTX
      )
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repo.setStatus).not.toHaveBeenCalled();
  });

  it("rejects deactivating the last holder even when the role is not SUPER_ADMIN", async () => {
    // Holds admins.manage via an allow-override on MODERATOR — invisible to a
    // role-based guard, but the same lockout.
    repo.findById.mockResolvedValue(adminRow());
    repo.countActiveWithPermission.mockResolvedValue(0);

    await expect(
      adminAccountService.deactivateAdminAccount(TARGET_ID, actor("ADMIN"), CTX)
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repo.setStatus).not.toHaveBeenCalled();
  });

  it("allows deactivating a SUPER_ADMIN when another one is still active", async () => {
    repo.findById
      .mockResolvedValueOnce(
        adminRow({ role: { key: "SUPER_ADMIN", name: "Super Admin" } })
      )
      .mockResolvedValueOnce(
        adminRow({
          status: "DISABLED",
          role: { key: "SUPER_ADMIN", name: "Super Admin" },
        })
      );
    repo.countActiveWithPermission.mockResolvedValue(1);
    repo.setStatus.mockResolvedValue(undefined);

    await expect(
      adminAccountService.deactivateAdminAccount(
        TARGET_ID,
        actor("SUPER_ADMIN"),
        CTX
      )
    ).resolves.toMatchObject({ status: "DISABLED" });
  });

  it("deactivates and revokes every active session for the target", async () => {
    repo.findById
      .mockResolvedValueOnce(adminRow({ status: "ACTIVE" }))
      .mockResolvedValueOnce(adminRow({ status: "DISABLED" }));
    repo.setStatus.mockResolvedValue(undefined);
    sessionRepo.listActiveByAdmin.mockResolvedValue([
      { id: "s1" },
      { id: "s2" },
    ]);

    const result = await adminAccountService.deactivateAdminAccount(
      TARGET_ID,
      actor("ADMIN"),
      CTX
    );

    expect(result.status).toBe("DISABLED");
    expect(repo.setStatus).toHaveBeenCalledWith(TARGET_ID, "DISABLED");
    expect(sessionRepo.revokeAllForAdmin).toHaveBeenCalledWith(TARGET_ID);
    expect(markAdminSessionsRevoked).toHaveBeenCalledWith(["s1", "s2"]);
    expect(auditService.record).toHaveBeenCalled();
  });
});

describe("activateAdminAccount", () => {
  it("rejects activating an already-active admin", async () => {
    repo.findById.mockResolvedValue(adminRow({ status: "ACTIVE" }));
    await expect(
      adminAccountService.activateAdminAccount(TARGET_ID, actor("ADMIN"), CTX)
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects activating a deleted admin", async () => {
    repo.findById.mockResolvedValue(adminRow({ status: "DELETED" }));
    await expect(
      adminAccountService.activateAdminAccount(TARGET_ID, actor("ADMIN"), CTX)
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.setStatus).not.toHaveBeenCalled();
  });

  it("activates a disabled admin", async () => {
    repo.findById
      .mockResolvedValueOnce(adminRow({ status: "DISABLED" }))
      .mockResolvedValueOnce(adminRow({ status: "ACTIVE" }));
    repo.setStatus.mockResolvedValue(undefined);

    const result = await adminAccountService.activateAdminAccount(
      TARGET_ID,
      actor("ADMIN"),
      CTX
    );
    expect(result.status).toBe("ACTIVE");
    expect(repo.setStatus).toHaveBeenCalledWith(TARGET_ID, "ACTIVE");
  });
});

describe("updateAdminAccount", () => {
  it("rejects updating a deleted admin", async () => {
    repo.findById.mockResolvedValue(adminRow({ status: "DELETED" }));
    await expect(
      adminAccountService.updateAdminAccount(
        TARGET_ID,
        { name: "New Name" },
        actor("ADMIN"),
        CTX
      )
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a duplicate email owned by another admin", async () => {
    repo.findById.mockResolvedValue(adminRow());
    repo.findByEmail.mockResolvedValue(adminRow({ id: "someone-else" }));
    await expect(
      adminAccountService.updateAdminAccount(
        TARGET_ID,
        { email: "taken@aimess.local" },
        actor("ADMIN"),
        CTX
      )
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repo.updateProfile).not.toHaveBeenCalled();
  });

  it("rejects a duplicate username owned by another admin", async () => {
    repo.findById.mockResolvedValue(adminRow());
    repo.findByName.mockResolvedValueOnce(adminRow({ id: "someone-else" }));
    await expect(
      adminAccountService.updateAdminAccount(
        TARGET_ID,
        { name: "Taken Name" },
        actor("ADMIN"),
        CTX
      )
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repo.updateProfile).not.toHaveBeenCalled();
  });

  it("updates profile fields", async () => {
    repo.findById.mockResolvedValue(adminRow());
    repo.updateProfile.mockResolvedValue(adminRow({ name: "New Name" }));
    const result = await adminAccountService.updateAdminAccount(
      TARGET_ID,
      { name: "New Name" },
      actor("ADMIN"),
      CTX
    );
    expect(result.name).toBe("New Name");
    expect(auditService.record).toHaveBeenCalled();
  });
});

describe("updateAdminAccountStatus", () => {
  it("routes status ACTIVE to activateAdminAccount", async () => {
    repo.findById
      .mockResolvedValueOnce(adminRow({ status: "DISABLED" }))
      .mockResolvedValueOnce(adminRow({ status: "ACTIVE" }));
    repo.setStatus.mockResolvedValue(undefined);

    const result = await adminAccountService.updateAdminAccountStatus(
      TARGET_ID,
      { status: "ACTIVE" },
      actor("ADMIN"),
      CTX
    );
    expect(result.status).toBe("ACTIVE");
    expect(repo.setStatus).toHaveBeenCalledWith(TARGET_ID, "ACTIVE");
  });

  it("routes status INACTIVE to deactivateAdminAccount", async () => {
    repo.findById
      .mockResolvedValueOnce(adminRow({ status: "ACTIVE" }))
      .mockResolvedValueOnce(adminRow({ status: "DISABLED" }));
    repo.setStatus.mockResolvedValue(undefined);

    const result = await adminAccountService.updateAdminAccountStatus(
      TARGET_ID,
      { status: "INACTIVE" },
      actor("ADMIN"),
      CTX
    );
    expect(result.status).toBe("DISABLED");
    expect(repo.setStatus).toHaveBeenCalledWith(TARGET_ID, "DISABLED");
  });
});

describe("updateAdminPermissions", () => {
  it("rejects granting SUPER_ADMIN unless the actor is one", async () => {
    repo.findById.mockResolvedValue(adminRow());
    await expect(
      adminAccountService.updateAdminPermissions(
        TARGET_ID,
        { roleKey: "SUPER_ADMIN" },
        actor("ADMIN"),
        CTX
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.updateRole).not.toHaveBeenCalled();
  });

  it("rejects modifying a SUPER_ADMIN's role unless the actor is one", async () => {
    repo.findById.mockResolvedValue(
      adminRow({ role: { key: "SUPER_ADMIN", name: "Super Admin" } })
    );
    await expect(
      adminAccountService.updateAdminPermissions(
        TARGET_ID,
        { roleKey: "MODERATOR" },
        actor("ADMIN"),
        CTX
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("reassigns the role and returns the resolved permission set", async () => {
    repo.findById.mockResolvedValue(adminRow());
    repo.findRoleByKey.mockResolvedValue({ id: "role-2", key: "ADMIN" });
    repo.updateRole.mockResolvedValue(
      adminRow({ role: { key: "ADMIN", name: "Admin" } })
    );

    const result = await adminAccountService.updateAdminPermissions(
      TARGET_ID,
      { roleKey: "ADMIN" },
      actor("SUPER_ADMIN"),
      CTX
    );

    expect(result.role.key).toBe("ADMIN");
    expect(result.permissions).toEqual(["dashboard.read"]);
    expect(auditService.record).toHaveBeenCalled();
  });

  it("rejects an admin editing their own permissions", async () => {
    await expect(
      adminAccountService.updateAdminPermissions(
        ACTOR_ID,
        { permissions: [] },
        actor("SUPER_ADMIN"),
        CTX
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("rejects an unknown permission key instead of silently dropping it", async () => {
    repo.findById.mockResolvedValue(adminRow());
    rbac.findPermissionsByKeys.mockResolvedValueOnce([
      { id: "perm-1", key: "dashboard.read" },
    ]);

    await expect(
      adminAccountService.updateAdminPermissions(
        TARGET_ID,
        { permissions: ["dashboard.read", "nope.invent"] },
        actor("SUPER_ADMIN"),
        CTX
      )
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(rbac.replaceOverridesForAdmin).not.toHaveBeenCalled();
  });

  it("persists only the deltas — a toggle matching the role stores no row", async () => {
    repo.findById.mockResolvedValue(adminRow());
    rbac.findPermissionsByKeys.mockResolvedValueOnce([
      { id: "perm-1", key: "dashboard.read" },
      { id: "perm-2", key: "users.read" },
    ]);
    // Role baseline is ["dashboard.read"]: users.read is an allow delta, while
    // dashboard.read agrees with the role and must stay unrecorded.
    await adminAccountService.updateAdminPermissions(
      TARGET_ID,
      { permissions: ["dashboard.read", "users.read"] },
      actor("SUPER_ADMIN"),
      CTX
    );

    expect(rbac.replaceOverridesForAdmin).toHaveBeenCalledWith(TARGET_ID, [
      { permissionId: "perm-2", allow: true },
    ]);
  });

  it("stores a deny row when the grid drops a permission the role grants", async () => {
    repo.findById.mockResolvedValue(adminRow());
    rbac.findPermissionsByKeys.mockResolvedValueOnce([
      { id: "perm-1", key: "dashboard.read" },
    ]);

    await adminAccountService.updateAdminPermissions(
      TARGET_ID,
      { permissions: [] },
      actor("SUPER_ADMIN"),
      CTX
    );

    expect(rbac.replaceOverridesForAdmin).toHaveBeenCalledWith(TARGET_ID, [
      { permissionId: "perm-1", allow: false },
    ]);
  });

  it("refuses to take admins.manage off the last effective holder", async () => {
    repo.findById.mockResolvedValue(
      adminRow({ role: { key: "SUPER_ADMIN", name: "Super Admin" } })
    );
    repo.countActiveWithPermission.mockResolvedValue(0);
    rbac.getPermissionKeysForRole.mockResolvedValueOnce(["admins.manage"]);
    rbac.findPermissionsByKeys.mockResolvedValueOnce([
      { id: "perm-9", key: "admins.manage" },
    ]);

    await expect(
      adminAccountService.updateAdminPermissions(
        TARGET_ID,
        { permissions: [] },
        actor("SUPER_ADMIN"),
        CTX
      )
    ).rejects.toBeInstanceOf(ConflictError);
    expect(rbac.replaceOverridesForAdmin).not.toHaveBeenCalled();
  });
});

/**
 * The lockout invariant: after any change at least one ACTIVE admin must still
 * hold `admins.manage` EFFECTIVELY (role baseline ∪ allow-overrides ∖ denies).
 * `holders` stands in for the rows the repository counts, so the guard is
 * exercised against a state that actually moves between calls.
 */
describe("last admins.manage holder invariant", () => {
  const SECOND_ID = "33333333-3333-4333-8333-333333333333";
  let holders: string[];

  beforeEach(() => {
    holders = [TARGET_ID, SECOND_ID];
    repo.countActiveWithPermission.mockImplementation(
      async (_key: string, excludeAdminId?: string) =>
        holders.filter((h) => h !== excludeAdminId).length
    );
    rbac.getPermissionKeysForRole.mockResolvedValue(["admins.manage"]);
    rbac.findPermissionsByKeys.mockResolvedValue([
      { id: "perm-9", key: "admins.manage" },
    ]);
    repo.findById.mockImplementation(async (id: string) =>
      adminRow({ id, role: { key: "SUPER_ADMIN", name: "Super Admin" } })
    );
  });

  it("strips admins.manage off the first of two SUPER_ADMINs but rejects the second", async () => {
    await adminAccountService.updateAdminPermissions(
      TARGET_ID,
      { permissions: [] },
      actor("SUPER_ADMIN"),
      CTX
    );
    expect(rbac.replaceOverridesForAdmin).toHaveBeenCalledWith(TARGET_ID, [
      { permissionId: "perm-9", allow: false },
    ]);
    // The write the service just made: TARGET_ID no longer holds the key.
    holders = holders.filter((h) => h !== TARGET_ID);

    await expect(
      adminAccountService.updateAdminPermissions(
        SECOND_ID,
        { permissions: [] },
        actor("SUPER_ADMIN"),
        CTX
      )
    ).rejects.toBeInstanceOf(ConflictError);
    expect(rbac.replaceOverridesForAdmin).toHaveBeenCalledTimes(1);
  });

  it("counts a holder who has the key only via an allow-override on a lesser role", async () => {
    // Sole other holder is a MODERATOR with an allow-override — a role-based
    // count would see zero SUPER_ADMINs left and refuse.
    holders = [TARGET_ID, "44444444-4444-4444-8444-444444444444"];

    await expect(
      adminAccountService.updateAdminPermissions(
        TARGET_ID,
        { permissions: [] },
        actor("SUPER_ADMIN"),
        CTX
      )
    ).resolves.toBeDefined();
    expect(repo.countActiveWithPermission).toHaveBeenCalledWith(
      "admins.manage",
      TARGET_ID
    );
  });

  it("rejects stripping the sole holder even when their role is not SUPER_ADMIN", async () => {
    holders = [TARGET_ID];
    repo.findById.mockImplementation(async (id: string) => adminRow({ id }));

    await expect(
      adminAccountService.updateAdminPermissions(
        TARGET_ID,
        { permissions: [] },
        actor("ADMIN"),
        CTX
      )
    ).rejects.toBeInstanceOf(ConflictError);
    expect(rbac.replaceOverridesForAdmin).not.toHaveBeenCalled();
  });

  it("rejects deactivating the last effective holder", async () => {
    holders = [TARGET_ID];

    await expect(
      adminAccountService.deactivateAdminAccount(
        TARGET_ID,
        actor("SUPER_ADMIN"),
        CTX
      )
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repo.setStatus).not.toHaveBeenCalled();
  });
});
