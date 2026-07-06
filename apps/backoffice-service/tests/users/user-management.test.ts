/**
 * Admin User Management API (self-prefixed at /v1/users/*).
 * Reads require `users.read`; mutations require `users.moderate`.
 * Covers list (+ tolerant status/sort filters), detail (404), reports,
 * communities grid, co-member grid, ban/suspend/unban, bulk ban/activate (207),
 * the RBAC split, the validation matrices, plus mass-assignment + injection.
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
    userManagementService: {
      listUsers: jest.fn(),
      getUser: jest.fn(),
      listUserReports: jest.fn(),
      listUserCommunities: jest.fn(),
      listOtherCommunityMembers: jest.fn(),
      banUser: jest.fn(),
      suspendUser: jest.fn(),
      unbanUser: jest.fn(),
      bulkBan: jest.fn(),
      bulkActivate: jest.fn(),
    },
  };
});

import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { userManagementService } from "../../src/services/index.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = userManagementService as unknown as Record<string, jest.Mock>;

const USER_ID = "user-123";
const PAGE = {
  data: [{ userId: USER_ID, username: "jdoe", status: "ACTIVE" }],
  pagination: { mode: "offset", page: 1, limit: 20, total: 1 },
};
const STATUS_RESULT = {
  userId: USER_ID,
  status: "BANNED",
  suspendedUntil: null,
};
const BULK = { requested: 2, succeeded: 2, failed: 0, results: [] };
const auth = () => bearer(makeAdminAccessToken());

beforeEach(() => {
  configureActiveAdmin(findById);
  grantPermissions(perms, [PERMISSIONS.USERS_READ, PERMISSIONS.USERS_MODERATE]);
  svc.listUsers.mockResolvedValue(PAGE);
  svc.getUser.mockResolvedValue({
    profile: { userId: USER_ID, username: "jdoe" },
    accountStatus: { status: "ACTIVE" },
  });
  svc.listUserReports.mockResolvedValue(PAGE);
  svc.listUserCommunities.mockResolvedValue(PAGE);
  svc.listOtherCommunityMembers.mockResolvedValue({
    community: { communityId: "c1", name: "C", memberCount: 5 },
    items: [],
    pagination: PAGE.pagination,
  });
  svc.banUser.mockResolvedValue(STATUS_RESULT);
  svc.suspendUser.mockResolvedValue({
    userId: USER_ID,
    status: "SUSPENDED",
    suspendedUntil: "2026-07-01T00:00:00.000Z",
  });
  svc.unbanUser.mockResolvedValue({ userId: USER_ID, status: "ACTIVE" });
  svc.bulkBan.mockResolvedValue(BULK);
  svc.bulkActivate.mockResolvedValue(BULK);
});

describe("GET /v1/users", () => {
  it("returns 200 with the paginated list", async () => {
    const res = await request(app).get("/v1/users").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toBeDefined();
  });

  it("passes each row's moderationStatus/isBanned through unchanged, alongside the existing status", async () => {
    svc.listUsers.mockResolvedValue({
      data: [
        {
          userId: USER_ID,
          username: "jdoe",
          status: "SUSPENDED",
          moderationStatus: "BANNED",
          isBanned: true,
          bannedAt: "2026-07-01T00:00:00.000Z",
          bannedBy: "admin-1",
          banReason: "SPAM",
        },
      ],
      pagination: PAGE.pagination,
    });
    const res = await request(app).get("/v1/users").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      status: "SUSPENDED",
      moderationStatus: "BANNED",
      isBanned: true,
      bannedAt: "2026-07-01T00:00:00.000Z",
      bannedBy: "admin-1",
      banReason: "SPAM",
    });
  });

  it("omits bannedAt/bannedBy/banReason for a non-banned row", async () => {
    svc.listUsers.mockResolvedValue({
      data: [
        {
          userId: USER_ID,
          username: "jdoe",
          status: "ACTIVE",
          moderationStatus: "ACTIVE",
          isBanned: false,
        },
      ],
      pagination: PAGE.pagination,
    });
    const res = await request(app).get("/v1/users").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data[0].isBanned).toBe(false);
    expect(res.body.data[0]).not.toHaveProperty("bannedAt");
    expect(res.body.data[0]).not.toHaveProperty("bannedBy");
    expect(res.body.data[0]).not.toHaveProperty("banReason");
  });

  it("normalizes a lowercase / aliased status filter (active, pending_deletion)", async () => {
    const res = await request(app)
      .get("/v1/users?status=active&status=pending_deletion")
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listUsers.mock.calls[0][0].status).toEqual([
      "ACTIVE",
      "DELETED",
    ]);
  });

  it("maps the UI sortBy/sortOrder pair onto the canonical sort token", async () => {
    const res = await request(app)
      .get("/v1/users?sortBy=joinedDate&sortOrder=asc")
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listUsers.mock.calls[0][0].sort).toBe("joinedAt:asc");
  });

  it("maps q → search", async () => {
    await request(app).get("/v1/users?q=jdoe").set(auth());
    expect(svc.listUsers.mock.calls[0][0].search).toBe("jdoe");
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/users");
    expect(res.status).toBe(401);
  });

  it("returns 403 when the admin lacks users.read", async () => {
    grantPermissions(perms, []);
    const res = await request(app).get("/v1/users").set(auth());
    expect(res.status).toBe(403);
    expect(svc.listUsers).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid status enum", "status=GHOST"],
    ["invalid reports bucket", "reports=loads"],
    ["limit over max", "limit=1000"],
    ["page below 1", "page=0"],
    ["malformed sort field", "sort=evil:asc"],
    ["invalid dateFrom", "dateFrom=2026-99-99"],
  ])("returns 400 for %s", async (_label, qs) => {
    const res = await request(app).get(`/v1/users?${qs}`).set(auth());
    expect(res.status).toBe(400);
    expect(svc.listUsers).not.toHaveBeenCalled();
  });
});

describe("GET /v1/users/:userId", () => {
  it("returns 200 with the full detail", async () => {
    const res = await request(app).get(`/v1/users/${USER_ID}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.profile.userId).toBe(USER_ID);
  });

  it("returns 404 when the user is unknown", async () => {
    svc.getUser.mockResolvedValue(null);
    const res = await request(app).get("/v1/users/ghost").set(auth());
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for an over-length userId (>64)", async () => {
    const res = await request(app)
      .get(`/v1/users/${"u".repeat(65)}`)
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("passes accountStatus.moderationStatus/isBanned through unchanged, alongside status", async () => {
    svc.getUser.mockResolvedValue({
      profile: { userId: USER_ID, username: "jdoe" },
      accountStatus: {
        status: "BANNED",
        moderationStatus: "BANNED",
        isBanned: true,
      },
    });
    const res = await request(app).get(`/v1/users/${USER_ID}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.accountStatus).toMatchObject({
      status: "BANNED",
      moderationStatus: "BANNED",
      isBanned: true,
    });
  });
});

describe("GET /v1/users/:userId/details (alias of GET /v1/users/:userId)", () => {
  it("returns 200 with the same community-less detail shape", async () => {
    const res = await request(app)
      .get(`/v1/users/${USER_ID}/details`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.profile.userId).toBe(USER_ID);
    expect(svc.getUser).toHaveBeenCalledWith(USER_ID);
  });

  it("returns 404 when the user is unknown", async () => {
    svc.getUser.mockResolvedValue(null);
    const res = await request(app).get("/v1/users/ghost/details").set(auth());
    expect(res.status).toBe(404);
  });
});

describe("user sub-lists", () => {
  it("GET /v1/users/:id/reports → 200", async () => {
    const res = await request(app)
      .get(`/v1/users/${USER_ID}/reports`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listUserReports).toHaveBeenCalledWith(USER_ID, 1, 20);
  });

  it("GET /v1/users/:id/communities → 200 with nested items", async () => {
    const res = await request(app)
      .get(`/v1/users/${USER_ID}/communities`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.items).toBeDefined();
    expect(res.body.data.pagination).toBeDefined();
  });

  it("GET /v1/users/:id/communities/:cid/members → 200 with community block", async () => {
    const res = await request(app)
      .get(`/v1/users/${USER_ID}/communities/c1/members`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.community.communityId).toBe("c1");
    expect(svc.listOtherCommunityMembers).toHaveBeenCalledWith(
      USER_ID,
      "c1",
      expect.objectContaining({ searchIsEmail: false }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("flags an email search (q with @) as searchIsEmail on the co-member grid", async () => {
    await request(app)
      .get(
        `/v1/users/${USER_ID}/communities/c1/members?q=${encodeURIComponent("a@b.com")}`
      )
      .set(auth());
    expect(svc.listOtherCommunityMembers.mock.calls[0][2].searchIsEmail).toBe(
      true
    );
  });
});

describe("POST /v1/users/:userId/ban", () => {
  it("permanently bans a user → 200 (durationDays null)", async () => {
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/ban`)
      .set(auth())
      .send({ reason: "SPAM" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("BANNED");
    expect(svc.banUser).toHaveBeenCalledTimes(1);
  });

  it("returns 403 with users.read only (no users.moderate)", async () => {
    grantPermissions(perms, [PERMISSIONS.USERS_READ]);
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/ban`)
      .set(auth())
      .send({ reason: "SPAM" });
    expect(res.status).toBe(403);
    expect(svc.banUser).not.toHaveBeenCalled();
  });

  it.each([
    ["missing reason", {}],
    ["empty reason", { reason: "   " }],
    ["reason over max length (200)", { reason: "x".repeat(201) }],
    ["zero durationDays", { reason: "SPAM", durationDays: 0 }],
    ["negative durationDays", { reason: "SPAM", durationDays: -5 }],
    ["non-uuid reportId", { reason: "SPAM", reportId: "not-a-uuid" }],
    ["note over max", { reason: "SPAM", note: "x".repeat(2001) }],
  ])("returns 400 for %s", async (_label, body) => {
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/ban`)
      .set(auth())
      .send(body);
    expect(res.status).toBe(400);
    expect(svc.banUser).not.toHaveBeenCalled();
  });

  it("accepts a predefined reason code (backward compatible)", async () => {
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/ban`)
      .set(auth())
      .send({ reason: "SPAM" });
    expect(res.status).toBe(200);
    expect(svc.banUser.mock.calls[0][1]).toMatchObject({ reason: "SPAM" });
  });

  it("accepts a custom free-text reason and forwards it unchanged", async () => {
    const customReason =
      "Repeated harassment of minors in DMs, see ticket #4821";
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/ban`)
      .set(auth())
      .send({ reason: customReason });
    expect(res.status).toBe(200);
    expect(svc.banUser).toHaveBeenCalledTimes(1);
    // Persisted verbatim (trimmed) — the exact custom string, not a code.
    expect(svc.banUser.mock.calls[0][1]).toMatchObject({
      reason: customReason,
    });
  });

  it("trims a custom reason with surrounding whitespace", async () => {
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/ban`)
      .set(auth())
      .send({ reason: "  Custom reason with spaces  " });
    expect(res.status).toBe(200);
    expect(svc.banUser.mock.calls[0][1]).toMatchObject({
      reason: "Custom reason with spaces",
    });
  });
});

describe("POST /v1/users/:userId/suspend", () => {
  it("suspends a user with a duration → 200", async () => {
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/suspend`)
      .set(auth())
      .send({ reason: "HARASSMENT", durationDays: 7 });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("SUSPENDED");
  });

  it("returns 400 when durationDays is missing (required for suspend)", async () => {
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/suspend`)
      .set(auth())
      .send({ reason: "HARASSMENT" });
    expect(res.status).toBe(400);
    expect(svc.suspendUser).not.toHaveBeenCalled();
  });
});

describe("POST /v1/users/:userId/unban", () => {
  it("reinstates a user with a note → 200", async () => {
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/unban`)
      .set(auth())
      .send({ note: "Appeal accepted" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ACTIVE");
  });

  it("reinstates a user with NO request body at all → 200", async () => {
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/unban`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ACTIVE");
    // No Content-Type/body sent → req.body is undefined; the controller
    // defaults it to {} before calling the service.
    expect(svc.unbanUser).toHaveBeenCalledWith(
      USER_ID,
      {},
      expect.anything(),
      expect.anything()
    );
  });

  it("reinstates a user with an empty body ({}) → 200", async () => {
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/unban`)
      .set(auth())
      .send({});
    expect(res.status).toBe(200);
    expect(svc.unbanUser).toHaveBeenCalled();
  });
});

describe("POST /v1/users/:userId/activate (alias of /unban)", () => {
  it("reinstates a user → 200, same as /unban", async () => {
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/activate`)
      .set(auth())
      .send({ note: "Appeal accepted" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ACTIVE");
    expect(svc.unbanUser).toHaveBeenCalledTimes(1);
  });

  it("returns 403 with users.read only (no users.moderate)", async () => {
    grantPermissions(perms, [PERMISSIONS.USERS_READ]);
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/activate`)
      .set(auth())
      .send({});
    expect(res.status).toBe(403);
    expect(svc.unbanUser).not.toHaveBeenCalled();
  });
});

describe("GET /v1/users/ban-reasons", () => {
  it("returns the predefined reason codes", async () => {
    const res = await request(app).get("/v1/users/ban-reasons").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(
      expect.arrayContaining(["SPAM", "HARASSMENT", "OTHER"])
    );
  });

  it("is not shadowed by the /:userId route (not treated as a userId)", async () => {
    const res = await request(app).get("/v1/users/ban-reasons").set(auth());
    expect(res.status).toBe(200);
    expect(svc.getUser).not.toHaveBeenCalled();
  });

  it("returns 403 without users.read", async () => {
    grantPermissions(perms, []);
    const res = await request(app).get("/v1/users/ban-reasons").set(auth());
    expect(res.status).toBe(403);
  });
});

describe("bulk user actions (207 Multi-Status)", () => {
  it("POST /v1/users/bulk/ban → 207", async () => {
    const res = await request(app)
      .post("/v1/users/bulk/ban")
      .set(auth())
      .send({ userIds: ["u1", "u2"], reason: "SPAM" });
    expect(res.status).toBe(207);
    expect(svc.bulkBan).toHaveBeenCalledTimes(1);
  });

  it("POST /v1/users/bulk/activate → 207", async () => {
    const res = await request(app)
      .post("/v1/users/bulk/activate")
      .set(auth())
      .send({ userIds: ["u1"] });
    expect(res.status).toBe(207);
    expect(svc.bulkActivate).toHaveBeenCalledTimes(1);
  });

  it("bulk path is matched before /:userId (bulk not captured as id)", async () => {
    await request(app)
      .post("/v1/users/bulk/ban")
      .set(auth())
      .send({ userIds: ["u1"], reason: "SPAM" });
    expect(svc.banUser).not.toHaveBeenCalled();
    expect(svc.bulkBan).toHaveBeenCalledTimes(1);
  });

  it("bulk/ban accepts a custom free-text reason and forwards it unchanged", async () => {
    const res = await request(app)
      .post("/v1/users/bulk/ban")
      .set(auth())
      .send({ userIds: ["u1", "u2"], reason: "Coordinated spam campaign" });
    expect(res.status).toBe(207);
    expect(svc.bulkBan.mock.calls[0][1]).toMatchObject({
      reason: "Coordinated spam campaign",
    });
  });

  it.each([
    ["empty userIds", { userIds: [], reason: "SPAM" }],
    [
      "over 100 userIds",
      {
        userIds: Array.from({ length: 101 }, (_, i) => `u${i}`),
        reason: "SPAM",
      },
    ],
    ["missing reason", { userIds: ["u1"] }],
  ])("bulk/ban returns 400 for %s", async (_label, body) => {
    const res = await request(app)
      .post("/v1/users/bulk/ban")
      .set(auth())
      .send(body);
    expect(res.status).toBe(400);
    expect(svc.bulkBan).not.toHaveBeenCalled();
  });
});

describe("security", () => {
  it("ignores mass-assigned privileged fields in a ban body", async () => {
    await request(app).post(`/v1/users/${USER_ID}/ban`).set(auth()).send({
      reason: "SPAM",
      status: "DELETED",
      userId: "someone-else",
      isAdmin: true,
    });
    // The validated body forwarded to the service carries only whitelisted keys.
    const body = svc.banUser.mock.calls[0][1];
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("isAdmin");
    // The acted-on userId comes from the PATH param, not the injected body field.
    expect(svc.banUser.mock.calls[0][0]).toBe(USER_ID);
  });

  it("safely handles a NoSQL-injection-shaped reason (rejected as a non-string)", async () => {
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/ban`)
      .set(auth())
      .send({ reason: { $ne: null } });
    expect(res.status).toBe(400);
    expect(svc.banUser).not.toHaveBeenCalled();
  });
});
