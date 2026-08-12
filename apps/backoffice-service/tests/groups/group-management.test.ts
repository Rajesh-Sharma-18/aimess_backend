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
      disbandGroup: jest.fn(),
      removeGroupMember: jest.fn(),
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
  svc.disbandGroup.mockResolvedValue({
    groupId: GID,
    status: "DISBANDED",
    auditLogId: "audit_1",
  });
  svc.removeGroupMember.mockResolvedValue({
    groupId: GID,
    userId: "u1",
    auditLogId: "audit_2",
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

// Moderation. `groups.read` alone must NOT open these — they need groups.moderate.
const moderator = () =>
  grantPermissions(perms, [
    PERMISSIONS.GROUPS_READ,
    PERMISSIONS.GROUPS_MODERATE,
  ]);

describe("POST /v1/groups/:groupId/disband", () => {
  it("disbands with an empty body → 200", async () => {
    moderator();
    const res = await request(app)
      .post(`/v1/groups/${GID}/disband`)
      .set(auth())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("DISBANDED");
    expect(svc.disbandGroup.mock.calls[0][1]).toBeUndefined();
  });

  it("forwards a trimmed reason", async () => {
    moderator();
    await request(app)
      .post(`/v1/groups/${GID}/disband`)
      .set(auth())
      .send({ reason: "  spam ring  " });
    expect(svc.disbandGroup.mock.calls[0][1]).toBe("spam ring");
  });

  it("returns 403 with only groups.read", async () => {
    const res = await request(app)
      .post(`/v1/groups/${GID}/disband`)
      .set(auth())
      .send({});
    expect(res.status).toBe(403);
    expect(svc.disbandGroup).not.toHaveBeenCalled();
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).post(`/v1/groups/${GID}/disband`).send({});
    expect(res.status).toBe(401);
  });

  it("returns 400 for a whitespace-only reason", async () => {
    moderator();
    const res = await request(app)
      .post(`/v1/groups/${GID}/disband`)
      .set(auth())
      .send({ reason: "   " });
    expect(res.status).toBe(400);
    expect(svc.disbandGroup).not.toHaveBeenCalled();
  });

  it("propagates the chat 409 conflict code verbatim", async () => {
    moderator();
    const { ConflictError } = await import("@aimess/errors");
    svc.disbandGroup.mockRejectedValue(
      new ConflictError("CHAT_GROUP_ALREADY_DISBANDED")
    );
    const res = await request(app)
      .post(`/v1/groups/${GID}/disband`)
      .set(auth())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("CHAT_GROUP_ALREADY_DISBANDED");
  });
});

describe("POST /v1/groups/:groupId/members/:userId/remove", () => {
  it("removes a member → 200", async () => {
    moderator();
    const res = await request(app)
      .post(`/v1/groups/${GID}/members/u1/remove`)
      .set(auth())
      .send({ reason: "harassment" });
    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe("u1");
    const [groupId, userId, reason] = svc.removeGroupMember.mock.calls[0];
    expect([groupId, userId, reason]).toEqual([GID, "u1", "harassment"]);
  });

  it("returns 403 with only groups.read", async () => {
    const res = await request(app)
      .post(`/v1/groups/${GID}/members/u1/remove`)
      .set(auth())
      .send({});
    expect(res.status).toBe(403);
    expect(svc.removeGroupMember).not.toHaveBeenCalled();
  });

  it("returns 400 for an over-length userId", async () => {
    moderator();
    const res = await request(app)
      .post(`/v1/groups/${GID}/members/${"u".repeat(65)}/remove`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
    expect(svc.removeGroupMember).not.toHaveBeenCalled();
  });

  // The repository re-codes chat's CHAT_NOT_A_MEMBER (a LOCALIZED end-user key
  // that renders as "You are not a member of this group") to this admin-scoped
  // code. Asserting the literal also fails the day someone adds it to
  // @aimess/constants and the error handler starts translating it away.
  it("surfaces a missing membership as 409 GROUP_MEMBER_NOT_ACTIVE", async () => {
    moderator();
    const { ConflictError } = await import("@aimess/errors");
    svc.removeGroupMember.mockRejectedValue(
      new ConflictError("GROUP_MEMBER_NOT_ACTIVE")
    );
    const res = await request(app)
      .post(`/v1/groups/${GID}/members/u1/remove`)
      .set(auth())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("GROUP_MEMBER_NOT_ACTIVE");
  });
});
