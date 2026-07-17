/**
 * System Maintenance admin API (POST /v1/system/friendships/disconnect-all).
 * Asserts the happy path + response envelope, the auth gate (401), the RBAC
 * gate (403 without `settings.manage`), and the `confirm: true` body
 * validator (400 when omitted/false) — this is a platform-wide destructive
 * action, so every one of its guards gets its own case. The service itself
 * (gRPC call + audit log) is mocked here — covered by
 * system-maintenance.service.test.ts.
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
    systemMaintenanceService: {
      disconnectAllFriendships: jest.fn(),
    },
  };
});

import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { systemMaintenanceService } from "../../src/services/index.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = systemMaintenanceService as unknown as {
  disconnectAllFriendships: jest.Mock;
};

const URL = "/v1/system/friendships/disconnect-all";

beforeEach(() => {
  jest.clearAllMocks();
  configureActiveAdmin(findById);
  grantPermissions(perms, [PERMISSIONS.SETTINGS_MANAGE]);
  svc.disconnectAllFriendships.mockResolvedValue({
    friendshipsDisconnected: 42,
    usersAffected: 30,
  });
});

describe("POST /v1/system/friendships/disconnect-all", () => {
  it("confirm: true → 200 with the sweep result, service called once with the admin's id", async () => {
    const res = await request(app)
      .post(URL)
      .set(bearer(makeAdminAccessToken()))
      .send({ confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      friendshipsDisconnected: 42,
      usersAffected: 30,
    });
    expect(svc.disconnectAllFriendships).toHaveBeenCalledTimes(1);
  });

  it("no auth header → 401, service never called", async () => {
    const res = await request(app).post(URL).send({ confirm: true });
    expect(res.status).toBe(401);
    expect(svc.disconnectAllFriendships).not.toHaveBeenCalled();
  });

  it("admin lacks settings.manage → 403, service never called", async () => {
    grantPermissions(perms, []);
    const res = await request(app)
      .post(URL)
      .set(bearer(makeAdminAccessToken()))
      .send({ confirm: true });

    expect(res.status).toBe(403);
    expect(svc.disconnectAllFriendships).not.toHaveBeenCalled();
  });

  it("confirm omitted → 400, service never called (blast-radius trip-wire)", async () => {
    const res = await request(app)
      .post(URL)
      .set(bearer(makeAdminAccessToken()))
      .send({});

    expect(res.status).toBe(400);
    expect(svc.disconnectAllFriendships).not.toHaveBeenCalled();
  });

  it("confirm: false → 400, service never called", async () => {
    const res = await request(app)
      .post(URL)
      .set(bearer(makeAdminAccessToken()))
      .send({ confirm: false });

    expect(res.status).toBe(400);
    expect(svc.disconnectAllFriendships).not.toHaveBeenCalled();
  });
});
