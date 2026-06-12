/**
 * Dashboard admin API (GET /v1/dashboard/{overview,charts,service-status}).
 * Every route is admin-gated AND requires `dashboard.read`. Asserts: the happy
 * path, the auth gate (401), the RBAC gate (403 when the permission is absent),
 * and the `?period` enum validation on /charts.
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
    dashboardService: {
      getOverview: jest.fn(),
      getCharts: jest.fn(),
      getServiceStatus: jest.fn(),
    },
  };
});

import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { dashboardService } from "../../src/services/index.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = dashboardService as unknown as {
  getOverview: jest.Mock;
  getCharts: jest.Mock;
  getServiceStatus: jest.Mock;
};

beforeEach(() => {
  configureActiveAdmin(findById);
  grantPermissions(perms, [PERMISSIONS.DASHBOARD_READ]);
  svc.getOverview.mockResolvedValue({
    totalUsers: 10,
    activeUsers: 4,
    communities: 2,
    groups: 3,
  });
  svc.getCharts.mockResolvedValue({ series: [], donut: {} });
  svc.getServiceStatus.mockResolvedValue([{ service: "auth", status: "UP" }]);
});

describe("GET /v1/dashboard/overview", () => {
  it("returns 200 with the stat-card data", async () => {
    const res = await request(app)
      .get("/v1/dashboard/overview")
      .set(bearer(makeAdminAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalUsers).toBe(10);
    expect(svc.getOverview).toHaveBeenCalledTimes(1);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/dashboard/overview");
    expect(res.status).toBe(401);
    expect(svc.getOverview).not.toHaveBeenCalled();
  });

  it("returns 403 when the admin lacks dashboard.read", async () => {
    grantPermissions(perms, []); // no permissions
    const res = await request(app)
      .get("/v1/dashboard/overview")
      .set(bearer(makeAdminAccessToken()));

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(svc.getOverview).not.toHaveBeenCalled();
  });
});

describe("GET /v1/dashboard/charts", () => {
  it("returns 200 with the default period (monthly)", async () => {
    const res = await request(app)
      .get("/v1/dashboard/charts")
      .set(bearer(makeAdminAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(svc.getCharts).toHaveBeenCalledWith("monthly");
  });

  it.each(["daily", "weekly", "monthly"])(
    "accepts ?period=%s",
    async (period) => {
      const res = await request(app)
        .get(`/v1/dashboard/charts?period=${period}`)
        .set(bearer(makeAdminAccessToken()));

      expect(res.status).toBe(200);
      expect(svc.getCharts).toHaveBeenCalledWith(period);
    }
  );

  it("returns 400 for an invalid period enum", async () => {
    const res = await request(app)
      .get("/v1/dashboard/charts?period=hourly")
      .set(bearer(makeAdminAccessToken()));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(svc.getCharts).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed ?from datetime", async () => {
    const res = await request(app)
      .get("/v1/dashboard/charts?from=not-a-date")
      .set(bearer(makeAdminAccessToken()));
    expect(res.status).toBe(400);
  });

  it("returns 403 when the admin lacks dashboard.read", async () => {
    grantPermissions(perms, []);
    const res = await request(app)
      .get("/v1/dashboard/charts")
      .set(bearer(makeAdminAccessToken()));
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/dashboard/service-status", () => {
  it("returns 200 with the per-service health panel", async () => {
    const res = await request(app)
      .get("/v1/dashboard/service-status")
      .set(bearer(makeAdminAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/dashboard/service-status");
    expect(res.status).toBe(401);
  });

  it("returns 403 when the admin lacks dashboard.read", async () => {
    grantPermissions(perms, []);
    const res = await request(app)
      .get("/v1/dashboard/service-status")
      .set(bearer(makeAdminAccessToken()));
    expect(res.status).toBe(403);
  });
});
