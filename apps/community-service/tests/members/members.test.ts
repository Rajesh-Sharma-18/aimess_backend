/**
 * Membership management:
 *   GET    /:id/members
 *   POST   /:id/members
 *   PUT    /:id/members/:userId/role
 *   DELETE /:id/members/:userId            (kick)
 *   POST   /:id/members/:userId/ban
 *   DELETE /:id/members/:userId/ban        (unban)
 *   POST   /:id/leave
 *   POST   /leave/bulk
 *   POST   /:id/transfer-admin
 *   POST   /:id/join
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    listMembers: jest.fn(),
    addMembers: jest.fn(),
    updateMemberRole: jest.fn(),
    kickMember: jest.fn(),
    banMember: jest.fn(),
    unbanMember: jest.fn(),
    leaveCommunity: jest.fn(),
    bulkLeaveCommunities: jest.fn(),
    transferAdmin: jest.fn(),
    joinCommunity: jest.fn(),
  },
}));

import request from "supertest";

import { BadRequestError, ForbiddenError, NotFoundError } from "@aimess/errors";

import { app } from "../../src/app.js";
import { communityService } from "../../src/services/community.service.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const svc = communityService as unknown as Record<string, jest.Mock>;
const auth = () => bearer(makeAccessToken());

const CID = "a".repeat(24);
const TARGET = "33333333-3333-4333-8333-333333333333";
const SELF = "11111111-1111-4111-8111-111111111111";

const memberDto = (over: Record<string, unknown> = {}) => ({
  userId: TARGET,
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: new Date("2026-01-01T00:00:00.000Z"),
  snapshotUsername: "bob",
  snapshotDisplayName: "Bob",
  ...over,
});

describe("GET /:id/members", () => {
  beforeEach(() => {
    svc.listMembers.mockResolvedValue({
      pagination: {
        totalData: 1,
        totalPage: 1,
        currentPage: 1,
        limit: 20,
        hasMore: false,
      },
      data: [memberDto()],
    });
  });

  it("returns 200 with paginated members", async () => {
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/members`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  it("filters by status when provided", async () => {
    await request(app)
      .get(`/api/v1/communities/${CID}/members`)
      .query({ status: "BANNED" })
      .set(auth());
    expect(svc.listMembers.mock.calls[0][2].status).toBe("BANNED");
  });

  it("returns 400 for an invalid status enum", async () => {
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/members`)
      .query({ status: "GHOST" })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 403 for a private community the caller cannot view", async () => {
    svc.listMembers.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/members`)
      .set(auth());
    expect(res.status).toBe(403);
  });

  it("returns 400 for an invalid community id", async () => {
    const res = await request(app)
      .get("/api/v1/communities/bad-id/members")
      .set(auth());
    expect(res.status).toBe(400);
  });
});

describe("POST /:id/members (add)", () => {
  beforeEach(() => {
    svc.addMembers.mockResolvedValue({ added: [memberDto()], skipped: [] });
  });

  it("adds members → 201", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members`)
      .set(auth())
      .send({ userIds: [TARGET] });
    expect(res.status).toBe(201);
    expect(svc.addMembers).toHaveBeenCalledWith(CID, SELF, [TARGET]);
  });

  it("returns 400 on an empty userIds array (min 1)", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members`)
      .set(auth())
      .send({ userIds: [] });
    expect(res.status).toBe(400);
    expect(svc.addMembers).not.toHaveBeenCalled();
  });

  it("returns 400 when a userId is not a uuid", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members`)
      .set(auth())
      .send({ userIds: ["not-a-uuid"] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when more than 100 userIds are sent", async () => {
    const ids = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members`)
      .set(auth())
      .send({ userIds: ids });
    expect(res.status).toBe(400);
  });

  it("returns 403 when the caller is below MODERATOR", async () => {
    svc.addMembers.mockRejectedValue(new ForbiddenError("COMMUNITY_FORBIDDEN"));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members`)
      .set(auth())
      .send({ userIds: [TARGET] });
    expect(res.status).toBe(403);
  });
});

describe("PUT /:id/members/:userId/role", () => {
  beforeEach(() => {
    svc.updateMemberRole.mockResolvedValue(memberDto({ role: "MODERATOR" }));
  });

  it("promotes a member → 200", async () => {
    const res = await request(app)
      .put(`/api/v1/communities/${CID}/members/${TARGET}/role`)
      .set(auth())
      .send({ role: "MODERATOR" });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe("MODERATOR");
    expect(svc.updateMemberRole).toHaveBeenCalledWith(
      CID,
      SELF,
      TARGET,
      "MODERATOR"
    );
  });

  it("returns 400 for an invalid role enum (cannot assign ADMIN)", async () => {
    const res = await request(app)
      .put(`/api/v1/communities/${CID}/members/${TARGET}/role`)
      .set(auth())
      .send({ role: "ADMIN" });
    expect(res.status).toBe(400);
    expect(svc.updateMemberRole).not.toHaveBeenCalled();
  });

  it("returns 400 when targeting a non-uuid userId", async () => {
    const res = await request(app)
      .put(`/api/v1/communities/${CID}/members/not-a-uuid/role`)
      .set(auth())
      .send({ role: "MEMBER" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the target member is not found", async () => {
    svc.updateMemberRole.mockRejectedValue(
      new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND")
    );
    const res = await request(app)
      .put(`/api/v1/communities/${CID}/members/${TARGET}/role`)
      .set(auth())
      .send({ role: "MEMBER" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when trying to modify the admin", async () => {
    svc.updateMemberRole.mockRejectedValue(
      new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN")
    );
    const res = await request(app)
      .put(`/api/v1/communities/${CID}/members/${TARGET}/role`)
      .set(auth())
      .send({ role: "MEMBER" });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /:id/members/:userId (kick)", () => {
  beforeEach(() => {
    svc.kickMember.mockResolvedValue(memberDto({ status: "LEFT" }));
  });

  it("kicks a member → 200, forwards optional reason", async () => {
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/members/${TARGET}`)
      .set(auth())
      .send({ reason: "spam" });
    expect(res.status).toBe(200);
    expect(svc.kickMember).toHaveBeenCalledWith(CID, SELF, TARGET, "spam");
  });

  it("succeeds with an empty body (reason optional)", async () => {
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/members/${TARGET}`)
      .set(auth())
      .send({});
    expect(res.status).toBe(200);
  });

  it("returns 400 when reason exceeds 500 chars", async () => {
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/members/${TARGET}`)
      .set(auth())
      .send({ reason: "x".repeat(501) });
    expect(res.status).toBe(400);
    expect(svc.kickMember).not.toHaveBeenCalled();
  });

  it("returns 403 when a peer moderator can't outrank target", async () => {
    svc.kickMember.mockRejectedValue(new ForbiddenError("COMMUNITY_FORBIDDEN"));
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/members/${TARGET}`)
      .set(auth())
      .send({});
    expect(res.status).toBe(403);
  });

  it("returns 400 when trying to kick self", async () => {
    svc.kickMember.mockRejectedValue(
      new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_SELF")
    );
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/members/${SELF}`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("POST + DELETE /:id/members/:userId/ban", () => {
  it("bans a member → 200", async () => {
    svc.banMember.mockResolvedValue(memberDto({ status: "BANNED" }));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/ban`)
      .set(auth())
      .send({ reason: "abuse" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("BANNED");
    expect(svc.banMember).toHaveBeenCalledWith(CID, SELF, TARGET, "abuse");
  });

  it("returns 403 when the caller is not an admin", async () => {
    svc.banMember.mockRejectedValue(new ForbiddenError("COMMUNITY_FORBIDDEN"));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/ban`)
      .set(auth())
      .send({});
    expect(res.status).toBe(403);
  });

  it("unbans a member → 200", async () => {
    svc.unbanMember.mockResolvedValue(memberDto({ status: "LEFT" }));
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/members/${TARGET}/ban`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.unbanMember).toHaveBeenCalledWith(CID, SELF, TARGET);
  });

  it("unban returns 404 when no ban exists", async () => {
    svc.unbanMember.mockRejectedValue(
      new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND")
    );
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/members/${TARGET}/ban`)
      .set(auth());
    expect(res.status).toBe(404);
  });
});

describe("POST /:id/leave and POST /leave/bulk", () => {
  it("leaves with an empty body → 200", async () => {
    svc.leaveCommunity.mockResolvedValue(memberDto({ status: "LEFT" }));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/leave`)
      .set(auth())
      .send({});
    expect(res.status).toBe(200);
    expect(svc.leaveCommunity).toHaveBeenCalledTimes(1);
  });

  it("leaves with a reason enum → 200", async () => {
    svc.leaveCommunity.mockResolvedValue(memberDto({ status: "LEFT" }));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/leave`)
      .set(auth())
      .send({ reason: "NOT_RELEVANT" });
    expect(res.status).toBe(200);
  });

  it("returns 400 for an invalid leave-reason enum", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/leave`)
      .set(auth())
      .send({ reason: "BECAUSE" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when reason=OTHER but reasonText is missing (refine)", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/leave`)
      .set(auth())
      .send({ reason: "OTHER" });
    expect(res.status).toBe(400);
    expect(svc.leaveCommunity).not.toHaveBeenCalled();
  });

  it("accepts reason=OTHER with reasonText", async () => {
    svc.leaveCommunity.mockResolvedValue(memberDto({ status: "LEFT" }));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/leave`)
      .set(auth())
      .send({ reason: "OTHER", reasonText: "moving on" });
    expect(res.status).toBe(200);
  });

  it("bulk-leave returns 200", async () => {
    svc.bulkLeaveCommunities.mockResolvedValue({ left: 2 });
    const res = await request(app)
      .post("/api/v1/communities/leave/bulk")
      .set(auth())
      .send({ communityIds: [CID, "b".repeat(24)] });
    expect(res.status).toBe(200);
    expect(svc.bulkLeaveCommunities).toHaveBeenCalledTimes(1);
  });

  it("bulk-leave returns 400 with an empty list", async () => {
    const res = await request(app)
      .post("/api/v1/communities/leave/bulk")
      .set(auth())
      .send({ communityIds: [] });
    expect(res.status).toBe(400);
  });
});

describe("POST /:id/transfer-admin and POST /:id/join", () => {
  it("transfers admin → 200", async () => {
    svc.transferAdmin.mockResolvedValue({ id: CID, adminId: TARGET });
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/transfer-admin`)
      .set(auth())
      .send({ userId: TARGET });
    expect(res.status).toBe(200);
    expect(svc.transferAdmin).toHaveBeenCalledWith(CID, SELF, TARGET);
  });

  it("transfer-admin 400 when userId is missing", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/transfer-admin`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
  });

  it("transfer-admin 403 when caller is not the admin", async () => {
    svc.transferAdmin.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/transfer-admin`)
      .set(auth())
      .send({ userId: TARGET });
    expect(res.status).toBe(403);
  });

  it("join → 201 (creates a join request)", async () => {
    svc.joinCommunity.mockResolvedValue({
      requestId: "c".repeat(24),
      status: "PENDING",
    });
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/join`)
      .set(auth());
    expect(res.status).toBe(201);
    expect(svc.joinCommunity).toHaveBeenCalledWith(CID, SELF);
  });

  it("join 404 when the community does not exist", async () => {
    svc.joinCommunity.mockRejectedValue(
      new NotFoundError("COMMUNITY_NOT_FOUND")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/join`)
      .set(auth());
    expect(res.status).toBe(404);
  });
});
