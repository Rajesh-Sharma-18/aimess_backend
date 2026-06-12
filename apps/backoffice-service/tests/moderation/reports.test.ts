/**
 * Reports & Moderation admin API (self-prefixed at /v1/reports/*).
 * Reads require `reports.read`; mutations require `reports.action`.
 * Covers list/detail/evidence/history/related + resolve/dismiss + bulk, the
 * RBAC split (read-only admin can list but not resolve), the 404 on a missing
 * report, the list/body Zod matrices, and an IDOR-shaped reportId.
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
    moderationService: {
      listReports: jest.fn(),
      getReportCore: jest.fn(),
      listReportEvidence: jest.fn(),
      listReportHistory: jest.fn(),
      listReportRelated: jest.fn(),
      resolveReport: jest.fn(),
      dismissReport: jest.fn(),
      bulkResolve: jest.fn(),
      bulkDismiss: jest.fn(),
    },
  };
});

import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { moderationService } from "../../src/services/index.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = moderationService as unknown as Record<string, jest.Mock>;

const PAGE = {
  data: [{ reportId: "RPT-2026-0000001", status: "PENDING" }],
  pagination: { mode: "offset", page: 1, limit: 20, total: 1 },
};
const RESULT = { status: "RESOLVED", resolution: "ACTION_TAKEN" };
const BULK = { requested: 2, succeeded: 2, failed: 0, results: [] };
const auth = () => bearer(makeAdminAccessToken());

beforeEach(() => {
  configureActiveAdmin(findById);
  grantPermissions(perms, [
    PERMISSIONS.REPORTS_READ,
    PERMISSIONS.REPORTS_ACTION,
  ]);
  svc.listReports.mockResolvedValue(PAGE);
  svc.getReportCore.mockResolvedValue({
    reportId: "RPT-2026-0000001",
    status: "PENDING",
  });
  svc.listReportEvidence.mockResolvedValue(PAGE);
  svc.listReportHistory.mockResolvedValue(PAGE);
  svc.listReportRelated.mockResolvedValue(PAGE);
  svc.resolveReport.mockResolvedValue(RESULT);
  svc.dismissReport.mockResolvedValue({ status: "DISMISSED" });
  svc.bulkResolve.mockResolvedValue(BULK);
  svc.bulkDismiss.mockResolvedValue(BULK);
});

describe("GET /v1/reports", () => {
  it("returns 200 with the paginated list", async () => {
    const res = await request(app).get("/v1/reports").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toBeDefined();
  });

  it("passes through filters + sort", async () => {
    const res = await request(app)
      .get(
        "/v1/reports?status=PENDING&reportType=SPAM&sort=createdAt:asc&page=2&limit=5"
      )
      .set(auth());
    expect(res.status).toBe(200);
    const arg = svc.listReports.mock.calls[0][0];
    expect(arg.status).toEqual(["PENDING"]);
    expect(arg.reportType).toEqual(["SPAM"]);
    expect(arg.sort).toBe("createdAt:asc");
    expect(arg.page).toBe(2);
    expect(arg.limit).toBe(5);
  });

  it("accepts a repeated status param → array", async () => {
    const res = await request(app)
      .get("/v1/reports?status=PENDING&status=RESOLVED")
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listReports.mock.calls[0][0].status).toEqual([
      "PENDING",
      "RESOLVED",
    ]);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/reports");
    expect(res.status).toBe(401);
  });

  it("returns 403 when the admin lacks reports.read", async () => {
    grantPermissions(perms, []);
    const res = await request(app).get("/v1/reports").set(auth());
    expect(res.status).toBe(403);
    expect(svc.listReports).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid status enum", "status=NOPE"],
    ["invalid reportType enum", "reportType=FOO"],
    ["malformed sort token", "sort=createdAt"],
    ["limit over max", "limit=500"],
    ["page below 1", "page=0"],
    ["invalid dateFrom", "dateFrom=2026-13-40"],
  ])("returns 400 for %s", async (_label, qs) => {
    const res = await request(app).get(`/v1/reports?${qs}`).set(auth());
    expect(res.status).toBe(400);
    expect(svc.listReports).not.toHaveBeenCalled();
  });
});

describe("GET /v1/reports/:reportId", () => {
  it("returns 200 with the report core", async () => {
    const res = await request(app)
      .get("/v1/reports/RPT-2026-0000001")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.reportId).toBe("RPT-2026-0000001");
  });

  it("returns 404 when the report does not exist", async () => {
    svc.getReportCore.mockResolvedValue(null);
    const res = await request(app)
      .get("/v1/reports/RPT-DOES-NOT-EXIST")
      .set(auth());
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for an over-length reportId (>64 chars)", async () => {
    const res = await request(app)
      .get(`/v1/reports/${"x".repeat(65)}`)
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("safely handles a path-traversal/injection-shaped reportId (no crash)", async () => {
    svc.getReportCore.mockResolvedValue(null);
    const res = await request(app)
      .get(`/v1/reports/${encodeURIComponent("'; DROP TABLE--")}`)
      .set(auth());
    // Treated as an ordinary (not-found) id, never executed.
    expect([404, 400]).toContain(res.status);
  });
});

describe("report sub-resources (evidence / history / related)", () => {
  it.each([
    ["evidence", "listReportEvidence"],
    ["history", "listReportHistory"],
    ["related", "listReportRelated"],
  ])("GET /v1/reports/:id/%s → 200", async (sub, method) => {
    const res = await request(app)
      .get(`/v1/reports/RPT-2026-0000001/${sub}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc[method]).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for an invalid page on a sub-resource", async () => {
    const res = await request(app)
      .get("/v1/reports/RPT-2026-0000001/evidence?limit=999")
      .set(auth());
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/reports/:reportId/resolve", () => {
  it("resolves a report → 200", async () => {
    const res = await request(app)
      .post("/v1/reports/RPT-2026-0000001/resolve")
      .set(auth())
      .send({ resolution: "ACTION_TAKEN" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("RESOLVED");
    expect(svc.resolveReport).toHaveBeenCalledTimes(1);
  });

  it("returns 403 with reports.read only (no reports.action)", async () => {
    grantPermissions(perms, [PERMISSIONS.REPORTS_READ]);
    const res = await request(app)
      .post("/v1/reports/RPT-2026-0000001/resolve")
      .set(auth())
      .send({ resolution: "ACTION_TAKEN" });
    expect(res.status).toBe(403);
    expect(svc.resolveReport).not.toHaveBeenCalled();
  });

  it.each([
    ["missing resolution", {}],
    ["invalid resolution enum", { resolution: "MADE_UP" }],
    [
      "invalid actionOnReportedUser",
      {
        resolution: "ACTION_TAKEN",
        actionOnReportedUser: "NUKE",
      },
    ],
    [
      "note over max length",
      {
        resolution: "ACTION_TAKEN",
        note: "x".repeat(2001),
      },
    ],
  ])("returns 400 for %s", async (_label, body) => {
    const res = await request(app)
      .post("/v1/reports/RPT-2026-0000001/resolve")
      .set(auth())
      .send(body);
    expect(res.status).toBe(400);
    expect(svc.resolveReport).not.toHaveBeenCalled();
  });
});

describe("POST /v1/reports/:reportId/dismiss", () => {
  it("dismisses a report → 200", async () => {
    const res = await request(app)
      .post("/v1/reports/RPT-2026-0000001/dismiss")
      .set(auth())
      .send({ reason: "NO_VIOLATION" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("DISMISSED");
  });

  it("returns 400 for an invalid dismiss reason", async () => {
    const res = await request(app)
      .post("/v1/reports/RPT-2026-0000001/dismiss")
      .set(auth())
      .send({ reason: "BECAUSE" });
    expect(res.status).toBe(400);
  });
});

describe("bulk report actions (207 Multi-Status)", () => {
  it("POST /v1/reports/bulk/resolve → 207", async () => {
    const res = await request(app)
      .post("/v1/reports/bulk/resolve")
      .set(auth())
      .send({ reportIds: ["RPT-1", "RPT-2"], resolution: "ACTION_TAKEN" });
    expect(res.status).toBe(207);
    expect(res.body.success).toBe(true);
    expect(svc.bulkResolve).toHaveBeenCalledTimes(1);
  });

  it("POST /v1/reports/bulk/dismiss → 207", async () => {
    const res = await request(app)
      .post("/v1/reports/bulk/dismiss")
      .set(auth())
      .send({ reportIds: ["RPT-1"], reason: "DUPLICATE" });
    expect(res.status).toBe(207);
    expect(svc.bulkDismiss).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty reportIds array", { reportIds: [], resolution: "ACTION_TAKEN" }],
    ["missing reportIds", { resolution: "ACTION_TAKEN" }],
    [
      "over 100 reportIds",
      {
        reportIds: Array.from({ length: 101 }, (_, i) => `RPT-${i}`),
        resolution: "ACTION_TAKEN",
      },
    ],
  ])("bulk/resolve returns 400 for %s", async (_label, body) => {
    const res = await request(app)
      .post("/v1/reports/bulk/resolve")
      .set(auth())
      .send(body);
    expect(res.status).toBe(400);
    expect(svc.bulkResolve).not.toHaveBeenCalled();
  });

  it("bulk routes are matched before /:reportId (bulk is not captured as an id)", async () => {
    // If "bulk" were captured as :reportId, this would call getReportCore.
    await request(app)
      .post("/v1/reports/bulk/resolve")
      .set(auth())
      .send({ reportIds: ["RPT-1"], resolution: "ACTION_TAKEN" });
    expect(svc.getReportCore).not.toHaveBeenCalled();
    expect(svc.bulkResolve).toHaveBeenCalledTimes(1);
  });
});
