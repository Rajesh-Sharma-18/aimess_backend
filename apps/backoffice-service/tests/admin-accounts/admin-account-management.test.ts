/**
 * Admin Accounts admin API (self-prefixed at /v1/admin-accounts/*). Requires
 * `admins.manage`. Covers CRUD (create/update/list/details), activate/
 * deactivate, and permission management (catalogue + per-admin + role
 * reassignment). Mirrors the pattern in categories/category-management.test.ts.
 */
jest.mock("../../src/repositories/index.js", () => ({
  adminUserRepository: { findById: jest.fn() },
}));
jest.mock("../../src/lib/admin-perms-cache.js", () => ({
  getCachedAdminPermissions: jest.fn(async () => [] as string[]),
  invalidateAdminPermissions: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/index.js", () => {
  const actual = jest.requireActual("../../src/services/index.js");
  return {
    __esModule: true,
    ...actual,
    adminAccountService: {
      listAdminAccounts: jest.fn(),
      createAdminAccount: jest.fn(),
      getAdminAccount: jest.fn(),
      updateAdminAccount: jest.fn(),
      activateAdminAccount: jest.fn(),
      deactivateAdminAccount: jest.fn(),
      updateAdminAccountStatus: jest.fn(),
      listPermissions: jest.fn(),
      getAdminPermissions: jest.fn(),
      updateAdminPermissions: jest.fn(),
    },
  };
});

import { ConflictError, ForbiddenError, NotFoundError } from "@aimess/errors";
import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { adminAccountService } from "../../src/services/index.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import {
  bearer,
  makeAdminAccessToken,
  TEST_ADMIN_ID,
} from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = adminAccountService as unknown as Record<string, jest.Mock>;

const OTHER_ADMIN = "55555555-5555-4555-8555-555555555555";

