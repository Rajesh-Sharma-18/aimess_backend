/**
 * Community Management admin API (self-prefixed at /v1/communities/*).
 * Reads require `communities.read`; mutations require `communities.moderate`.
 * Covers list (+ UI sort mapping), detail (404), members, close/reopen, bulk,
 * the RBAC split, validation matrices, and the bulk-before-:id routing.
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
    communityService: {
      listCommunities: jest.fn(),
      getCommunity: jest.fn(),
      listCommunityMembers: jest.fn(),
      closeCommunity: jest.fn(),
      reopenCommunity: jest.fn(),
      bulkClose: jest.fn(),
      bulkReopen: jest.fn(),
    },
  };
});

import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { communityService } from "../../src/services/index.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = communityService as unknown as Record<string, jest.Mock>;

const CID = "comm_001";
const PAGE = {
  data: [{ communityId: CID, name: "Builders", status: "ACTIVE" }],
  pagination: { mode: "offset", page: 1, limit: 20, total: 1 },
};
const BULK = { requested: 2, succeeded: 2, failed: 0, results: [] };
const auth = () => bearer(makeAdminAccessToken());

beforeEach(() => {
  configureActiveAdmin(findById);
  grantPermissions(perms, [
    PERMISSIONS.COMMUNITIES_READ,
    PERMISSIONS.COMMUNITIES_MODERATE,
  ]);
  svc.listCommunities.mockResolvedValue(PAGE);
  svc.getCommunity.mockResolvedValue({
    community: { communityId: CID, name: "Builders" },
    owner: { userId: "u_1", displayName: "Owner" },
    memberStats: {
      total: 21,
      active: 20,
      pending: 0,
      banned: 1,
      moderators: 2,
      joinedLast7d: 3,
    },
    livestreamStats: {
      total: 4,
      live: 1,
      scheduled: 0,
      maxConcurrent: 5,
      stale: true,
    },
    moderationHistory: [{ id: "mh_1", type: "suspend_community" }],
    settingsSummary: { joinPolicy: "OPEN", memberCount: 21 },
    partial: false,
  });
  svc.listCommunityMembers.mockResolvedValue(PAGE);
  svc.closeCommunity.mockResolvedValue({ communityId: CID, status: "CLOSED" });
  svc.reopenCommunity.mockResolvedValue({ communityId: CID, status: "ACTIVE" });
  svc.bulkClose.mockResolvedValue(BULK);
  svc.bulkReopen.mockResolvedValue(BULK);
});

describe("GET /v1/communities", () => {
  it("returns 200 with the list", async () => {
    const res = await request(app).get("/v1/communities").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("maps sortBy=members → memberCount:<dir>", async () => {
    await request(app)
      .get("/v1/communities?sortBy=members&sortOrder=asc")
      .set(auth());
    expect(svc.listCommunities.mock.calls[0][0].sort).toBe("memberCount:asc");
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/communities");
    expect(res.status).toBe(401);
  });

  it("returns 403 without communities.read", async () => {
    grantPermissions(perms, []);
    const res = await request(app).get("/v1/communities").set(auth());
    expect(res.status).toBe(403);
  });

  it.each([
    ["invalid type enum", "type=SECRET"],
    ["invalid status enum", "status=PAUSED"],
    ["malformed sort token", "sort=name"],
    ["limit over max", "limit=200"],
  ])("returns 400 for %s", async (_label, qs) => {
    const res = await request(app).get(`/v1/communities?${qs}`).set(auth());
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/communities/:communityId", () => {
  it("returns 200 with the detail, numeric memberStats/livestreamStats, and no dropped fields", async () => {
    const res = await request(app).get(`/v1/communities/${CID}`).set(auth());
    expect(res.status).toBe(200);
    // Community fields are flattened onto the root — no `community` wrapper.
    expect(res.body.data).not.toHaveProperty("community");
    expect(res.body.data.communityId).toBe(CID);
    expect(res.body.data.owner).toEqual({
      userId: "u_1",
      displayName: "Owner",
    });
    // memberStats/livestreamStats collapse from an object to a number.
    expect(res.body.data.memberStats).toBe(21);
    expect(res.body.data.livestreamStats).toBe(4);
    // These fields must never appear in the response.
    expect(res.body.data).not.toHaveProperty("moderationHistory");
    expect(res.body.data).not.toHaveProperty("settingsSummary");
    expect(res.body.data).not.toHaveProperty("partial");
  });

  it("livestreamStats defaults to 0 when the repository has no livestream data", async () => {
    svc.getCommunity.mockResolvedValue({
      community: { communityId: CID, name: "Builders" },
      owner: { userId: "u_1", displayName: "Owner" },
      memberStats: { total: 5 },
      livestreamStats: null,
      moderationHistory: [],
      settingsSummary: { joinPolicy: "OPEN", memberCount: 5 },
      partial: true,
    });
    const res = await request(app).get(`/v1/communities/${CID}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.memberStats).toBe(5);
    expect(res.body.data.livestreamStats).toBe(0);
  });

  it("returns 404 when the community is unknown", async () => {
    svc.getCommunity.mockResolvedValue(null);
    const res = await request(app).get("/v1/communities/ghost").set(auth());
    expect(res.status).toBe(404);
  });

  it("GET /v1/communities/:id/members → 200", async () => {
    const res = await request(app)
      .get(`/v1/communities/${CID}/members`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listCommunityMembers).toHaveBeenCalledTimes(1);
  });

  it("members list rejects an invalid role enum (400)", async () => {
    const res = await request(app)
      .get(`/v1/communities/${CID}/members?role=GOD`)
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("members list defaults to sortField=joinedAt/sortDir=desc when sort is omitted", async () => {
    const res = await request(app)
      .get(`/v1/communities/${CID}/members`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listCommunityMembers.mock.calls[0][1]).toMatchObject({
      sortField: "joinedAt",
      sortDir: "desc",
    });
  });

  it.each([
    ["username:asc", "username", "asc"],
    ["username:desc", "username", "desc"],
    ["handle:asc", "handle", "asc"],
    ["handle:desc", "handle", "desc"],
    ["joinedAt:asc", "joinedAt", "asc"],
    ["joinedAt:desc", "joinedAt", "desc"],
  ])(
    "members list maps sort=%s to sortField/sortDir",
    async (token, field, dir) => {
      const res = await request(app)
        .get(`/v1/communities/${CID}/members?sort=${token}`)
        .set(auth());
      expect(res.status).toBe(200);
      expect(svc.listCommunityMembers.mock.calls[0][1]).toMatchObject({
        sortField: field,
        sortDir: dir,
      });
    }
  );

  it("members list falls back to joinedAt:desc for an invalid sort token", async () => {
    const res = await request(app)
      .get(`/v1/communities/${CID}/members?sort=avatarUrl:asc`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listCommunityMembers.mock.calls[0][1]).toMatchObject({
      sortField: "joinedAt",
      sortDir: "desc",
    });
  });

  it("members list still honors page/limit/role/search alongside sort", async () => {
    const res = await request(app)
      .get(
        `/v1/communities/${CID}/members?sort=username:asc&page=2&limit=10&role=MODERATOR&q=alice`
      )
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listCommunityMembers.mock.calls[0][1]).toMatchObject({
      sortField: "username",
      sortDir: "asc",
      page: 2,
      limit: 10,
      role: "MODERATOR",
      search: "alice",
    });
  });
});

describe("POST /v1/communities/:communityId/close", () => {
  it("closes a community → 200", async () => {
    const res = await request(app)
      .post(`/v1/communities/${CID}/close`)
      .set(auth())
      .send({ reasonCode: "SPAM" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("CLOSED");
  });

  it("returns 403 with communities.read only", async () => {
    grantPermissions(perms, [PERMISSIONS.COMMUNITIES_READ]);
    const res = await request(app)
      .post(`/v1/communities/${CID}/close`)
      .set(auth())
      .send({ reasonCode: "SPAM" });
    expect(res.status).toBe(403);
    expect(svc.closeCommunity).not.toHaveBeenCalled();
  });

  it.each([
    ["missing reasonCode", {}],
    ["invalid reasonCode enum", { reasonCode: "JUST_BECAUSE" }],
    [
      "reasonNote over max",
      { reasonCode: "SPAM", reasonNote: "x".repeat(2001) },
    ],
  ])("returns 400 for %s", async (_label, body) => {
    const res = await request(app)
      .post(`/v1/communities/${CID}/close`)
      .set(auth())
      .send(body);
    expect(res.status).toBe(400);
    expect(svc.closeCommunity).not.toHaveBeenCalled();
  });
});

describe("POST /v1/communities/:communityId/reopen", () => {
  it("reopens a community → 200", async () => {
    const res = await request(app)
      .post(`/v1/communities/${CID}/reopen`)
      .set(auth())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ACTIVE");
  });
});

describe("bulk community actions (207)", () => {
  it("POST /v1/communities/bulk/close → 207", async () => {
    const res = await request(app)
      .post("/v1/communities/bulk/close")
      .set(auth())
      .send({ communityIds: [CID, "comm_002"], reasonCode: "INACTIVE" });
    expect(res.status).toBe(207);
    expect(svc.bulkClose).toHaveBeenCalledTimes(1);
  });

  it("POST /v1/communities/bulk/reopen → 207", async () => {
    const res = await request(app)
      .post("/v1/communities/bulk/reopen")
      .set(auth())
      .send({ communityIds: [CID] });
    expect(res.status).toBe(207);
  });

  it("bulk path is matched before /:communityId", async () => {
    await request(app)
      .post("/v1/communities/bulk/close")
      .set(auth())
      .send({ communityIds: [CID], reasonCode: "SPAM" });
    expect(svc.closeCommunity).not.toHaveBeenCalled();
    expect(svc.bulkClose).toHaveBeenCalledTimes(1);
  });

  it("bulk/close returns 400 for an empty communityIds array", async () => {
    const res = await request(app)
      .post("/v1/communities/bulk/close")
      .set(auth())
      .send({ communityIds: [], reasonCode: "SPAM" });
    expect(res.status).toBe(400);
  });
});
