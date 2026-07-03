/**
 * Announcements admin API (self-prefixed at /v1/announcements/*). Requires
 * `announcements.manage`. Covers create validation (target/communityId
 * pairing, scheduledAt), list filters/pagination, and detail (404).
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
    announcementService: {
      createAnnouncement: jest.fn(),
      listAnnouncements: jest.fn(),
      getAnnouncementDetails: jest.fn(),
    },
  };
});

import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { announcementService } from "../../src/services/index.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = announcementService as unknown as Record<string, jest.Mock>;

const AID = "3f2b6c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";
const COMMUNITY_ID = "8b1e2c3d-4f5a-4b6c-9d0e-1f2a3b4c5d6e";
const DETAIL = {
  id: AID,
  title: "Platform maintenance",
  description: "We will be down for maintenance.",
  target: "ALL",
  communityId: null,
  status: "SENT",
  scheduledAt: null,
  recipientCount: 100,
  failureReason: null,
  createdById: "admin-1",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:05.000Z",
  sentAt: "2026-07-01T00:00:05.000Z",
};
const PAGE = {
  data: [
    {
      id: AID,
      title: "Platform maintenance",
      target: "ALL",
      communityId: null,
      recipientCount: 100,
      status: "SENT",
      announcedAt: "2026-07-01T00:00:05.000Z",
    },
  ],
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
  grantPermissions(perms, [PERMISSIONS.ANNOUNCEMENTS_MANAGE]);
  svc.createAnnouncement.mockResolvedValue(DETAIL);
  svc.listAnnouncements.mockResolvedValue(PAGE);
  svc.getAnnouncementDetails.mockResolvedValue(DETAIL);
});

describe("POST /v1/announcements", () => {
  it("creates an ALL-target announcement → 201", async () => {
    const res = await request(app).post("/v1/announcements").set(auth()).send({
      title: "Platform maintenance",
      description: "We will be down for maintenance.",
      target: "ALL",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(AID);
    expect(svc.createAnnouncement).toHaveBeenCalledTimes(1);
  });

  it("creates a COMMUNITY-target announcement with communityId → 201", async () => {
    const res = await request(app).post("/v1/announcements").set(auth()).send({
      title: "Community update",
      description: "New rules in effect.",
      target: "COMMUNITY",
      communityId: COMMUNITY_ID,
    });
    expect(res.status).toBe(201);
    expect(svc.createAnnouncement).toHaveBeenCalledTimes(1);
  });

  it("rejects COMMUNITY target without communityId (400)", async () => {
    const res = await request(app)
      .post("/v1/announcements")
      .set(auth())
      .send({ title: "x", description: "y", target: "COMMUNITY" });
    expect(res.status).toBe(400);
    expect(svc.createAnnouncement).not.toHaveBeenCalled();
  });

  it("rejects ALL target with communityId set (400)", async () => {
    const res = await request(app).post("/v1/announcements").set(auth()).send({
      title: "x",
      description: "y",
      target: "ALL",
      communityId: COMMUNITY_ID,
    });
    expect(res.status).toBe(400);
    expect(svc.createAnnouncement).not.toHaveBeenCalled();
  });

  it("rejects a scheduledAt in the past (400)", async () => {
    const res = await request(app).post("/v1/announcements").set(auth()).send({
      title: "x",
      description: "y",
      target: "ALL",
      scheduledAt: "2020-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(400);
    expect(svc.createAnnouncement).not.toHaveBeenCalled();
  });

  it("accepts a future scheduledAt → 201", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await request(app).post("/v1/announcements").set(auth()).send({
      title: "x",
      description: "y",
      target: "ALL",
      scheduledAt: future,
    });
    expect(res.status).toBe(201);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/v1/announcements")
      .send({ title: "x", description: "y", target: "ALL" });
    expect(res.status).toBe(401);
  });

  it("returns 403 without announcements.manage", async () => {
    grantPermissions(perms, []);
    const res = await request(app)
      .post("/v1/announcements")
      .set(auth())
      .send({ title: "x", description: "y", target: "ALL" });
    expect(res.status).toBe(403);
    expect(svc.createAnnouncement).not.toHaveBeenCalled();
  });
});

describe("GET /v1/announcements", () => {
  it("returns 200 with the list + pagination", async () => {
    const res = await request(app).get("/v1/announcements").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });

  it("forwards search/target/status/date filters to the service", async () => {
    await request(app)
      .get(
        "/v1/announcements?search=maintenance&target=ALL&status=SENT&status=FAILED&dateFrom=2026-01-01&dateTo=2026-12-31"
      )
      .set(auth());
    const arg = svc.listAnnouncements.mock.calls[0][0];
    expect(arg.search).toBe("maintenance");
    expect(arg.target).toBe("ALL");
    expect(arg.status).toEqual(["SENT", "FAILED"]);
    expect(arg.dateFrom).toBe("2026-01-01");
    expect(arg.dateTo).toBe("2026-12-31");
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/announcements");
    expect(res.status).toBe(401);
  });

  it.each([
    ["invalid sort token", "sort=recipients"],
    ["invalid status enum", "status=NOPE"],
    ["limit over max", "limit=500"],
  ])("returns 400 for %s", async (_label, qs) => {
    const res = await request(app).get(`/v1/announcements?${qs}`).set(auth());
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/announcements/:announcementId", () => {
  it("returns 200 with the detail", async () => {
    const res = await request(app).get(`/v1/announcements/${AID}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(AID);
  });

  it("returns 404 when the announcement is unknown", async () => {
    svc.getAnnouncementDetails.mockResolvedValueOnce(null);
    const res = await request(app).get(`/v1/announcements/${AID}`).set(auth());
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid uuid param", async () => {
    const res = await request(app)
      .get("/v1/announcements/not-a-uuid")
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.getAnnouncementDetails).not.toHaveBeenCalled();
  });
});
