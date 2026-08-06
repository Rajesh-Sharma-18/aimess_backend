/**
 * Group Management admin API (self-prefixed at /v1/groups/*). All reads require
 * `groups.read`. Covers list (nested {items, pagination}), detail (404), members
 * (404 when the group is absent via `result.found === false`), the auth + RBAC
 * gates, and the list/members validation matrices.
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
    groupService: {
      listGroups: jest.fn(),
      getGroup: jest.fn(),
      listGroupMembers: jest.fn(),
    },
  };
});

import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { groupService } from "../../src/services/index.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = groupService as unknown as Record<string, jest.Mock>;

const GID = "grp_001";
const PAGINATION = { mode: "offset", page: 1, limit: 20, total: 1 };
const auth = () => bearer(makeAdminAccessToken());

beforeEach(() => {
  configureActiveAdmin(findById);
  grantPermissions(perms, [PERMISSIONS.GROUPS_READ]);
  svc.listGroups.mockResolvedValue({
    items: [{ groupId: GID, name: "Weekend Crew" }],
    pagination: PAGINATION,
  });
  svc.getGroup.mockResolvedValue({ groupId: GID, name: "Weekend Crew" });
  svc.listGroupMembers.mockResolvedValue({
    found: true,
    items: [{ userId: "u1", role: "ADMIN" }],
    pagination: PAGINATION,
  });
});

describe("GET /v1/groups", () => {
  it("returns 200 with nested {items, pagination}", async () => {
    const res = await request(app).get("/v1/groups").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.pagination).toBeDefined();
  });

  it("passes default sortBy=createdAt / sortOrder=desc", async () => {
    await request(app).get("/v1/groups").set(auth());
    const arg = svc.listGroups.mock.calls[0][0];
    expect(arg.sortBy).toBe("createdAt");
    expect(arg.sortOrder).toBe("desc");
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/groups");
    expect(res.status).toBe(401);
  });

  it("returns 403 without groups.read", async () => {
    grantPermissions(perms, []);
    const res = await request(app).get("/v1/groups").set(auth());
    expect(res.status).toBe(403);
  });

  it.each([
    ["invalid sortBy enum", "sortBy=color"],
    ["invalid sortOrder enum", "sortOrder=sideways"],
    ["malformed fromDate", "fromDate=2026-99-99"],
    ["limit over max", "limit=300"],
  ])("returns 400 for %s", async (_label, qs) => {
    const res = await request(app).get(`/v1/groups?${qs}`).set(auth());
    expect(res.status).toBe(400);
    expect(svc.listGroups).not.toHaveBeenCalled();
  });
});

describe("GET /v1/groups/:groupId", () => {
  it("returns 200 with the detail", async () => {
    const res = await request(app).get(`/v1/groups/${GID}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.groupId).toBe(GID);
  });

  it("returns 404 when the group is unknown", async () => {
    svc.getGroup.mockResolvedValue(null);
    const res = await request(app).get("/v1/groups/ghost").set(auth());
    expect(res.status).toBe(404);
  });

  it("returns 400 for an over-length groupId", async () => {
    const res = await request(app)
      .get(`/v1/groups/${"g".repeat(65)}`)
      .set(auth());
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/groups/:groupId/members", () => {
  it("returns 200 with the member grid", async () => {
    const res = await request(app).get(`/v1/groups/${GID}/members`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });

  it("returns 404 when the group is absent (result.found === false)", async () => {
    svc.listGroupMembers.mockResolvedValue({
      found: false,
      items: [],
      pagination: PAGINATION,
    });
    const res = await request(app).get(`/v1/groups/${GID}/members`).set(auth());
    expect(res.status).toBe(404);
  });

  it("rejects an invalid member role enum (400)", async () => {
    const res = await request(app)
      .get(`/v1/groups/${GID}/members?role=KING`)
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("accepts the ADMIN role filter", async () => {
    const res = await request(app)
      .get(`/v1/groups/${GID}/members?role=ADMIN`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listGroupMembers.mock.calls[0][1].role).toBe("ADMIN");
  });
});
