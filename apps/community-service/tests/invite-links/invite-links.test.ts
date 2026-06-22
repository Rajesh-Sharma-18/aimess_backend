/**
 * Invite links:
 *   POST   /:id/invite-links
 *   GET    /:id/invite-links
 *   DELETE /:id/invite-links/:linkId        (revoke)
 *   POST   /:id/invite-links/bulk-send
 *   POST   /invite-links/:code/redeem
 *   GET    /invite-links/:code              (public preview)
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    createInviteLink: jest.fn(),
    listInviteLinks: jest.fn(),
    revokeInviteLink: jest.fn(),
    bulkSendInviteLink: jest.fn(),
    redeemInviteLink: jest.fn(),
    lookupInviteLink: jest.fn(),
  },
}));

import request from "supertest";

import { ForbiddenError, GoneError, NotFoundError } from "@aimess/errors";

import { app } from "../../src/app.js";
import { communityService } from "../../src/services/community.service.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const svc = communityService as unknown as Record<string, jest.Mock>;
const auth = () => bearer(makeAccessToken());

const CID = "a".repeat(24);
const LINK = "b".repeat(24);
const SELF = "11111111-1111-4111-8111-111111111111";

const linkDto = (over: Record<string, unknown> = {}) => ({
  linkId: LINK,
  code: "abc123",
  url: "abc123",
  communityId: CID,
  isActive: true,
  ...over,
});

const emptyPage = {
  pagination: {
    totalData: 0,
    totalPage: 0,
    currentPage: 1,
    limit: 20,
    hasMore: false,
  },
  data: [],
};

describe("POST /:id/invite-links (create)", () => {
  beforeEach(() => {
    svc.createInviteLink.mockResolvedValue(linkDto());
  });

  it("creates with an empty body → 201", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invite-links`)
      .set(auth())
      .send({});
    expect(res.status).toBe(201);
    expect(svc.createInviteLink).toHaveBeenCalledTimes(1);
  });

  it("creates with options → 201", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invite-links`)
      .set(auth())
      .send({ maxUses: 10, expiresInMinutes: 60, autoApprove: true });
    expect(res.status).toBe(201);
    expect(svc.createInviteLink.mock.calls[0][2]).toMatchObject({
      maxUses: 10,
      expiresInMinutes: 60,
      autoApprove: true,
    });
  });

  it("returns 400 for maxUses below 1", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invite-links`)
      .set(auth())
      .send({ maxUses: 0 });
    expect(res.status).toBe(400);
    expect(svc.createInviteLink).not.toHaveBeenCalled();
  });

  it("returns 400 for maxUses above 1000", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invite-links`)
      .set(auth())
      .send({ maxUses: 1001 });
    expect(res.status).toBe(400);
  });

  it("returns 403 for a non-moderator", async () => {
    svc.createInviteLink.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invite-links`)
      .set(auth())
      .send({});
    expect(res.status).toBe(403);
  });
});

describe("GET + DELETE invite-links", () => {
  it("lists invite links → 200", async () => {
    svc.listInviteLinks.mockResolvedValue(emptyPage);
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/invite-links`)
      .set(auth());
    expect(res.status).toBe(200);
  });

  it("list 400 for an invalid status enum", async () => {
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/invite-links`)
      .query({ status: "dead" })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("revokes a link → 200", async () => {
    svc.revokeInviteLink.mockResolvedValue(linkDto({ isActive: false }));
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/invite-links/${LINK}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.revokeInviteLink).toHaveBeenCalledWith(CID, SELF, LINK);
  });

  it("revoke 404 when the link is gone", async () => {
    svc.revokeInviteLink.mockRejectedValue(
      new NotFoundError("COMMUNITY_INVITE_LINK_NOT_FOUND")
    );
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/invite-links/${LINK}`)
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("revoke 400 for an invalid linkId param", async () => {
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/invite-links/bad`)
      .set(auth());
    expect(res.status).toBe(400);
  });
});

describe("POST /:id/invite-links/bulk-send", () => {
  it("bulk-sends to users → 200", async () => {
    svc.bulkSendInviteLink.mockResolvedValue({ sent: 1, skipped: [] });
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invite-links/bulk-send`)
      .set(auth())
      .send({ userIds: ["c".repeat(24)] });
    expect(res.status).toBe(200);
    expect(svc.bulkSendInviteLink).toHaveBeenCalledTimes(1);
  });

  it("returns 400 with an empty userIds list", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invite-links/bulk-send`)
      .set(auth())
      .send({ userIds: [] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when more than 50 userIds are sent", async () => {
    const ids = Array.from({ length: 51 }, () => "c".repeat(24));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invite-links/bulk-send`)
      .set(auth())
      .send({ userIds: ids });
    expect(res.status).toBe(400);
  });
});

describe("POST /invite-links/:code/redeem", () => {
  it("redeems a valid code → 200", async () => {
    svc.redeemInviteLink.mockResolvedValue({ communityId: CID, joined: true });
    const res = await request(app)
      .post("/api/v1/communities/invite-links/abc_123-XYZ/redeem")
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.redeemInviteLink).toHaveBeenCalledWith("abc_123-XYZ", SELF);
  });

  it("returns 410 when the link has expired", async () => {
    svc.redeemInviteLink.mockRejectedValue(
      new GoneError("COMMUNITY_INVITE_LINK_EXPIRED")
    );
    const res = await request(app)
      .post("/api/v1/communities/invite-links/abc123/redeem")
      .set(auth());
    expect(res.status).toBe(410);
  });

  it("returns 404 for an unknown code", async () => {
    svc.redeemInviteLink.mockRejectedValue(
      new NotFoundError("COMMUNITY_INVITE_LINK_NOT_FOUND")
    );
    const res = await request(app)
      .post("/api/v1/communities/invite-links/abc123/redeem")
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("returns 400 for an illegal code (regex)", async () => {
    const res = await request(app)
      .post("/api/v1/communities/invite-links/bad code!/redeem")
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.redeemInviteLink).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// New tests — Private Community Invitation & Discovery System
// ---------------------------------------------------------------------------

const previewDto = (over: Partial<Record<string, unknown>> = {}) => ({
  communityId: CID,
  communityName: "Test Community",
  description: "A test community",
  avatarUrl: null,
  bannerUrl: null,
  memberCount: 42,
  communityType: "PRIVATE",
  isJoined: false,
  invitationCode: "abc123",
  inviteUrl: "https://example.com/invite/abc123",
  appDeepLink: "aimess://invite/abc123",
  expiresAt: null,
  creatorId: SELF,
  ...over,
});

describe("GET /invite-links/:code (invite link preview)", () => {
  beforeEach(() => {
    svc.lookupInviteLink.mockReset();
  });

  it("returns 401 when called without a token", async () => {
    const res = await request(app).get(
      "/api/v1/communities/invite-links/abc123"
    );
    expect(res.status).toBe(401);
    expect(svc.lookupInviteLink).not.toHaveBeenCalled();
  });

  it("returns 200 with community preview for an authenticated caller", async () => {
    svc.lookupInviteLink.mockResolvedValue(previewDto());
    const res = await request(app)
      .get("/api/v1/communities/invite-links/abc123")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.communityName).toBeDefined();
    expect(res.body.data.isJoined).toBe(false);
    expect(svc.lookupInviteLink).toHaveBeenCalledWith("abc123", SELF);
  });

  it("returns 200 with isJoined:true for authenticated ACTIVE member", async () => {
    svc.lookupInviteLink.mockResolvedValue(previewDto({ isJoined: true }));
    const res = await request(app)
      .get("/api/v1/communities/invite-links/abc123")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.isJoined).toBe(true);
    expect(svc.lookupInviteLink).toHaveBeenCalledWith("abc123", SELF);
  });

  it("returns 403 for a banned user", async () => {
    svc.lookupInviteLink.mockRejectedValue(
      new ForbiddenError("COMMUNITY_JOIN_BANNED")
    );
    const res = await request(app)
      .get("/api/v1/communities/invite-links/abc123")
      .set(auth());
    expect(res.status).toBe(403);
  });

  it("returns 410 for an expired link", async () => {
    svc.lookupInviteLink.mockRejectedValue(
      new GoneError("COMMUNITY_INVITE_LINK_EXPIRED")
    );
    const res = await request(app)
      .get("/api/v1/communities/invite-links/abc123")
      .set(auth());
    expect(res.status).toBe(410);
  });

  it("returns 410 for a revoked link", async () => {
    svc.lookupInviteLink.mockRejectedValue(
      new GoneError("COMMUNITY_INVITE_LINK_REVOKED_ERROR")
    );
    const res = await request(app)
      .get("/api/v1/communities/invite-links/abc123")
      .set(auth());
    expect(res.status).toBe(410);
  });

  it("returns 410 for an exhausted link", async () => {
    svc.lookupInviteLink.mockRejectedValue(
      new GoneError("COMMUNITY_INVITE_LINK_EXHAUSTED")
    );
    const res = await request(app)
      .get("/api/v1/communities/invite-links/abc123")
      .set(auth());
    expect(res.status).toBe(410);
  });

  it("returns 404 for a nonexistent code", async () => {
    svc.lookupInviteLink.mockRejectedValue(
      new NotFoundError("COMMUNITY_INVITE_LINK_NOT_FOUND")
    );
    const res = await request(app)
      .get("/api/v1/communities/invite-links/abc123")
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid code format (special chars)", async () => {
    const res = await request(app)
      .get("/api/v1/communities/invite-links/!!invalid!!")
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.lookupInviteLink).not.toHaveBeenCalled();
  });
});

describe("createInviteLink for PRIVATE community", () => {
  beforeEach(() => {
    svc.createInviteLink.mockReset();
  });

  it("returns 201 for a PRIVATE community (PUBLIC restriction removed)", async () => {
    svc.createInviteLink.mockResolvedValue(linkDto());
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invite-links`)
      .set(auth())
      .send({});
    expect(res.status).toBe(201);
    expect(svc.createInviteLink).toHaveBeenCalledTimes(1);
  });

  it("response includes appDeepLink", async () => {
    svc.createInviteLink.mockResolvedValue(
      linkDto({ appDeepLink: "aimess://invite/testcode" })
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invite-links`)
      .set(auth())
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.data.appDeepLink).toBe("aimess://invite/testcode");
  });
});

describe("redeemInviteLink for PRIVATE community", () => {
  beforeEach(() => {
    svc.redeemInviteLink.mockReset();
  });

  it("autoApprove:true → direct member in response, no request", async () => {
    svc.redeemInviteLink.mockResolvedValue({
      link: linkDto({ autoApprove: true }),
      member: { memberId: "m1", status: "ACTIVE" },
    });
    const res = await request(app)
      .post("/api/v1/communities/invite-links/abc123/redeem")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.member).toBeDefined();
    expect(res.body.data.request).toBeUndefined();
  });

  it("autoApprove:false → join request in response, no member", async () => {
    svc.redeemInviteLink.mockResolvedValue({
      link: linkDto({ autoApprove: false }),
      request: { requestId: "r1", status: "PENDING" },
    });
    const res = await request(app)
      .post("/api/v1/communities/invite-links/abc123/redeem")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.request).toBeDefined();
    expect(res.body.data.member).toBeUndefined();
  });
});
