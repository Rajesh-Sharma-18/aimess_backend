/**
 * Permission-grid write path (PATCH /v1/admin-accounts/:adminId/permissions),
 * end-to-end through the real validator + controller + service + rbacService —
 * only the repository layer is mocked. Covers the delta invariant (a toggle at
 * its role default persists NO row), allow/deny rows, unknown-key rejection,
 * the self-edit guard and the last-SUPER_ADMIN guard.
 */
jest.mock("../../src/repositories/index.js", () => ({
  adminUserRepository: {
    findById: jest.fn(),
    findRoleByKey: jest.fn(),
    updateRole: jest.fn(),
    countActiveWithPermission: jest.fn(async () => 5),
  },
  rbacRepository: {
    getPermissionKeysForRole: jest.fn(),
    getPermissionKeysForAdmin: jest.fn(),
    listOverridesForAdmin: jest.fn(async () => []),
    replaceOverridesForAdmin: jest.fn(async () => undefined),
    findPermissionsByKeys: jest.fn(),
  },
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => undefined) },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import {
  adminUserRepository,
  rbacRepository,
} from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import {
  bearer,
  makeAdminAccessToken,
  TEST_ADMIN_ID,
} from "../helpers/auth.js";
import { activeAdminRow, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const repo = adminUserRepository as unknown as Record<string, jest.Mock>;
const rbac = rbacRepository as unknown as Record<string, jest.Mock>;
const perms = getCachedAdminPermissions as jest.Mock;

const TARGET_ID = "55555555-5555-4555-8555-555555555555";
const URL = `/v1/admin-accounts/${TARGET_ID}/permissions`;

/** The DB permission catalogue this spec validates keys against. */
const CATALOGUE = [
  { id: "perm-dashboard", key: PERMISSIONS.DASHBOARD_READ },
  { id: "perm-users", key: PERMISSIONS.USERS_READ },
  { id: "perm-reports", key: PERMISSIONS.REPORTS_READ },
  { id: "perm-admins", key: PERMISSIONS.ADMINS_MANAGE },
];
/** The MODERATOR role baseline used by every test below. */
const ROLE_KEYS_GRANTED = [PERMISSIONS.DASHBOARD_READ, PERMISSIONS.USERS_READ];

const auth = () => bearer(makeAdminAccessToken());

function targetRow(over: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    email: "moderator@aimess.local",
    name: "Mod One",
    avatarUrl: null,
    status: "ACTIVE",
    lastLoginAt: null,
    role: { key: "MODERATOR", name: "Moderator" },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // The actor is a SUPER_ADMIN so `assertCanManageRole` never gets in the way.
  findById.mockImplementation(async (id: string) =>
    id === TEST_ADMIN_ID
      ? activeAdminRow({ role: { key: "SUPER_ADMIN", name: "Super Admin" } })
      : targetRow()
  );
  grantPermissions(perms, [PERMISSIONS.ADMINS_MANAGE]);
  repo.countActiveWithPermission.mockResolvedValue(5);
  rbac.getPermissionKeysForRole.mockResolvedValue(ROLE_KEYS_GRANTED);
  rbac.getPermissionKeysForAdmin.mockResolvedValue(ROLE_KEYS_GRANTED);
  rbac.listOverridesForAdmin.mockResolvedValue([]);
  rbac.findPermissionsByKeys.mockImplementation(async (keys: string[]) =>
    CATALOGUE.filter((p) => keys.includes(p.key))
  );
});

describe("PATCH /v1/admin-accounts/:adminId/permissions", () => {
  it("persists ZERO override rows when the grid matches the role baseline", async () => {
    const res = await request(app)
      .patch(URL)
      .set(auth())
      .send({ permissions: ROLE_KEYS_GRANTED });

    expect(res.status).toBe(200);
    expect(rbac.replaceOverridesForAdmin).toHaveBeenCalledWith(TARGET_ID, []);
  });

  it("stores exactly one allow row for a key the role does not grant", async () => {
    const res = await request(app)
      .patch(URL)
      .set(auth())
      .send({ permissions: [...ROLE_KEYS_GRANTED, PERMISSIONS.REPORTS_READ] });

    expect(res.status).toBe(200);
    expect(rbac.replaceOverridesForAdmin).toHaveBeenCalledWith(TARGET_ID, [
      { permissionId: "perm-reports", allow: true },
    ]);
  });

  it("stores exactly one deny row for a key the role grants", async () => {
    const res = await request(app)
      .patch(URL)
      .set(auth())
      .send({ permissions: [PERMISSIONS.DASHBOARD_READ] });

    expect(res.status).toBe(200);
    expect(rbac.replaceOverridesForAdmin).toHaveBeenCalledWith(TARGET_ID, [
      { permissionId: "perm-users", allow: false },
    ]);
  });

  it("returns 400 for an unknown permission key and persists nothing", async () => {
    const res = await request(app)
      .patch(URL)
      .set(auth())
      .send({ permissions: [PERMISSIONS.DASHBOARD_READ, "nope.invent"] });

    expect(res.status).toBe(400);
    expect(rbac.replaceOverridesForAdmin).not.toHaveBeenCalled();
  });

  it("returns 403 when an admin edits their own permissions", async () => {
    const res = await request(app)
      .patch(`/v1/admin-accounts/${TEST_ADMIN_ID}/permissions`)
      .set(auth())
      .send({ permissions: [] });

    expect(res.status).toBe(403);
    expect(rbac.replaceOverridesForAdmin).not.toHaveBeenCalled();
  });

  it("returns 409 when admins.manage would leave no active holder", async () => {
    findById.mockImplementation(async (id: string) =>
      id === TEST_ADMIN_ID
        ? activeAdminRow({ role: { key: "SUPER_ADMIN", name: "Super Admin" } })
        : targetRow({ role: { key: "SUPER_ADMIN", name: "Super Admin" } })
    );
    repo.countActiveWithPermission.mockResolvedValue(0);
    rbac.getPermissionKeysForRole.mockResolvedValue([
      PERMISSIONS.ADMINS_MANAGE,
    ]);
    rbac.getPermissionKeysForAdmin.mockResolvedValue([
      PERMISSIONS.ADMINS_MANAGE,
    ]);

    const res = await request(app)
      .patch(URL)
      .set(auth())
      .send({ permissions: [] });

    expect(res.status).toBe(409);
    expect(rbac.replaceOverridesForAdmin).not.toHaveBeenCalled();
  });
});
