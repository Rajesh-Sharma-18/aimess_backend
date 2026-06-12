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
    createInvite: jest.fn(),
    listCommunityInvites: jest.fn(),
    listMyInvites: jest.fn(),
    acceptInvite: jest.fn(),
    declineInvite: jest.fn(),
  },
}));

import request from "supertest";

import {
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from "@aimess/errors";

import { app } from "../../src/app.js";
import { communityService } from "../../src/services/community.service.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const svc = communityService as unknown as Record<string, jest.Mock>;
const auth = () => bearer(makeAccessToken());

const CID = "a".repeat(24);
const INVITE = "b".repeat(24);
const INVITEE = "33333333-3333-4333-8333-333333333333";
const SELF = "11111111-1111-4111-8111-111111111111";

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

describe("POST /:id/invites (create)", () => {
  beforeEach(() => {
    svc.createInvite.mockResolvedValue({
      inviteId: INVITE,
      communityId: CID,
      inviteeId: INVITEE,
      status: "PENDING",
    });
  });

  it("creates an invite → 201", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({ inviteeId: INVITEE });
    expect(res.status).toBe(201);
    expect(svc.createInvite).toHaveBeenCalledWith(CID, SELF, INVITEE);
  });

  it("returns 400 when inviteeId is missing", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
    expect(svc.createInvite).not.toHaveBeenCalled();
  });

  it("returns 400 when inviteeId is not a uuid", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({ inviteeId: "nope" });
    expect(res.status).toBe(400);
  });

  it("returns 409 when an invite already exists", async () => {
    svc.createInvite.mockRejectedValue(
      new ConflictError("COMMUNITY_INVITE_EXISTS")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({ inviteeId: INVITEE });
    expect(res.status).toBe(409);
  });

  it("returns 403 when the caller is not a moderator", async () => {
    svc.createInvite.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/invites`)
      .set(auth())
      .send({ inviteeId: INVITEE });
    expect(res.status).toBe(403);
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
