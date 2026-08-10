/**
 * Discovery / listing / categories:
 *   GET /api/v1/communities/categories         (public list)
 *   GET /api/v1/communities/mine               (dual-mode: joined cursor / search offset)
 *   GET /api/v1/communities/discover           (deprecated alias)
 *
 * The `/mine` endpoint branches on the query: presence of before_ts/after_ts →
 * `listMine` (cursor); else → `discover` (offset). Both branches are asserted.
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    listCategories: jest.fn(),
    listMine: jest.fn(),
    discover: jest.fn(),
  },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { communityService } from "../../src/services/community.service.js";
import {
  bearer,
  makeAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";

const svc = communityService as unknown as Record<string, jest.Mock>;
const auth = () => bearer(makeAccessToken());

const paginated = (data: unknown[] = []) => ({
  pagination: {
    totalData: data.length,
    totalPage: 1,
    currentPage: 1,
    limit: 20,
    hasMore: false,
    nextCursor: null,
  },
  data,
});

describe("GET /api/v1/communities/categories", () => {
  it("returns the active categories under { categories }", async () => {
    svc.listCategories.mockResolvedValue([
      { id: "a".repeat(24), name: "Tech", slug: "tech" },
    ]);
    const res = await request(app)
      .get("/api/v1/communities/categories")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.categories).toHaveLength(1);
    expect(svc.listCategories).toHaveBeenCalledTimes(1);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/communities/categories");
    expect(res.status).toBe(401);
  });

  it("returns 401 for a forged token", async () => {
    const res = await request(app)
      .get("/api/v1/communities/categories")
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
    expect(svc.listCategories).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/communities/mine", () => {
  beforeEach(() => {
    svc.listMine.mockResolvedValue(paginated([{ id: "x" }]));
    svc.discover.mockResolvedValue(paginated([{ id: "y" }]));
  });

  it("joined mode: before_ts present → calls listMine (cursor, before)", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ before_ts: 1700000000000, limit: 10 })
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listMine).toHaveBeenCalledTimes(1);
    expect(svc.discover).not.toHaveBeenCalled();
    expect(svc.listMine.mock.calls[0][1].direction).toBe("before");
  });

  it("joined mode: after_ts present → listMine direction=after", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ after_ts: 1700000000000 })
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listMine.mock.calls[0][1].direction).toBe("after");
  });

  it("search mode: q present (no pagination) → calls discover with includeJoined", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ q: "react" })
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.discover).toHaveBeenCalledTimes(1);
    expect(svc.listMine).not.toHaveBeenCalled();
    expect(svc.discover.mock.calls[0][1].includeJoined).toBe(true);
  });

  // Regression: `/mine?limit=50` (the Community screen's first load) used to
  // fall through to discover(), so a brand-new user with zero memberships got
  // every PUBLIC community on the platform instead of an empty list.
  it("no params → joined mode (listMine newest page), NOT discover", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ limit: 50 })
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listMine).toHaveBeenCalledTimes(1);
    expect(svc.discover).not.toHaveBeenCalled();
    expect(svc.listMine.mock.calls[0][1].direction).toBe("before");
    expect(svc.listMine.mock.calls[0][1].limit).toBe(50);
  });

  it("a user with no memberships gets an empty page, not public browse", async () => {
    svc.listMine.mockResolvedValue(paginated([]));
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ limit: 50 })
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.data).toEqual([]);
    expect(res.body.data.pagination.totalData).toBe(0);
    expect(svc.discover).not.toHaveBeenCalled();
  });

  it("filter=all with no q/categoryId → joined mode, not public browse", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ filter: "all" })
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listMine).toHaveBeenCalledTimes(1);
    expect(svc.discover).not.toHaveBeenCalled();
  });

  it("search mode: categoryId alone → discover with includeJoined", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ categoryId: "a".repeat(24) })
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.discover).toHaveBeenCalledTimes(1);
    expect(svc.listMine).not.toHaveBeenCalled();
  });

  it("search mode: non-'all' filter → discover (livestream browse preserved)", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ filter: "live" })
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.discover).toHaveBeenCalledTimes(1);
    expect(svc.listMine).not.toHaveBeenCalled();
  });

  it("cursor wins over q: before_ts + q → listMine, never discover", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ before_ts: 1700000000000, q: "react" })
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listMine).toHaveBeenCalledTimes(1);
    expect(svc.discover).not.toHaveBeenCalled();
  });

  it("scopes the query to the token's user, ignoring a client-sent userId", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ limit: 10, userId: "b".repeat(24) })
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.listMine.mock.calls[0][0]).not.toBe("b".repeat(24));
  });

  it("two tokens → two different user ids reach the service (no shared state)", async () => {
    const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await request(app)
      .get("/api/v1/communities/mine")
      .query({ limit: 10 })
      .set(bearer(makeAccessToken({ userId: userA })));
    await request(app)
      .get("/api/v1/communities/mine")
      .query({ limit: 10 })
      .set(bearer(makeAccessToken({ userId: userB })));
    expect(svc.listMine.mock.calls[0][0]).toBe(userA);
    expect(svc.listMine.mock.calls[1][0]).toBe(userB);
  });

  it("returns 400 when both before_ts and after_ts are sent", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ before_ts: 1700000000000, after_ts: 1700000000001 })
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.listMine).not.toHaveBeenCalled();
    expect(svc.discover).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-positive limit", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ q: "react", limit: 0 })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 400 when limit exceeds the max (50)", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ q: "react", limit: 999 })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid filter enum", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ q: "react", filter: "trending" })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid categoryId in search mode", async () => {
    const res = await request(app)
      .get("/api/v1/communities/mine")
      .query({ categoryId: "bad" })
      .set(auth());
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/communities/discover (deprecated alias)", () => {
  beforeEach(() => {
    svc.discover.mockResolvedValue(paginated([{ id: "z" }]));
  });

  it("returns 200 and paginated data; discover called WITHOUT includeJoined", async () => {
    const res = await request(app)
      .get("/api/v1/communities/discover")
      .query({ q: "music", page: 2, limit: 5 })
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
    expect(svc.discover).toHaveBeenCalledTimes(1);
    expect(svc.discover.mock.calls[0][1].includeJoined).toBeUndefined();
    expect(svc.discover.mock.calls[0][1].page).toBe(2);
  });

  it("returns 400 for an over-long q (>100 chars)", async () => {
    const res = await request(app)
      .get("/api/v1/communities/discover")
      .query({ q: "x".repeat(101) })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/communities/discover");
    expect(res.status).toBe(401);
  });
});
