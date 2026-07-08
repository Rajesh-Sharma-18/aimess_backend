jest.mock("../../src/repositories/recent-search.repository.js", () => ({
  recentSearchRepository: {
    findByUserId: jest.fn(async () => []),
    findById: jest.fn(async () => null),
    upsert: jest.fn(async () => undefined),
    deleteById: jest.fn(async () => ({ count: 1 })),
    clearAll: jest.fn(async () => ({ count: 0 })),
  },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUserIds: jest.fn(async () => []),
    findUsersInList: jest.fn(async () => []),
    countUsersInList: jest.fn(async () => 0),
    findUsersNotInList: jest.fn(async () => []),
    countUsersNotInList: jest.fn(async () => 0),
  },
}));
jest.mock("../../src/services/avatar.service.js", () => ({
  avatarService: {
    resolveViewUrlForClient: jest.fn(async () => null),
  },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { recentSearchRepository } from "../../src/repositories/recent-search.repository.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import {
  TEST_USER_ID,
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
} from "../helpers/auth.js";

const repo = recentSearchRepository as unknown as Record<string, jest.Mock>;
const pRepo = userProfileRepository as unknown as Record<string, jest.Mock>;

const auth = () => bearer(makeAccessToken());

const PEER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEARCH_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makeUserRow(overrides = {}) {
  return {
    id: SEARCH_ID,
    userId: TEST_USER_ID,
    searchedUserId: PEER_ID,
    query: null,
    createdAt: new Date("2026-07-07T10:00:00Z"),
    ...overrides,
  };
}

function makeQueryRow(overrides = {}) {
  return {
    id: SEARCH_ID,
    userId: TEST_USER_ID,
    searchedUserId: null,
    query: "john doe",
    createdAt: new Date("2026-07-07T10:00:00Z"),
    ...overrides,
  };
}

function profile(userId: string) {
  return {
    userId,
    username: "janedoe",
    firstName: "Jane",
    lastName: "Doe",
    avatarUrl: null,
    isOnline: false,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  repo.findByUserId.mockResolvedValue([]);
  repo.upsert.mockResolvedValue(undefined);
  repo.deleteById.mockResolvedValue({ count: 1 });
  repo.clearAll.mockResolvedValue({ count: 0 });
  pRepo.findByUserIds.mockResolvedValue([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/users/recent-searches
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/users/recent-searches", () => {
  it("returns empty searches[] when no history", async () => {
    const res = await request(app)
      .get("/api/v1/users/recent-searches")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.searches).toEqual([]);
  });

  it("returns a USER type entry with enriched profile", async () => {
    repo.findByUserId.mockResolvedValue([makeUserRow()]);
    pRepo.findByUserIds.mockResolvedValue([profile(PEER_ID)]);

    const res = await request(app)
      .get("/api/v1/users/recent-searches")
      .set(auth());

    expect(res.status).toBe(200);
    const entry = res.body.data.searches[0];
    expect(entry.type).toBe("USER");
    expect(entry.id).toBe(SEARCH_ID);
    expect(entry.user.userId).toBe(PEER_ID);
    expect(entry.user.username).toBe("janedoe");
    expect(entry.query).toBeUndefined();
  });

  it("returns a QUERY type entry", async () => {
    repo.findByUserId.mockResolvedValue([makeQueryRow()]);

    const res = await request(app)
      .get("/api/v1/users/recent-searches")
      .set(auth());

    const entry = res.body.data.searches[0];
    expect(entry.type).toBe("QUERY");
    expect(entry.query).toBe("john doe");
    expect(entry.user).toBeUndefined();
  });

  it("batch-fetches profiles in one call (no N+1)", async () => {
    const PEER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    repo.findByUserId.mockResolvedValue([
      makeUserRow({ id: "id1", searchedUserId: PEER_ID }),
      makeUserRow({ id: "id2", searchedUserId: PEER_B }),
    ]);
    pRepo.findByUserIds.mockResolvedValue([profile(PEER_ID), profile(PEER_B)]);

    await request(app).get("/api/v1/users/recent-searches").set(auth());

    expect(pRepo.findByUserIds).toHaveBeenCalledTimes(1);
    expect(pRepo.findByUserIds).toHaveBeenCalledWith(
      expect.arrayContaining([PEER_ID, PEER_B])
    );
  });

  it("gracefully falls back to QUERY type when profile is deleted", async () => {
    repo.findByUserId.mockResolvedValue([makeUserRow()]);
    pRepo.findByUserIds.mockResolvedValue([]); // profile gone

    const res = await request(app)
      .get("/api/v1/users/recent-searches")
      .set(auth());

    expect(res.body.data.searches[0].type).toBe("QUERY");
  });

  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/v1/users/recent-searches");
    expect(res.status).toBe(401);
  });

  it("returns 401 with expired token", async () => {
    const res = await request(app)
      .get("/api/v1/users/recent-searches")
      .set(bearer(makeExpiredAccessToken()));
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/users/recent-searches
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/users/recent-searches", () => {
  it("records a user tap (searchedUserId)", async () => {
    const res = await request(app)
      .post("/api/v1/users/recent-searches")
      .set(auth())
      .send({ searchedUserId: PEER_ID });

    expect(res.status).toBe(201);
    expect(repo.upsert).toHaveBeenCalledWith({
      userId: TEST_USER_ID,
      searchedUserId: PEER_ID,
      query: undefined,
    });
  });

  it("records a text query", async () => {
    const res = await request(app)
      .post("/api/v1/users/recent-searches")
      .set(auth())
      .send({ query: "alice" });

    expect(res.status).toBe(201);
    expect(repo.upsert).toHaveBeenCalledWith({
      userId: TEST_USER_ID,
      searchedUserId: undefined,
      query: "alice",
    });
  });

  it("trims whitespace from query", async () => {
    const res = await request(app)
      .post("/api/v1/users/recent-searches")
      .set(auth())
      .send({ query: "  alice  " });

    expect(res.status).toBe(201);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ query: "alice" })
    );
  });

  it("returns 400 when neither field is provided", async () => {
    const res = await request(app)
      .post("/api/v1/users/recent-searches")
      .set(auth())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when searchedUserId is not a valid UUID", async () => {
    const res = await request(app)
      .post("/api/v1/users/recent-searches")
      .set(auth())
      .send({ searchedUserId: "not-a-uuid" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when query is empty string", async () => {
    const res = await request(app)
      .post("/api/v1/users/recent-searches")
      .set(auth())
      .send({ query: "" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when query exceeds 100 chars", async () => {
    const res = await request(app)
      .post("/api/v1/users/recent-searches")
      .set(auth())
      .send({ query: "a".repeat(101) });

    expect(res.status).toBe(400);
  });

  it("returns 401 without token", async () => {
    const res = await request(app)
      .post("/api/v1/users/recent-searches")
      .send({ query: "test" });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/users/recent-searches/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/v1/users/recent-searches/:id", () => {
  it("deletes an entry and returns 200", async () => {
    const res = await request(app)
      .delete(`/api/v1/users/recent-searches/${SEARCH_ID}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(repo.deleteById).toHaveBeenCalledWith(SEARCH_ID, TEST_USER_ID);
  });

  it("returns 404 when entry does not exist or belongs to another user", async () => {
    repo.deleteById.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .delete(`/api/v1/users/recent-searches/${SEARCH_ID}`)
      .set(auth());

    expect(res.status).toBe(404);
  });

  it("returns 401 without token", async () => {
    const res = await request(app).delete(
      `/api/v1/users/recent-searches/${SEARCH_ID}`
    );
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/users/recent-searches  (clear all)
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/v1/users/recent-searches (clear all)", () => {
  it("clears all entries for the caller", async () => {
    const res = await request(app)
      .delete("/api/v1/users/recent-searches")
      .set(auth());

    expect(res.status).toBe(200);
    expect(repo.clearAll).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it("returns 401 without token", async () => {
    const res = await request(app).delete("/api/v1/users/recent-searches");
    expect(res.status).toBe(401);
  });
});
