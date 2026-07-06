/**
 * System Health admin API (GET /v1/system-health). Asserts the happy path and
 * response envelope, the auth gate (401), and the RBAC gate (403 when
 * `systemhealth.read` is absent). The aggregation logic itself is covered by
 * system-health.service.test.ts — here the service is mocked so we exercise only
 * the route + controller wiring.
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
    systemHealthService: {
      getSystemHealth: jest.fn(),
    },
  };
});

import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { systemHealthService } from "../../src/services/index.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = systemHealthService as unknown as {
  getSystemHealth: jest.Mock;
};

const SAMPLE = {
  overall: "healthy",
  servicesUp: { up: 3, total: 3, label: "3/3" },
  lastUpdated: "2026-07-03T00:00:00.000Z",
  services: [
    {
      key: "auth",
      name: "Auth Service",
      status: "healthy",
      monitored: true,
      uptimePercent: 100,
      latencyMs: 12,
      breaker: null,
      lastChecked: "2026-07-03T00:00:00.000Z",
    },
  ],
  infrastructure: [
    {
      key: "database",
      name: "Database (PostgreSQL)",
      status: "healthy",
      metrics: { latencyMs: 3 },
      latencyMs: 3,
      lastChecked: "2026-07-03T00:00:00.000Z",
    },
  ],
};

beforeEach(() => {
  configureActiveAdmin(findById);
  grantPermissions(perms, [PERMISSIONS.SYSTEMHEALTH_READ]);
  svc.getSystemHealth.mockResolvedValue(SAMPLE);
});

describe("GET /v1/system-health", () => {
  it("returns 200 with the full system-health payload", async () => {
    const res = await request(app)
      .get("/v1/system-health")
      .set(bearer(makeAdminAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.overall).toBe("healthy");
    expect(res.body.data.servicesUp).toEqual({ up: 3, total: 3, label: "3/3" });
    expect(Array.isArray(res.body.data.services)).toBe(true);
    expect(Array.isArray(res.body.data.infrastructure)).toBe(true);
    expect(svc.getSystemHealth).toHaveBeenCalledTimes(1);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/system-health");
    expect(res.status).toBe(401);
    expect(svc.getSystemHealth).not.toHaveBeenCalled();
  });

  it("returns 403 when the admin lacks systemhealth.read", async () => {
    grantPermissions(perms, []); // no permissions
    const res = await request(app)
      .get("/v1/system-health")
      .set(bearer(makeAdminAccessToken()));

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(svc.getSystemHealth).not.toHaveBeenCalled();
  });
});
