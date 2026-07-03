/**
 * Audit Logs admin API (self-prefixed at /v1/audit-logs/*). Read-only; requires
 * `auditlogs.read`. Covers list pagination/search/action/date filters + invalid
 * query rejection + empty results, and detail (200 / 404 / invalid uuid), plus
 * the auth + permission gates.
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
    auditService: {
      record: jest.fn(),
      listAuditLogs: jest.fn(),
      getAuditLog: jest.fn(),
    },
  };
});

import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { auditService } from "../../src/services/index.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = auditService as unknown as Record<string, jest.Mock>;

const LOG_ID = "3f2b6c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";
const PERFORMER = {
  id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  name: "Admin One",
  email: "admin@aimess.local",
  avatarUrl: null,
};
const DETAIL = {
  id: LOG_ID,
  performer: PERFORMER,
  action: "user.banned",
  targetType: "user",
  targetId: "user-42",
  createdAt: "2026-07-01T00:00:00.000Z",
  reason: "Repeated spam",
  metadata: {
    before: { status: "ACTIVE" },
    after: { status: "BANNED", reason: "Repeated spam" },
    ip: "203.0.113.5",
    userAgent: "jest",
  },
};
const LIST_ITEM = {
  id: LOG_ID,
  performer: { id: PERFORMER.id, name: PERFORMER.name, avatarUrl: null },
  action: "user.banned",
  targetType: "user",
  targetId: "user-42",
  createdAt: "2026-07-01T00:00:00.000Z",
};
const PAGE = {
  data: [LIST_ITEM],
  pagination: {
    page: 1,
    limit: 20,
    total: 1,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  },
};
const EMPTY_PAGE = {
  data: [],
  pagination: {
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
    hasNext: false,
    hasPrev: false,
  },
};
const auth = () => bearer(makeAdminAccessToken());

beforeEach(() => {
  jest.clearAllMocks();
  configureActiveAdmin(findById);
  grantPermissions(perms, [PERMISSIONS.AUDITLOGS_READ]);
  svc.listAuditLogs.mockResolvedValue(PAGE);
  svc.getAuditLog.mockResolvedValue(DETAIL);
});

describe("GET /v1/audit-logs", () => {
  it("returns 200 with the list + pagination", async () => {
    const res = await request(app).get("/v1/audit-logs").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].action).toBe("user.banned");
    expect(res.body.pagination.total).toBe(1);
  });

  it("defaults to page 1 / limit 20 / createdAt:desc", async () => {
    await request(app).get("/v1/audit-logs").set(auth());
    const arg = svc.listAuditLogs.mock.calls[0][0];
    expect(arg.page).toBe(1);
    expect(arg.limit).toBe(20);
    expect(arg.sort).toBe("createdAt:desc");
  });

  it("forwards search / action / date / paging filters to the service", async () => {
    await request(app)
      .get(
        "/v1/audit-logs?search=admin&action=user.banned&action=user.suspended&dateFrom=2026-01-01&dateTo=2026-12-31&page=2&limit=50&sort=action:asc"
      )
      .set(auth());
    const arg = svc.listAuditLogs.mock.calls[0][0];
    expect(arg.search).toBe("admin");
    expect(arg.action).toEqual(["user.banned", "user.suspended"]);
    expect(arg.dateFrom).toBe("2026-01-01");
    expect(arg.dateTo).toBe("2026-12-31");
    expect(arg.page).toBe(2);
    expect(arg.limit).toBe(50);
    expect(arg.sort).toBe("action:asc");
  });

  it("coerces a single action param to a one-element array", async () => {
    await request(app).get("/v1/audit-logs?action=user.banned").set(auth());
    const arg = svc.listAuditLogs.mock.calls[0][0];
    expect(arg.action).toEqual(["user.banned"]);
  });

  it("returns 200 with an empty list when nothing matches", async () => {
    svc.listAuditLogs.mockResolvedValueOnce(EMPTY_PAGE);
    const res = await request(app)
      .get("/v1/audit-logs?search=nomatch")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/audit-logs");
    expect(res.status).toBe(401);
    expect(svc.listAuditLogs).not.toHaveBeenCalled();
  });

  it("returns 403 without auditlogs.read", async () => {
    grantPermissions(perms, []);
    const res = await request(app).get("/v1/audit-logs").set(auth());
    expect(res.status).toBe(403);
    expect(svc.listAuditLogs).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid sort token", "sort=performer:asc"],
    ["limit over max", "limit=500"],
    ["limit below min", "limit=0"],
    ["page below min", "page=0"],
    ["invalid date", "dateFrom=07-2026"],
  ])("returns 400 for %s", async (_label, qs) => {
    const res = await request(app).get(`/v1/audit-logs?${qs}`).set(auth());
    expect(res.status).toBe(400);
    expect(svc.listAuditLogs).not.toHaveBeenCalled();
  });
});

describe("GET /v1/audit-logs/:auditLogId", () => {
  it("returns 200 with the full detail (performer/action/target/reason/metadata)", async () => {
    const res = await request(app).get(`/v1/audit-logs/${LOG_ID}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(LOG_ID);
    expect(res.body.data.performer.email).toBe("admin@aimess.local");
    expect(res.body.data.reason).toBe("Repeated spam");
    expect(res.body.data.metadata.ip).toBe("203.0.113.5");
    expect(svc.getAuditLog).toHaveBeenCalledWith(LOG_ID);
  });

  it("returns 404 when the audit log is unknown", async () => {
    svc.getAuditLog.mockResolvedValueOnce(null);
    const res = await request(app).get(`/v1/audit-logs/${LOG_ID}`).set(auth());
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid uuid param", async () => {
    const res = await request(app).get("/v1/audit-logs/not-a-uuid").set(auth());
    expect(res.status).toBe(400);
    expect(svc.getAuditLog).not.toHaveBeenCalled();
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get(`/v1/audit-logs/${LOG_ID}`);
    expect(res.status).toBe(401);
  });

  it("returns 403 without auditlogs.read", async () => {
    grantPermissions(perms, []);
    const res = await request(app).get(`/v1/audit-logs/${LOG_ID}`).set(auth());
    expect(res.status).toBe(403);
    expect(svc.getAuditLog).not.toHaveBeenCalled();
  });
});
