/**
 * Member moderation (MODERATOR+):
 *   POST   /:id/members/:userId/mute
 *   DELETE /:id/members/:userId/mute
 *   GET    /:id/muted-members
 *   POST   /:id/members/:userId/warn
 *   GET    /:id/members/:userId/warnings
 *   GET    /:id/audit-logs
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    muteMember: jest.fn(),
    unmuteMember: jest.fn(),
    listMutedMembers: jest.fn(),
    warnMember: jest.fn(),
    listMemberWarnings: jest.fn(),
    listAuditLogs: jest.fn(),
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

describe("POST /:id/members/:userId/mute", () => {
  beforeEach(() => {
    svc.muteMember.mockResolvedValue({ userId: TARGET, mutedUntil: null });
  });

  it("mutes indefinitely with an empty body → 200", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/mute`)
      .set(auth())
      .send({});
    expect(res.status).toBe(200);
    expect(svc.muteMember).toHaveBeenCalledWith(
      CID,
      SELF,
      TARGET,
      null,
      undefined
    );
  });

  it("mutes with a duration + reason → 200", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/mute`)
      .set(auth())
      .send({ durationMinutes: 60, reason: "cool off" });
    expect(res.status).toBe(200);
    expect(svc.muteMember).toHaveBeenCalledWith(
      CID,
      SELF,
      TARGET,
      60,
      "cool off"
    );
  });

  it("returns 400 for a non-integer / out-of-range duration", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/mute`)
      .set(auth())
      .send({ durationMinutes: 0 });
    expect(res.status).toBe(400);
    expect(svc.muteMember).not.toHaveBeenCalled();
  });

  it("returns 400 when duration exceeds the 365-day cap", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/mute`)
      .set(auth())
      .send({ durationMinutes: 525_601 });
    expect(res.status).toBe(400);
  });

  it("returns 403 when the caller can't moderate the target", async () => {
    svc.muteMember.mockRejectedValue(new ForbiddenError("COMMUNITY_FORBIDDEN"));
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/mute`)
      .set(auth())
      .send({});
    expect(res.status).toBe(403);
  });

  it("returns 404 when the target member is not found", async () => {
    svc.muteMember.mockRejectedValue(
      new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/mute`)
      .set(auth())
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("DELETE /:id/members/:userId/mute (unmute)", () => {
  it("unmutes → 200 null data", async () => {
    svc.unmuteMember.mockResolvedValue(undefined);
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/members/${TARGET}/mute`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(svc.unmuteMember).toHaveBeenCalledWith(CID, SELF, TARGET);
  });

  it("returns 400 for an invalid target uuid", async () => {
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/members/not-uuid/mute`)
      .set(auth());
    expect(res.status).toBe(400);
  });
});

describe("GET /:id/muted-members", () => {
  it("returns 200 with paginated muted members", async () => {
    svc.listMutedMembers.mockResolvedValue(emptyPage);
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/muted-members`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.data).toEqual([]);
  });

  it("returns 403 for a non-moderator", async () => {
    svc.listMutedMembers.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/muted-members`)
      .set(auth());
    expect(res.status).toBe(403);
  });
});

describe("POST /:id/members/:userId/warn", () => {
  beforeEach(() => {
    svc.warnMember.mockResolvedValue({ id: "w".repeat(24), note: "warn 1" });
  });

  it("warns a member → 201", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/warn`)
      .set(auth())
      .send({ note: "Be respectful" });
    expect(res.status).toBe(201);
    expect(svc.warnMember).toHaveBeenCalledWith(
      CID,
      SELF,
      TARGET,
      "Be respectful"
    );
  });

  it("returns 400 when note is missing (required)", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/warn`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
    expect(svc.warnMember).not.toHaveBeenCalled();
  });

  it("returns 400 when note is an empty string", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/warn`)
      .set(auth())
      .send({ note: "   " });
    expect(res.status).toBe(400);
  });

  it("returns 400 when note exceeds 1000 chars", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/warn`)
      .set(auth())
      .send({ note: "x".repeat(1001) });
    expect(res.status).toBe(400);
  });

  it("accepts a unicode/emoji note", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/warn`)
      .set(auth())
      .send({ note: "Final warning 🚫 — последнее предупреждение" });
    expect(res.status).toBe(201);
  });

  it("returns 400 when warning the admin (service guard)", async () => {
    svc.warnMember.mockRejectedValue(
      new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/members/${TARGET}/warn`)
      .set(auth())
      .send({ note: "warn" });
    expect(res.status).toBe(400);
  });
});

describe("GET /:id/members/:userId/warnings and /:id/audit-logs", () => {
  it("lists warnings → 200", async () => {
    svc.listMemberWarnings.mockResolvedValue(emptyPage);
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/members/${TARGET}/warnings`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listMemberWarnings).toHaveBeenCalledTimes(1);
  });

  it("lists audit logs → 200", async () => {
    svc.listAuditLogs.mockResolvedValue(emptyPage);
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/audit-logs`)
      .set(auth());
    expect(res.status).toBe(200);
  });

  it("audit-logs 403 for a non-privileged caller", async () => {
    svc.listAuditLogs.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/audit-logs`)
      .set(auth());
    expect(res.status).toBe(403);
  });

  it("audit-logs 400 for a non-positive page", async () => {
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/audit-logs`)
      .query({ page: -1 })
      .set(auth());
    expect(res.status).toBe(400);
  });
});
