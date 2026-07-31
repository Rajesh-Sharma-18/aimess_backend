/**
 * /api/v1/users/usernames — generate + validate.
 *
 * `usernameService` is a real class built on `userProfileRepository` and
 * `userCache`. We mock the repository (the DB boundary) and force the cache to
 * a cold miss, so the real format-validation, normalization and availability
 * branches all execute. Auth is required on both routes.
 */
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUsername: jest.fn(),
  },
}));
jest.mock("../../src/lib/user-cache.js", () => ({
  userCache: {
    getUsernameAvailability: jest.fn(async () => null),
    setUsernameAvailability: jest.fn(async () => undefined),
    getUsernameTaken: jest.fn(async () => null),
    markUsernameTaken: jest.fn(async () => undefined),
  },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import {
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";

const repo = userProfileRepository as unknown as {
  findByUsername: jest.Mock;
};

const auth = () => bearer(makeAccessToken());

describe("POST /api/v1/users/usernames/generate", () => {
  beforeEach(() => {
    repo.findByUsername.mockResolvedValue(null);
  });

  it("generates a username from the account → 200", async () => {
    const res = await request(app)
      .post("/api/v1/users/usernames/generate")
      .set(auth())
      .send({ account: "John.Doe" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // base derived from account, non-empty, lowercase canonical.
    expect(typeof res.body.data.username).toBe("string");
    expect(res.body.data.username).toBe("john_doe");
  });

  it("appends a numeric suffix when the base is already taken", async () => {
    // First lookup (base) returns a profile → taken; suffixed lookup is free.
    repo.findByUsername
      .mockResolvedValueOnce({ userId: "someone-else" })
      .mockResolvedValue(null);

    const res = await request(app)
      .post("/api/v1/users/usernames/generate")
      .set(auth())
      .send({ account: "johndoe" });

    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe("johndoe_2");
  });

  it.each([
    ["missing account", {}],
    ["empty account", { account: "" }],
    ["account over 128 chars", { account: "a".repeat(129) }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/v1/users/usernames/generate")
      .set(auth())
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/v1/users/usernames/generate")
      .send({ account: "johndoe" });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe("POST /api/v1/users/usernames/validate", () => {
  beforeEach(() => {
    repo.findByUsername.mockResolvedValue(null);
  });

  it("reports an available username → 200 available:true", async () => {
    const res = await request(app)
      .post("/api/v1/users/usernames/validate")
      .set(auth())
      .send({ username: "freshhandle" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.username).toBe("freshhandle");
  });

  it("reports a taken username (owned by someone else) → 200 available:false", async () => {
    repo.findByUsername.mockResolvedValue({ userId: "another-user" });

    const res = await request(app)
      .post("/api/v1/users/usernames/validate")
      .set(auth())
      .send({ username: "takenhandle" });

    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(false);
  });

  it("treats the caller's own current username as available", async () => {
    // Token default userId; the existing profile belongs to the caller.
    repo.findByUsername.mockResolvedValue({
      userId: "11111111-1111-4111-8111-111111111111",
    });

    const res = await request(app)
      .post("/api/v1/users/usernames/validate")
      .set(auth())
      .send({ username: "myhandle" });

    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(true);
  });

  it("normalizes uppercase input to canonical lowercase", async () => {
    const res = await request(app)
      .post("/api/v1/users/usernames/validate")
      .set(auth())
      .send({ username: "MixedCase" });

    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe("mixedcase");
  });

  it.each([
    ["missing username", {}],
    ["too short", { username: "ab" }],
    ["too long", { username: "a".repeat(33) }],
    ["illegal characters", { username: "bad name!" }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/v1/users/usernames/validate")
      .set(auth())
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("safely rejects an injection-shaped username (not a valid handle)", async () => {
    const res = await request(app)
      .post("/api/v1/users/usernames/validate")
      .set(auth())
      .send({ username: "' OR '1'='1" });

    // Spaces/quotes fail the [a-z0-9_] regex → 400, never reaches the repo.
    expect(res.status).toBe(400);
    expect(repo.findByUsername).not.toHaveBeenCalled();
  });

  it("returns 401 with an expired token", async () => {
    const res = await request(app)
      .post("/api/v1/users/usernames/validate")
      .set(bearer(makeExpiredAccessToken()))
      .send({ username: "freshhandle" });

    expect(res.status).toBe(401);
  });

  it("returns 401 with a forged token", async () => {
    const res = await request(app)
      .post("/api/v1/users/usernames/validate")
      .set(bearer(makeForgedAccessToken()))
      .send({ username: "freshhandle" });

    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/users/usernames/validate", () => {
  beforeEach(() => {
    repo.findByUsername.mockResolvedValue(null);
  });

  it("reports an available username → 200 available:true", async () => {
    const res = await request(app)
      .get("/api/v1/users/usernames/validate")
      .set(auth())
      .query({ username: "freshhandle" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.username).toBe("freshhandle");
  });

  it("reports a taken username (owned by someone else) → 200 available:false", async () => {
    repo.findByUsername.mockResolvedValue({ userId: "another-user" });

    const res = await request(app)
      .get("/api/v1/users/usernames/validate")
      .set(auth())
      .query({ username: "takenhandle" });

    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(false);
  });

  it("treats the caller's own current username as available", async () => {
    repo.findByUsername.mockResolvedValue({
      userId: "11111111-1111-4111-8111-111111111111",
    });

    const res = await request(app)
      .get("/api/v1/users/usernames/validate")
      .set(auth())
      .query({ username: "myhandle" });

    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(true);
  });

  it("normalizes uppercase and trims whitespace to canonical lowercase", async () => {
    const res = await request(app)
      .get("/api/v1/users/usernames/validate")
      .set(auth())
      .query({ username: "  MixedCase  " });

    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe("mixedcase");
  });

  it.each([
    ["missing username", {}],
    ["too short", { username: "ab" }],
    ["too long", { username: "a".repeat(33) }],
    ["illegal characters", { username: "bad name!" }],
  ])("returns 400 on validation failure: %s", async (_label, query) => {
    const res = await request(app)
      .get("/api/v1/users/usernames/validate")
      .set(auth())
      .query(query);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .get("/api/v1/users/usernames/validate")
      .query({ username: "freshhandle" });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});
