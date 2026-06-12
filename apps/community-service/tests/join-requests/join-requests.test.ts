/**
 * Join requests:
 *   POST   /:id/join-requests
 *   GET    /:id/join-requests
 *   GET    /join-requests/mine
 *   POST   /:id/join-requests/:requestId/approve
 *   POST   /:id/join-requests/:requestId/reject
 *   DELETE /:id/join-requests/:requestId        (cancel)
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    createJoinRequest: jest.fn(),
    listCommunityJoinRequests: jest.fn(),
    listMyJoinRequests: jest.fn(),
    approveJoinRequest: jest.fn(),
    rejectJoinRequest: jest.fn(),
    cancelJoinRequest: jest.fn(),
  },
}));

import request from "supertest";

import { ConflictError, ForbiddenError, NotFoundError } from "@aimess/errors";

import { app } from "../../src/app.js";
import { communityService } from "../../src/services/community.service.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const svc = communityService as unknown as Record<string, jest.Mock>;
const auth = () => bearer(makeAccessToken());

const CID = "a".repeat(24);
const RID = "b".repeat(24);
const SELF = "11111111-1111-4111-8111-111111111111";

const reqDto = (over: Record<string, unknown> = {}) => ({
  requestId: RID,
  communityId: CID,
  userId: SELF,
  status: "PENDING",
  message: null,
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

describe("POST /:id/join-requests (create)", () => {
  beforeEach(() => {
    svc.createJoinRequest.mockResolvedValue(reqDto());
  });

  it("creates with no message → 201", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/join-requests`)
      .set(auth())
      .send({});
    expect(res.status).toBe(201);
    expect(svc.createJoinRequest).toHaveBeenCalledWith(CID, SELF, null);
  });

  it("creates with a message → 201, forwards the message", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/join-requests`)
      .set(auth())
      .send({ message: "please let me in" });
    expect(res.status).toBe(201);
    expect(svc.createJoinRequest).toHaveBeenCalledWith(
      CID,
      SELF,
      "please let me in"
    );
  });

  it("returns 400 when message exceeds 500 chars", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/join-requests`)
      .set(auth())
      .send({ message: "x".repeat(501) });
    expect(res.status).toBe(400);
    expect(svc.createJoinRequest).not.toHaveBeenCalled();
  });

  it("returns 409 when a request already exists", async () => {
    svc.createJoinRequest.mockRejectedValue(
      new ConflictError("COMMUNITY_JOIN_REQUEST_EXISTS")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/join-requests`)
      .set(auth())
      .send({});
    expect(res.status).toBe(409);
  });

  it("returns 404 when the community does not exist", async () => {
    svc.createJoinRequest.mockRejectedValue(
      new NotFoundError("COMMUNITY_NOT_FOUND")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/join-requests`)
      .set(auth())
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("GET list endpoints", () => {
  it("lists community join-requests → 200", async () => {
    svc.listCommunityJoinRequests.mockResolvedValue(emptyPage);
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/join-requests`)
      .set(auth());
    expect(res.status).toBe(200);
  });

  it("community join-requests filters by status", async () => {
    svc.listCommunityJoinRequests.mockResolvedValue(emptyPage);
    await request(app)
      .get(`/api/v1/communities/${CID}/join-requests`)
      .query({ status: "PENDING" })
      .set(auth());
    expect(svc.listCommunityJoinRequests.mock.calls[0][2].status).toBe(
      "PENDING"
    );
  });

  it("community join-requests 400 for invalid status enum", async () => {
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/join-requests`)
      .query({ status: "MAYBE" })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("community join-requests 403 for a non-moderator", async () => {
    svc.listCommunityJoinRequests.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/join-requests`)
      .set(auth());
    expect(res.status).toBe(403);
  });

  it("lists my join-requests → 200", async () => {
    svc.listMyJoinRequests.mockResolvedValue(emptyPage);
    const res = await request(app)
      .get("/api/v1/communities/join-requests/mine")
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listMyJoinRequests).toHaveBeenCalledTimes(1);
  });
});

describe("approve / reject / cancel", () => {
  it("approves → 200", async () => {
    svc.approveJoinRequest.mockResolvedValue(reqDto({ status: "APPROVED" }));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/join-requests/${RID}/approve`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.approveJoinRequest).toHaveBeenCalledWith(CID, SELF, RID);
  });

  it("rejects → 200", async () => {
    svc.rejectJoinRequest.mockResolvedValue(reqDto({ status: "REJECTED" }));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/join-requests/${RID}/reject`)
      .set(auth());
    expect(res.status).toBe(200);
  });

  it("cancels (self) → 200", async () => {
    svc.cancelJoinRequest.mockResolvedValue(reqDto({ status: "CANCELLED" }));
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/join-requests/${RID}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.cancelJoinRequest).toHaveBeenCalledWith(CID, SELF, RID);
  });

  it("approve 404 when the request is gone (IDOR-safe / not found)", async () => {
    svc.approveJoinRequest.mockRejectedValue(
      new NotFoundError("COMMUNITY_JOIN_REQUEST_NOT_FOUND")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/join-requests/${RID}/approve`)
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("approve 403 for a non-moderator", async () => {
    svc.approveJoinRequest.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/join-requests/${RID}/approve`)
      .set(auth());
    expect(res.status).toBe(403);
  });

  it("approve 400 for an invalid requestId param", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/join-requests/not-an-id/approve`)
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.approveJoinRequest).not.toHaveBeenCalled();
  });
});
