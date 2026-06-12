/**
 * Authenticated admin routes: POST /v1/auth/logout and GET /v1/me. Proves the
 * `adminAuth` JWT seam end-to-end (valid / missing / malformed / expired /
 * forged) and the active-admin gate (non-ACTIVE → 401). The service layer is
 * mocked so the controller envelopes are asserted in isolation.
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
    adminAuthService: {
      logout: jest.fn(async () => undefined),
      getMe: jest.fn(),
    },
  };
});

import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { adminAuthService } from "../../src/services/index.js";
import {
  bearer,
  makeAdminAccessToken,
  makeExpiredAdminAccessToken,
  makeForgedAdminAccessToken,
  makeWrongTypeAdminToken,
} from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = adminAuthService as unknown as {
  logout: jest.Mock;
  getMe: jest.Mock;
};

beforeEach(() => {
  configureActiveAdmin(findById);
  grantPermissions(perms, []);
  svc.logout.mockResolvedValue(undefined);
  svc.getMe.mockResolvedValue({
    id: "admin-1",
    email: "admin@aimess.local",
    name: "Admin One",
    avatarUrl: "https://cdn/a.png",
    role: "ADMIN",
    status: "ACTIVE",
    lastLoginAt: null,
    permissions: ["dashboard.read"],
  });
});

describe("POST /v1/auth/logout (admin auth required)", () => {
  it("returns 200 and revokes the session with a valid admin token", async () => {
    const res = await request(app)
      .post("/v1/auth/logout")
      .set(bearer(makeAdminAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.loggedOut).toBe(true);
    expect(svc.logout).toHaveBeenCalledTimes(1);
  });

  it("returns 401 with no Authorization header", async () => {
    const res = await request(app).post("/v1/auth/logout");
    expect(res.status).toBe(401);
    expect(svc.logout).not.toHaveBeenCalled();
  });

  it("returns 401 for a malformed Authorization header", async () => {
    const res = await request(app)
      .post("/v1/auth/logout")
      .set({ Authorization: "Token abc.def" });
    expect(res.status).toBe(401);
    expect(svc.logout).not.toHaveBeenCalled();
  });

  it("returns 401 for an expired admin token", async () => {
    const res = await request(app)
      .post("/v1/auth/logout")
      .set(bearer(makeExpiredAdminAccessToken()));
    expect(res.status).toBe(401);
    expect(svc.logout).not.toHaveBeenCalled();
  });

  it("returns 401 for a forged (wrong-secret) admin token", async () => {
    const res = await request(app)
      .post("/v1/auth/logout")
      .set(bearer(makeForgedAdminAccessToken()));
    expect(res.status).toBe(401);
    expect(svc.logout).not.toHaveBeenCalled();
  });

  it("returns 401 for a token with the wrong type claim (not admin_access)", async () => {
    // Correctly signed with the admin secret but `type` is not "admin_access" —
    // verifyAdminAccessToken rejects it before any session/admin lookup.
    const res = await request(app)
      .post("/v1/auth/logout")
      .set(bearer(makeWrongTypeAdminToken()));
    expect(res.status).toBe(401);
    expect(svc.logout).not.toHaveBeenCalled();
  });

  it("returns 401 when the admin account is no longer ACTIVE", async () => {
    configureActiveAdmin(findById, { status: "SUSPENDED" });
    const res = await request(app)
      .post("/v1/auth/logout")
      .set(bearer(makeAdminAccessToken()));
    expect(res.status).toBe(401);
    expect(svc.logout).not.toHaveBeenCalled();
  });

  it("returns 401 when the admin record no longer exists", async () => {
    findById.mockResolvedValue(null);
    const res = await request(app)
      .post("/v1/auth/logout")
      .set(bearer(makeAdminAccessToken()));
    expect(res.status).toBe(401);
    expect(svc.logout).not.toHaveBeenCalled();
  });
});

describe("GET /v1/me (admin auth required)", () => {
  it("returns 200 with the resolved profile + permissions", async () => {
    const res = await request(app)
      .get("/v1/me")
      .set(bearer(makeAdminAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe("admin@aimess.local");
    expect(svc.getMe).toHaveBeenCalledTimes(1);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/me");
    expect(res.status).toBe(401);
    expect(svc.getMe).not.toHaveBeenCalled();
  });
});