const adminDetail = (over: Record<string, unknown> = {}) => ({
  id: OTHER_ADMIN,
  email: "moderator@aimess.local",
  name: "Mod One",
  avatarUrl: "",
  role: { key: "MODERATOR", name: "Moderator" },
  status: "ACTIVE",
  lastLoginAt: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

const PAGE = {
  data: [adminDetail()],
  pagination: {
    page: 1,
    limit: 20,
    total: 1,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  },
};

const auth = () => bearer(makeAdminAccessToken());

beforeEach(() => {
  jest.clearAllMocks();
  configureActiveAdmin(findById);
  grantPermissions(perms, [PERMISSIONS.ADMINS_MANAGE]);
  svc.listAdminAccounts.mockResolvedValue(PAGE);
  svc.createAdminAccount.mockResolvedValue(adminDetail());
  svc.getAdminAccount.mockResolvedValue(adminDetail());
  svc.updateAdminAccount.mockResolvedValue(adminDetail({ name: "Renamed" }));
  svc.activateAdminAccount.mockResolvedValue(adminDetail({ status: "ACTIVE" }));
  svc.deactivateAdminAccount.mockResolvedValue(
    adminDetail({ status: "DISABLED" })
  );
  svc.updateAdminAccountStatus.mockResolvedValue(
    adminDetail({ status: "ACTIVE" })
  );
  svc.listPermissions.mockResolvedValue([
    { key: "dashboard.read", group: "dashboard" },
    { key: "admins.manage", group: "admins" },
  ]);
  svc.getAdminPermissions.mockResolvedValue({
    adminId: OTHER_ADMIN,
    role: { key: "MODERATOR", name: "Moderator" },
    permissions: ["dashboard.read", "users.read"],
  });
  svc.updateAdminPermissions.mockResolvedValue({
    adminId: OTHER_ADMIN,
    role: { key: "ADMIN", name: "Admin" },
    permissions: ["dashboard.read", "users.moderate"],
  });
});

describe("GET /v1/admin-accounts", () => {
  it("returns 200 with the list + pagination", async () => {
    const res = await request(app).get("/v1/admin-accounts").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });

  it("forwards search/status/roleKey/sort/pagination to the service", async () => {
    await request(app)
      .get(
        "/v1/admin-accounts?search=mod&status=ACTIVE&roleKey=MODERATOR&sort=name:desc&page=2&limit=10"
      )
      .set(auth());
    const arg = svc.listAdminAccounts.mock.calls[0][0];
    expect(arg.search).toBe("mod");
    expect(arg.status).toBe("ACTIVE");
    expect(arg.roleKey).toBe("MODERATOR");
    expect(arg.sort).toBe("name:desc");
    expect(arg.page).toBe(2);
    expect(arg.limit).toBe(10);
  });

  it("passes the caller so their own row (and SUPER_ADMINs) are excluded", async () => {
    await request(app).get("/v1/admin-accounts").set(auth());
    expect(svc.listAdminAccounts.mock.calls[0][1].id).toBe(TEST_ADMIN_ID);
  });

  it("returns 400 for an invalid roleKey", async () => {
    const res = await request(app)
      .get("/v1/admin-accounts?roleKey=NOT_A_ROLE")
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("forwards fromDate/toDate and sortBy/sortOrder as the combined sort", async () => {
    await request(app)
      .get(
        "/v1/admin-accounts?fromDate=1700000000000&toDate=1800000000000&sortBy=username&sortOrder=asc"
      )
      .set(auth());
    const arg = svc.listAdminAccounts.mock.calls[0][0];
    expect(arg.fromDate).toBe(1700000000000);
    expect(arg.toDate).toBe(1800000000000);
    expect(arg.sort).toBe("name:asc");
  });

  it("maps status=INACTIVE to the internal DISABLED filter", async () => {
    await request(app).get("/v1/admin-accounts?status=INACTIVE").set(auth());
    const arg = svc.listAdminAccounts.mock.calls[0][0];
    expect(arg.status).toBe("DISABLED");
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/admin-accounts");
    expect(res.status).toBe(401);
  });

  it("returns 403 without admins.manage", async () => {
    grantPermissions(perms, []);
    const res = await request(app).get("/v1/admin-accounts").set(auth());
    expect(res.status).toBe(403);
    expect(svc.listAdminAccounts).not.toHaveBeenCalled();
  });
});

describe("POST /v1/admin-accounts (create)", () => {
  const validBody = {
    email: "new.admin@aimess.local",
    password: "Str0ng!Pass",
    name: "New Admin",
    roleKey: "MODERATOR",
  };

  it("creates → 201", async () => {
    const res = await request(app)
      .post("/v1/admin-accounts")
      .set(auth())
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(OTHER_ADMIN);
    expect(svc.createAdminAccount).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for an invalid email", async () => {
    const res = await request(app)
      .post("/v1/admin-accounts")
      .set(auth())
      .send({ ...validBody, email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(svc.createAdminAccount).not.toHaveBeenCalled();
  });

  it("accepts `username` as an alias for `name`", async () => {
    const { name, ...withoutName } = validBody;
    const res = await request(app)
      .post("/v1/admin-accounts")
      .set(auth())
      .send({ ...withoutName, username: "New Admin" });
    expect(res.status).toBe(201);
    const body = svc.createAdminAccount.mock.calls[0][0];
    expect(body.name).toBe("New Admin");
  });

  it("defaults roleKey to ADMIN when omitted", async () => {
    const { roleKey, ...withoutRole } = validBody;
    const res = await request(app)
      .post("/v1/admin-accounts")
      .set(auth())
      .send(withoutRole);
    expect(res.status).toBe(201);
    expect(svc.createAdminAccount.mock.calls[0][0].roleKey).toBe("ADMIN");
  });

  it("returns 409 when the username is already taken", async () => {
    svc.createAdminAccount.mockRejectedValue(
      new ConflictError("ADMIN_USERNAME_TAKEN")
    );
    const res = await request(app)
      .post("/v1/admin-accounts")
      .set(auth())
      .send(validBody);
    expect(res.status).toBe(409);
  });

  it("returns 400 for a weak password", async () => {
    const res = await request(app)
      .post("/v1/admin-accounts")
      .set(auth())
      .send({ ...validBody, password: "weak" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid roleKey", async () => {
    const res = await request(app)
      .post("/v1/admin-accounts")
      .set(auth())
      .send({ ...validBody, roleKey: "OWNER" });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the email is already taken", async () => {
    svc.createAdminAccount.mockRejectedValue(
      new ConflictError("ADMIN_EMAIL_TAKEN")
    );
    const res = await request(app)
      .post("/v1/admin-accounts")
      .set(auth())
      .send(validBody);
    expect(res.status).toBe(409);
  });

  it("returns 403 when a non-SUPER_ADMIN tries to grant SUPER_ADMIN", async () => {
    svc.createAdminAccount.mockRejectedValue(
      new ForbiddenError("ADMIN_FORBIDDEN")
    );
    const res = await request(app)
      .post("/v1/admin-accounts")
      .set(auth())
      .send({ ...validBody, roleKey: "SUPER_ADMIN" });
    expect(res.status).toBe(403);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).post("/v1/admin-accounts").send(validBody);
    expect(res.status).toBe(401);
  });

  it("returns 403 without admins.manage", async () => {
    grantPermissions(perms, []);
    const res = await request(app)
      .post("/v1/admin-accounts")
      .set(auth())
      .send(validBody);
    expect(res.status).toBe(403);
    expect(svc.createAdminAccount).not.toHaveBeenCalled();
  });
});

describe("GET /v1/admin-accounts/:adminId (details)", () => {
  it("returns 200 with the admin detail", async () => {
    const res = await request(app)
      .get(`/v1/admin-accounts/${OTHER_ADMIN}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(OTHER_ADMIN);
  });

  it("returns 404 when the admin does not exist", async () => {
    svc.getAdminAccount.mockRejectedValue(new NotFoundError("ADMIN_NOT_FOUND"));
    const res = await request(app)
      .get(`/v1/admin-accounts/${OTHER_ADMIN}`)
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid adminId param", async () => {
    const res = await request(app)
      .get("/v1/admin-accounts/not-a-uuid")
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get(`/v1/admin-accounts/${OTHER_ADMIN}`);
    expect(res.status).toBe(401);
  });
});

describe("PATCH /v1/admin-accounts/:adminId (update)", () => {
  it("updates name → 200", async () => {
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}`)
      .set(auth())
      .send({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Renamed");
  });

  it("updates email → 200", async () => {
    svc.updateAdminAccount.mockResolvedValue(
      adminDetail({ email: "renamed@aimess.local" })
    );
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}`)
      .set(auth())
      .send({ email: "renamed@aimess.local" });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe("renamed@aimess.local");
  });

  it("returns 409 when the email is already taken", async () => {
    svc.updateAdminAccount.mockRejectedValue(
      new ConflictError("ADMIN_EMAIL_TAKEN")
    );
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}`)
      .set(auth())
      .send({ email: "taken@aimess.local" });
    expect(res.status).toBe(409);
  });

  it("returns 400 with an empty body", async () => {
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
    expect(svc.updateAdminAccount).not.toHaveBeenCalled();
  });

  it("returns 404 when the admin does not exist", async () => {
    svc.updateAdminAccount.mockRejectedValue(
      new NotFoundError("ADMIN_NOT_FOUND")
    );
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}`)
      .set(auth())
      .send({ name: "Renamed" });
    expect(res.status).toBe(404);
  });

  it("returns 403 without admins.manage", async () => {
    grantPermissions(perms, []);
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}`)
      .set(auth())
      .send({ name: "Renamed" });
    expect(res.status).toBe(403);
    expect(svc.updateAdminAccount).not.toHaveBeenCalled();
  });
});

describe("POST /v1/admin-accounts/:adminId/activate", () => {
  it("activates → 200", async () => {
    const res = await request(app)
      .post(`/v1/admin-accounts/${OTHER_ADMIN}/activate`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ACTIVE");
  });

  it("returns 409 when already active", async () => {
    svc.activateAdminAccount.mockRejectedValue(
      new ConflictError("ADMIN_ALREADY_ACTIVE")
    );
    const res = await request(app)
      .post(`/v1/admin-accounts/${OTHER_ADMIN}/activate`)
      .set(auth());
    expect(res.status).toBe(409);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).post(
      `/v1/admin-accounts/${OTHER_ADMIN}/activate`
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/admin-accounts/:adminId/deactivate", () => {
  it("deactivates → 200", async () => {
    const res = await request(app)
      .post(`/v1/admin-accounts/${OTHER_ADMIN}/deactivate`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("DISABLED");
  });

  it("returns 403 when self-deactivating", async () => {
    svc.deactivateAdminAccount.mockRejectedValue(
      new ForbiddenError("ADMIN_CANNOT_DEACTIVATE_SELF")
    );
    const res = await request(app)
      .post(`/v1/admin-accounts/${TEST_ADMIN_ID}/deactivate`)
      .set(auth());
    expect(res.status).toBe(403);
  });

  it("returns 409 when already inactive", async () => {
    svc.deactivateAdminAccount.mockRejectedValue(
      new ConflictError("ADMIN_ALREADY_INACTIVE")
    );
    const res = await request(app)
      .post(`/v1/admin-accounts/${OTHER_ADMIN}/deactivate`)
      .set(auth());
    expect(res.status).toBe(409);
  });

  it("returns 403 without admins.manage", async () => {
    grantPermissions(perms, []);
    const res = await request(app)
      .post(`/v1/admin-accounts/${OTHER_ADMIN}/deactivate`)
      .set(auth());
    expect(res.status).toBe(403);
    expect(svc.deactivateAdminAccount).not.toHaveBeenCalled();
  });
});

describe("PATCH /v1/admin-accounts/:adminId/status", () => {
  it("sets status ACTIVE → 200", async () => {
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}/status`)
      .set(auth())
      .send({ status: "ACTIVE" });
    expect(res.status).toBe(200);
    expect(svc.updateAdminAccountStatus).toHaveBeenCalledWith(
      OTHER_ADMIN,
      { status: "ACTIVE" },
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("sets status INACTIVE → 200", async () => {
    svc.updateAdminAccountStatus.mockResolvedValue(
      adminDetail({ status: "DISABLED" })
    );
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}/status`)
      .set(auth())
      .send({ status: "INACTIVE" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("DISABLED");
  });

  it("returns 400 for an invalid status value", async () => {
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}/status`)
      .set(auth())
      .send({ status: "DISABLED" });
    expect(res.status).toBe(400);
    expect(svc.updateAdminAccountStatus).not.toHaveBeenCalled();
  });

  it("returns 409 when deactivating the last Super Admin", async () => {
    svc.updateAdminAccountStatus.mockRejectedValue(
      new ConflictError("ADMIN_CANNOT_DEACTIVATE_LAST_SUPER_ADMIN")
    );
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}/status`)
      .set(auth())
      .send({ status: "INACTIVE" });
    expect(res.status).toBe(409);
  });

  it("returns 403 when self-deactivating", async () => {
    svc.updateAdminAccountStatus.mockRejectedValue(
      new ForbiddenError("ADMIN_CANNOT_DEACTIVATE_SELF")
    );
    const res = await request(app)
      .patch(`/v1/admin-accounts/${TEST_ADMIN_ID}/status`)
      .set(auth())
      .send({ status: "INACTIVE" });
    expect(res.status).toBe(403);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}/status`)
      .send({ status: "ACTIVE" });
    expect(res.status).toBe(401);
  });

  it("returns 403 without admins.manage", async () => {
    grantPermissions(perms, []);
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}/status`)
      .set(auth())
      .send({ status: "ACTIVE" });
    expect(res.status).toBe(403);
    expect(svc.updateAdminAccountStatus).not.toHaveBeenCalled();
  });
});

describe("GET /v1/admin-accounts/permissions (catalogue)", () => {
  it("returns 200 with the permission catalogue", async () => {
    const res = await request(app)
      .get("/v1/admin-accounts/permissions")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      expect.arrayContaining([{ key: "admins.manage", group: "admins" }])
    );
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/admin-accounts/permissions");
    expect(res.status).toBe(401);
  });

  it("returns 403 without admins.manage", async () => {
    grantPermissions(perms, []);
    const res = await request(app)
      .get("/v1/admin-accounts/permissions")
      .set(auth());
    expect(res.status).toBe(403);
    expect(svc.listPermissions).not.toHaveBeenCalled();
  });
});

describe("GET /v1/admin-accounts/:adminId/permissions", () => {
  it("returns 200 with the resolved permission set", async () => {
    const res = await request(app)
      .get(`/v1/admin-accounts/${OTHER_ADMIN}/permissions`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.role.key).toBe("MODERATOR");
    expect(res.body.data.permissions).toContain("users.read");
  });

  it("returns 404 when the admin does not exist", async () => {
    svc.getAdminPermissions.mockRejectedValue(
      new NotFoundError("ADMIN_NOT_FOUND")
    );
    const res = await request(app)
      .get(`/v1/admin-accounts/${OTHER_ADMIN}/permissions`)
      .set(auth());
    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/admin-accounts/:adminId/permissions (role reassignment)", () => {
  it("updates the role → 200", async () => {
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}/permissions`)
      .set(auth())
      .send({ roleKey: "ADMIN" });
    expect(res.status).toBe(200);
    expect(res.body.data.role.key).toBe("ADMIN");
    expect(svc.updateAdminPermissions).toHaveBeenCalledWith(
      OTHER_ADMIN,
      { roleKey: "ADMIN" },
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("returns 400 for an invalid roleKey", async () => {
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}/permissions`)
      .set(auth())
      .send({ roleKey: "OWNER" });
    expect(res.status).toBe(400);
    expect(svc.updateAdminPermissions).not.toHaveBeenCalled();
  });

  it("returns 403 when a non-SUPER_ADMIN tries to grant SUPER_ADMIN", async () => {
    svc.updateAdminPermissions.mockRejectedValue(
      new ForbiddenError("ADMIN_FORBIDDEN")
    );
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}/permissions`)
      .set(auth())
      .send({ roleKey: "SUPER_ADMIN" });
    expect(res.status).toBe(403);
  });

  it("returns 404 when the admin does not exist", async () => {
    svc.updateAdminPermissions.mockRejectedValue(
      new NotFoundError("ADMIN_NOT_FOUND")
    );
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}/permissions`)
      .set(auth())
      .send({ roleKey: "ADMIN" });
    expect(res.status).toBe(404);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}/permissions`)
      .send({ roleKey: "ADMIN" });
    expect(res.status).toBe(401);
  });

  it("returns 403 without admins.manage", async () => {
    grantPermissions(perms, []);
    const res = await request(app)
      .patch(`/v1/admin-accounts/${OTHER_ADMIN}/permissions`)
      .set(auth())
      .send({ roleKey: "ADMIN" });
    expect(res.status).toBe(403);
    expect(svc.updateAdminPermissions).not.toHaveBeenCalled();
  });
});
