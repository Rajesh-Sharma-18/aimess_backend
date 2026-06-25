/**
 * Direct invites:
 *   POST /:id/invites                  (mod creates an invite for a user)
 *   GET  /:id/invites                  (mod lists)
 *   GET  /invites/mine                 (invitee lists their invites)
 *   POST /invites/:inviteId/accept
 *   POST /invites/:inviteId/decline
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    bulkCreateInvites: jest.fn(),
    listCommunityInvites: jest.fn(),
    listMyInvites: jest.fn(),
    acceptInvite: jest.fn(),
    declineInvite: jest.fn(),
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
const INVITE = "b".repeat(24);
const USER1 = "11111111-1111-4111-8111-111111111111";
const USER2 = "22222222-2222-4222-8222-222222222222";
const USER3 = "33333333-3333-4333-8333-333333333333";
const SELF = USER1;

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

const bulkResult = (overrides = {}) => ({
  totalRequested: 1,
  invited: 1,
  alreadyInvited: 0,
  alreadyMembers: 0,
  failed: 0,
  results: [{ userId: USER2, outcome: "INVITED", inviteId: INVITE }],
  ...overrides,
});

describe("POST /:id/invites (bulk create)", () => {
  beforeEach(() => {
    svc.bulkCreateInvites.mockResolvedValue(bulkResult());
  });

  it("invites a single user → 201 with BulkInviteResult", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({ userIds: [USER2] });
    expect(res.status).toBe(201);
    expect(svc.bulkCreateInvites).toHaveBeenCalledWith(CID, SELF, [USER2]);
    expect(res.body.data).toMatchObject({ totalRequested: 1, invited: 1 });
  });

  it("invites multiple users → 201 with aggregate counts", async () => {
    svc.bulkCreateInvites.mockResolvedValue(
      bulkResult({
        totalRequested: 3,
        invited: 1,
        alreadyInvited: 1,
        alreadyMembers: 1,
        results: [
          { userId: USER1, outcome: "ALREADY_MEMBER" },
          { userId: USER2, outcome: "ALREADY_INVITED", inviteId: INVITE },
          { userId: USER3, outcome: "INVITED", inviteId: "c".repeat(24) },
        ],
      })
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({ userIds: [USER1, USER2, USER3] });
    expect(res.status).toBe(201);
    expect(res.body.data.totalRequested).toBe(3);
    expect(res.body.data.invited).toBe(1);
    expect(res.body.data.alreadyInvited).toBe(1);
    expect(res.body.data.alreadyMembers).toBe(1);
  });

  it("returns 400 when userIds is missing", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
    expect(svc.bulkCreateInvites).not.toHaveBeenCalled();
  });

  it("returns 400 when userIds is an empty array", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({ userIds: [] });
    expect(res.status).toBe(400);
    expect(svc.bulkCreateInvites).not.toHaveBeenCalled();
  });

  it("returns 400 when userIds contains a non-UUID", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({ userIds: ["not-a-uuid"] });
    expect(res.status).toBe(400);
    expect(svc.bulkCreateInvites).not.toHaveBeenCalled();
  });

  it("returns 400 when userIds contains more than 50 items", async () => {
    const ids = Array.from(
      { length: 51 },
      (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({ userIds: ids });
    expect(res.status).toBe(400);
    expect(svc.bulkCreateInvites).not.toHaveBeenCalled();
  });

  it("deduplicates duplicate userIds before calling service", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({ userIds: [USER2, USER2] });
    expect(res.status).toBe(201);
    // Dedup happens in the validator; service receives a de-duped array.
    expect(svc.bulkCreateInvites).toHaveBeenCalledWith(CID, SELF, [USER2]);
  });

  it("returns 403 when the caller is not a moderator", async () => {
    svc.bulkCreateInvites.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({ userIds: [USER2] });
    expect(res.status).toBe(403);
  });

  it("still returns 201 when all users are already invited (partial skip)", async () => {
    svc.bulkCreateInvites.mockResolvedValue(
      bulkResult({ totalRequested: 1, invited: 0, alreadyInvited: 1 })
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({ userIds: [USER2] });
    expect(res.status).toBe(201);
    expect(res.body.data.invited).toBe(0);
    expect(res.body.data.alreadyInvited).toBe(1);
  });
});

describe("GET invite lists", () => {
  it("lists community invites → 200", async () => {
    svc.listCommunityInvites.mockResolvedValue(emptyPage);
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/invites`)
      .set(auth());
    expect(res.status).toBe(200);
  });

  it("community invites 400 for an invalid status enum", async () => {
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/invites`)
      .query({ status: "WAT" })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("lists my invites → 200", async () => {
    svc.listMyInvites.mockResolvedValue(emptyPage);
    const res = await request(app)
      .get("/api/v1/communities/invites/mine")
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listMyInvites).toHaveBeenCalledTimes(1);
  });
});

describe("accept / decline", () => {
  it("accepts → 200", async () => {
    svc.acceptInvite.mockResolvedValue({
      inviteId: INVITE,
      status: "ACCEPTED",
    });
    const res = await request(app)
      .post(`/api/v1/communities/invites/${INVITE}/accept`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.acceptInvite).toHaveBeenCalledWith(SELF, INVITE);
  });

  it("declines → 200", async () => {
    svc.declineInvite.mockResolvedValue({
      inviteId: INVITE,
      status: "DECLINED",
    });
    const res = await request(app)
      .post(`/api/v1/communities/invites/${INVITE}/decline`)
      .set(auth());
    expect(res.status).toBe(200);
  });

  it("accept 404 when the invite is not the caller's (IDOR / not found)", async () => {
    svc.acceptInvite.mockRejectedValue(
      new NotFoundError("COMMUNITY_INVITE_NOT_FOUND")
    );
    const res = await request(app)
      .post(`/api/v1/communities/invites/${INVITE}/accept`)
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("accept 410 when the invite has expired", async () => {
    svc.acceptInvite.mockRejectedValue(
      new GoneError("COMMUNITY_INVITE_EXPIRED")
    );
    const res = await request(app)
      .post(`/api/v1/communities/invites/${INVITE}/accept`)
      .set(auth());
    expect(res.status).toBe(410);
  });

  it("accept 400 for an invalid inviteId param", async () => {
    const res = await request(app)
      .post("/api/v1/communities/invites/bad-id/accept")
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.acceptInvite).not.toHaveBeenCalled();
  });
});
