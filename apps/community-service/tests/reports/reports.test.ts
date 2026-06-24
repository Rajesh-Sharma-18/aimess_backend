/**
 * Reports:
 *   POST   /:id/reports
 *   GET    /:id/reports
 *   GET    /reports/mine
 *   POST   /:id/reports/:reportId/review
 *   POST   /:id/reports/:reportId/action
 *   POST   /:id/reports/:reportId/dismiss
 *   POST   /:id/reports/:reportId/withdraw
 *   DELETE /:id/reports/:reportId
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    createReport: jest.fn(),
    listCommunityReports: jest.fn(),
    listMyReports: jest.fn(),
    reviewReport: jest.fn(),
    actionReport: jest.fn(),
    dismissReport: jest.fn(),
    withdrawReport: jest.fn(),
    deleteReport: jest.fn(),
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
const REPORT = "b".repeat(24);
const TARGET = "33333333-3333-4333-8333-333333333333";
const SELF = "11111111-1111-4111-8111-111111111111";

const reportDto = (over: Record<string, unknown> = {}) => ({
  reportId: REPORT,
  communityId: CID,
  reporterId: SELF,
  targetUserId: TARGET,
  reason: "spam everywhere",
  status: "OPEN",
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

describe("POST /:id/reports (create)", () => {
  beforeEach(() => {
    svc.createReport.mockResolvedValue(reportDto());
  });

  it("creates a report → 201", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports`)
      .set(auth())
      .send({ targetUserId: TARGET, reason: "harassment in chat" });
    expect(res.status).toBe(201);
    expect(svc.createReport).toHaveBeenCalledWith(CID, SELF, {
      targetUserId: TARGET,
      reason: "harassment in chat",
    });
  });

  it("creates a community-level report (no target) → 201", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports`)
      .set(auth())
      .send({ reason: "inappropriate content" });
    expect(res.status).toBe(201);
  });

  it("returns 400 when reason is missing", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports`)
      .set(auth())
      .send({ targetUserId: TARGET });
    expect(res.status).toBe(400);
    expect(svc.createReport).not.toHaveBeenCalled();
  });

  it("returns 400 when reason is too short (<3)", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports`)
      .set(auth())
      .send({ reason: "ab" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when reason exceeds 1000 chars", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports`)
      .set(auth())
      .send({ reason: "x".repeat(1001) });
    expect(res.status).toBe(400);
  });

  it("returns 400 when targetUserId is not a uuid", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports`)
      .set(auth())
      .send({ targetUserId: "not-uuid", reason: "valid reason here" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the community does not exist", async () => {
    svc.createReport.mockRejectedValue(
      new NotFoundError("COMMUNITY_NOT_FOUND")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports`)
      .set(auth())
      .send({ reason: "valid reason here" });
    expect(res.status).toBe(404);
  });

  it("forwards the reported-content snapshot (message + media + postedAt) → 201", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports`)
      .set(auth())
      .send({
        targetUserId: TARGET,
        reason: "spam messages",
        reportedMessageId: "msg_123",
        reportedContentType: "IMAGE",
        reportedContentText: "check this out",
        reportedContentPostedAt: "2026-02-02T10:00:00.000Z",
        reportedContentMedia: [
          { objectKey: "community-chat/abc.jpg", contentType: "image/jpeg" },
        ],
      });
    expect(res.status).toBe(201);
    expect(svc.createReport).toHaveBeenCalledWith(
      CID,
      SELF,
      expect.objectContaining({
        reportedMessageId: "msg_123",
        reportedContentType: "IMAGE",
        reportedContentText: "check this out",
        reportedContentPostedAt: new Date("2026-02-02T10:00:00.000Z"),
        reportedContentMedia: [
          { objectKey: "community-chat/abc.jpg", contentType: "image/jpeg" },
        ],
      })
    );
  });

  it("400 when a reported media entry is missing objectKey", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports`)
      .set(auth())
      .send({
        reason: "spam messages",
        reportedContentMedia: [{ contentType: "image/jpeg" }],
      });
    expect(res.status).toBe(400);
    expect(svc.createReport).not.toHaveBeenCalled();
  });

  it("400 when more than 10 reported media entries", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports`)
      .set(auth())
      .send({
        reason: "spam messages",
        reportedContentMedia: Array.from({ length: 11 }, (_, i) => ({
          objectKey: `community-chat/${i}.jpg`,
        })),
      });
    expect(res.status).toBe(400);
  });
});

describe("GET report lists", () => {
  it("lists community reports → 200", async () => {
    svc.listCommunityReports.mockResolvedValue(emptyPage);
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/reports`)
      .set(auth());
    expect(res.status).toBe(200);
  });

  it("community reports 403 for a non-moderator", async () => {
    svc.listCommunityReports.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/reports`)
      .set(auth());
    expect(res.status).toBe(403);
  });

  it("community reports 400 for an invalid status enum", async () => {
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/reports`)
      .query({ status: "PENDING" })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("lists my reports → 200", async () => {
    svc.listMyReports.mockResolvedValue(emptyPage);
    const res = await request(app)
      .get("/api/v1/communities/reports/mine")
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listMyReports).toHaveBeenCalledTimes(1);
  });
});

describe("review / action / dismiss / withdraw / delete", () => {
  it("reviews → 200, forwards optional resolution", async () => {
    svc.reviewReport.mockResolvedValue(reportDto({ status: "REVIEWED" }));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports/${REPORT}/review`)
      .set(auth())
      .send({ resolution: "looked into it" });
    expect(res.status).toBe(200);
    expect(svc.reviewReport).toHaveBeenCalledWith(
      CID,
      SELF,
      REPORT,
      "looked into it"
    );
  });

  it("review with empty body forwards null resolution", async () => {
    svc.reviewReport.mockResolvedValue(reportDto({ status: "REVIEWED" }));
    await request(app)
      .post(`/api/v1/communities/${CID}/reports/${REPORT}/review`)
      .set(auth())
      .send({});
    expect(svc.reviewReport).toHaveBeenCalledWith(CID, SELF, REPORT, null);
  });

  it("actions → 200", async () => {
    svc.actionReport.mockResolvedValue(reportDto({ status: "ACTIONED" }));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports/${REPORT}/action`)
      .set(auth())
      .send({});
    expect(res.status).toBe(200);
  });

  it("dismisses → 200", async () => {
    svc.dismissReport.mockResolvedValue(reportDto({ status: "DISMISSED" }));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports/${REPORT}/dismiss`)
      .set(auth())
      .send({});
    expect(res.status).toBe(200);
  });

  it("withdraws (reporter self) → 200", async () => {
    svc.withdrawReport.mockResolvedValue(reportDto({ status: "WITHDRAWN" }));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports/${REPORT}/withdraw`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.withdrawReport).toHaveBeenCalledWith(CID, SELF, REPORT);
  });

  it("withdraw 403 when the caller is not the reporter (IDOR guard)", async () => {
    svc.withdrawReport.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports/${REPORT}/withdraw`)
      .set(auth());
    expect(res.status).toBe(403);
  });

  it("review 400 when resolution exceeds 1000 chars", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports/${REPORT}/review`)
      .set(auth())
      .send({ resolution: "x".repeat(1001) });
    expect(res.status).toBe(400);
    expect(svc.reviewReport).not.toHaveBeenCalled();
  });

  it("review 400 for an invalid reportId param", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports/bad-id/review`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
  });

  it("action 400 when not OPEN (illegal transition)", async () => {
    svc.actionReport.mockRejectedValue(
      new BadRequestError("COMMUNITY_REPORT_NOT_OPEN")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/reports/${REPORT}/action`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
  });

  it("deletes a report → 200 null data", async () => {
    svc.deleteReport.mockResolvedValue(undefined);
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/reports/${REPORT}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(svc.deleteReport).toHaveBeenCalledWith(CID, SELF, REPORT);
  });

  it("delete 403 for a non-moderator", async () => {
    svc.deleteReport.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/reports/${REPORT}`)
      .set(auth());
    expect(res.status).toBe(403);
  });
});
