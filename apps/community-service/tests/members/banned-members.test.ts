/**
 * Banned-members moderation list + dedicated unban alias:
 *   GET  /:id/banned-members
 *   POST /:id/banned-members/:userId/unban
 *
 * Controller/route layer (service is mocked). Covers pagination, search, sort
 * forwarding, permission (403) / not-found (404) propagation, query validation,
 * and the unban alias delegating to communityService.unbanMember.
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    listBannedMembers: jest.fn(),
    unbanMember: jest.fn(),
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

const sampleRow = {
  userId: TARGET,
  username: "john",
  displayName: "John Doe",
  avatarUrl: null,
  avatarUrlExpiresIn: null,
  avatar: { url: null },
  bannedAt: 1749983445000,
  bannedBy: { userId: SELF, displayName: "Admin" },
  banReason: "Spam",
  banType: "PERMANENT",
};

describe("GET /:id/banned-members", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 200 with paginated banned members and applies defaults", async () => {
    svc.listBannedMembers.mockResolvedValue({
      ...emptyPage,
      data: [sampleRow],
      pagination: { ...emptyPage.pagination, totalData: 1 },
    });

    const res = await request(app)
      .get(`/api/v1/communities/${CID}/banned-members`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.data[0]).toMatchObject({
      userId: TARGET,
      banType: "PERMANENT",
      banReason: "Spam",
    });
    // Defaults: page 1, limit 20, sortBy bannedAt desc, no search.
    expect(svc.listBannedMembers).toHaveBeenCalledWith(CID, SELF, {
      page: 1,
      limit: 20,
      search: undefined,
      sortBy: "bannedAt",
      sortOrder: "desc",
    });
  });

  it("forwards search + sort query params to the service", async () => {
    svc.listBannedMembers.mockResolvedValue(emptyPage);

    const res = await request(app)
      .get(`/api/v1/communities/${CID}/banned-members`)
      .query({
        page: 2,
        limit: 10,
        search: "john",
        sortBy: "displayName",
        sortOrder: "asc",
      })
      .set(auth());

    expect(res.status).toBe(200);
    expect(svc.listBannedMembers).toHaveBeenCalledWith(CID, SELF, {
      page: 2,
      limit: 10,
      search: "john",
      sortBy: "displayName",
      sortOrder: "asc",
    });
  });

  it("returns 403 for a non-moderator caller", async () => {
    svc.listBannedMembers.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/banned-members`)
      .set(auth());
    expect(res.status).toBe(403);
  });

  it("returns 404 when the community is not found", async () => {
    svc.listBannedMembers.mockRejectedValue(
      new NotFoundError("COMMUNITY_NOT_FOUND")
    );
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/banned-members`)
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid sortBy enum", async () => {
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/banned-members`)
      .query({ sortBy: "createdAt" })
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.listBannedMembers).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid sortOrder enum", async () => {
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/banned-members`)
      .query({ sortOrder: "ascending" })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-positive page", async () => {
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/banned-members`)
      .query({ page: 0 })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 400 when search exceeds 100 chars", async () => {
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/banned-members`)
      .query({ search: "x".repeat(101) })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid community id", async () => {
    const res = await request(app)
      .get("/api/v1/communities/bad-id/banned-members")
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.listBannedMembers).not.toHaveBeenCalled();
  });
});

describe("POST /:id/banned-members/:userId/unban (dedicated alias)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("unbans → 200 and delegates to unbanMember", async () => {
    svc.unbanMember.mockResolvedValue({ userId: TARGET, status: "LEFT" });
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/banned-members/${TARGET}/unban`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.unbanMember).toHaveBeenCalledWith(CID, SELF, TARGET);
  });

  it("returns 400 when the member is not currently banned (service guard)", async () => {
    svc.unbanMember.mockRejectedValue(
      new BadRequestError("COMMUNITY_MEMBER_NOT_BANNED")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/banned-members/${TARGET}/unban`)
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 403 for a non-admin caller", async () => {
    svc.unbanMember.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/banned-members/${TARGET}/unban`)
      .set(auth());
    expect(res.status).toBe(403);
  });

  it("returns 404 when the target member is not found", async () => {
    svc.unbanMember.mockRejectedValue(
      new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/banned-members/${TARGET}/unban`)
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid target uuid", async () => {
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/banned-members/not-uuid/unban`)
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.unbanMember).not.toHaveBeenCalled();
  });
});
