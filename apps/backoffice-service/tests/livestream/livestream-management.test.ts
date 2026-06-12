/**
 * Livestream Management admin API (self-prefixed at /v1/livestreams/*).
 * Reads require `livestreams.read`; mutations require `livestreams.moderate`.
 * Covers list, detail (404), per-stream reports, end, bulk end, bulk
 * review-reports, the RBAC split, validation matrices, and bulk-before-:id.
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
    livestreamService: {
      listLivestreams: jest.fn(),
      getLivestream: jest.fn(),
      listLivestreamReports: jest.fn(),
      endLivestream: jest.fn(),
      bulkEnd: jest.fn(),
      bulkReviewReports: jest.fn(),
    },
  };
});

import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { livestreamService } from "../../src/services/index.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = livestreamService as unknown as Record<string, jest.Mock>;

const LID = "LS-2026-00001";
const PAGE = {
  data: [{ livestreamId: LID, status: "LIVE" }],
  pagination: { mode: "offset", page: 1, limit: 20, total: 1 },
};
const BULK = { requested: 2, succeeded: 2, failed: 0, results: [] };
const auth = () => bearer(makeAdminAccessToken());

beforeEach(() => {
  configureActiveAdmin(findById);
  grantPermissions(perms, [
    PERMISSIONS.LIVESTREAMS_READ,
    PERMISSIONS.LIVESTREAMS_MODERATE,
  ]);
  svc.listLivestreams.mockResolvedValue(PAGE);
  svc.getLivestream.mockResolvedValue({ livestreamId: LID, status: "LIVE" });
  svc.listLivestreamReports.mockResolvedValue(PAGE);
  svc.endLivestream.mockResolvedValue({ livestreamId: LID, status: "ENDED" });
  svc.bulkEnd.mockResolvedValue(BULK);
  svc.bulkReviewReports.mockResolvedValue(BULK);
});

describe("GET /v1/livestreams", () => {
  it("returns 200 with the list", async () => {
    const res = await request(app).get("/v1/livestreams").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("coerces hasReports + minReports filters", async () => {
    await request(app)
      .get("/v1/livestreams?hasReports=true&minReports=3")
      .set(auth());
    const arg = svc.listLivestreams.mock.calls[0][0];
    expect(arg.hasReports).toBe(true);
    expect(arg.minReports).toBe(3);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/livestreams");
    expect(res.status).toBe(401);
  });

  it("returns 403 without livestreams.read", async () => {
    grantPermissions(perms, []);
    const res = await request(app).get("/v1/livestreams").set(auth());
    expect(res.status).toBe(403);
  });

  it.each([
    ["invalid status enum", "status=PAUSED"],
    ["malformed sort token", "sort=viewerCount"],
    ["negative minReports", "minReports=-1"],
    ["limit over max", "limit=500"],
  ])("returns 400 for %s", async (_label, qs) => {
    const res = await request(app).get(`/v1/livestreams?${qs}`).set(auth());
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/livestreams/:livestreamId", () => {
  it("returns 200 with the detail", async () => {
    const res = await request(app).get(`/v1/livestreams/${LID}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.livestreamId).toBe(LID);
  });

  it("returns 404 when the livestream is unknown", async () => {
    svc.getLivestream.mockResolvedValue(null);
    const res = await request(app).get("/v1/livestreams/ghost").set(auth());
    expect(res.status).toBe(404);
  });

  it("GET /v1/livestreams/:id/reports → 200", async () => {
    const res = await request(app)
      .get(`/v1/livestreams/${LID}/reports`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listLivestreamReports).toHaveBeenCalledTimes(1);
  });

  it("per-stream reports reject an invalid status filter (400)", async () => {
    const res = await request(app)
      .get(`/v1/livestreams/${LID}/reports?status=NOPE`)
      .set(auth());
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/livestreams/:livestreamId/end", () => {
  it("ends a livestream → 200", async () => {
    const res = await request(app)
      .post(`/v1/livestreams/${LID}/end`)
      .set(auth())
      .send({ reasonCode: "POLICY_VIOLATION" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ENDED");
  });

  it("returns 403 with livestreams.read only", async () => {
    grantPermissions(perms, [PERMISSIONS.LIVESTREAMS_READ]);
    const res = await request(app)
      .post(`/v1/livestreams/${LID}/end`)
      .set(auth())
      .send({ reasonCode: "POLICY_VIOLATION" });
    expect(res.status).toBe(403);
    expect(svc.endLivestream).not.toHaveBeenCalled();
  });

  it.each([
    ["missing reasonCode", {}],
    ["invalid reasonCode enum", { reasonCode: "MEH" }],
    ["note over max", { reasonCode: "SPAM", note: "x".repeat(2001) }],
  ])("returns 400 for %s", async (_label, body) => {
    const res = await request(app)
      .post(`/v1/livestreams/${LID}/end`)
      .set(auth())
      .send(body);
    expect(res.status).toBe(400);
    expect(svc.endLivestream).not.toHaveBeenCalled();
  });
});

describe("bulk livestream actions (207)", () => {
  it("POST /v1/livestreams/bulk/end → 207", async () => {
    const res = await request(app)
      .post("/v1/livestreams/bulk/end")
      .set(auth())
      .send({ livestreamIds: [LID, "LS-2"], reasonCode: "MANUAL_ADMIN" });
    expect(res.status).toBe(207);
    expect(svc.bulkEnd).toHaveBeenCalledTimes(1);
  });

  it("POST /v1/livestreams/bulk/review-reports → 207", async () => {
    const res = await request(app)
      .post("/v1/livestreams/bulk/review-reports")
      .set(auth())
      .send({ reportIds: ["LSR-1"], status: "RESOLVED" });
    expect(res.status).toBe(207);
    expect(svc.bulkReviewReports).toHaveBeenCalledTimes(1);
  });

  it("bulk/review-reports rejects an invalid target status (400)", async () => {
    const res = await request(app)
      .post("/v1/livestreams/bulk/review-reports")
      .set(auth())
      .send({ reportIds: ["LSR-1"], status: "OPEN" }); // OPEN not a review target
    expect(res.status).toBe(400);
  });

  it("bulk path matched before /:livestreamId", async () => {
    await request(app)
      .post("/v1/livestreams/bulk/end")
      .set(auth())
      .send({ livestreamIds: [LID], reasonCode: "SPAM" });
    expect(svc.endLivestream).not.toHaveBeenCalled();
    expect(svc.bulkEnd).toHaveBeenCalledTimes(1);
  });
});
