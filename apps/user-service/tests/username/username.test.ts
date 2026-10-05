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
    getUsernameHolder: jest.fn(async () => null),
    claimUsernameHold: jest.fn(async () => true),
    releaseUsernameHold: jest.fn(async () => undefined),
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
  TEST_USER_ID,
} from "../helpers/auth.js";
import { userCache } from "../../src/lib/user-cache.js";

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

  /**
   * Suffix walk: bare base first, then `_1`, `_2`, … — never starting at `_2`,
   * and the caller's own (registration-seeded) row never counts as taken.
   * `owners` is the fake username index: handle → owning userId. A BANNED
   * profile is just a row here, so it occupies like any other.
   */
  it.each<[string, Record<string, string>, string]>([
    ["#1 nobody holds the base", {}, "rajesh"],
    ["#5 base taken", { rajesh: "other" }, "rajesh_1"],
    ["#6 base and _1 taken", { rajesh: "other", rajesh_1: "b" }, "rajesh_2"],
    ["#7 _2 taken, base free", { rajesh_2: "other" }, "rajesh"],
    ["#13/#15 base is the caller's own seeded row", { rajesh: TEST_USER_ID }, "rajesh"],
    ["#25 base held by a banned user", { rajesh: "banned-user" }, "rajesh_1"],
  ])("suggests correctly: %s", async (_label, owners, expected) => {
    repo.findByUsername.mockImplementation(async (u: string) =>
      owners[u] ? { userId: owners[u], username: u } : null
    );

    const res = await request(app)
      .post("/api/v1/users/usernames/generate")
      .set(auth())
      .send({ account: "Rajesh" });

    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe(expected);
  });

  it("ignores a cached 'taken' flag that may be the caller's own handle", async () => {
    (userCache.getUsernameTaken as jest.Mock).mockResolvedValueOnce(true);
    repo.findByUsername.mockImplementation(async (u: string) =>
      u === "rajesh" ? { userId: TEST_USER_ID, username: u } : null
    );

    const res = await request(app)
      .post("/api/v1/users/usernames/generate")
      .set(auth())
      .send({ account: "Rajesh" });

    expect(res.body.data.username).toBe("rajesh");
  });

  it("#10 skips a free handle another user is holding → next suffix", async () => {
    (userCache.claimUsernameHold as jest.Mock).mockResolvedValueOnce(false);

    const res = await request(app)
      .post("/api/v1/users/usernames/generate")
      .set(auth())
      .send({ account: "Rajesh" });

    expect(res.body.data.username).toBe("rajesh_1");
    expect(userCache.claimUsernameHold).toHaveBeenLastCalledWith(
      "rajesh_1",
      TEST_USER_ID
    );
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

  it.each([
    ["another user", "someone-else", false],
    ["the caller (other tab)", TEST_USER_ID, true],
  ])("a free handle held by %s → available:%s", async (_l, holder, expected) => {
    repo.findByUsername.mockResolvedValue(null);
    (userCache.getUsernameHolder as jest.Mock).mockResolvedValueOnce(holder);

    const res = await request(app)
      .post("/api/v1/users/usernames/validate")
      .set(auth())
      .send({ username: "heldhandle" });

    expect(res.body.data.available).toBe(expected);
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

/**
 * The boundaries of the ONE rule, asserted on the endpoint the web client actually calls.
 *
 * `updateProfileSchema.username` is not a copy of this rule, it is literally the same schema
 * object (asserted below), so availability and the write that follows it can never normalize
 * differently — the failure mode where a handle checks out as free and is then refused, or
 * checks out as taken under a casing the write does not apply.
 */
describe("username rule — boundaries and normalization", () => {
  beforeEach(() => {
    repo.findByUsername.mockResolvedValue(null);
  });

  const ask = (username: string) =>
    request(app)
      .get("/api/v1/users/usernames/validate")
      .set(auth())
      .query({ username });

  it.each([
    ["exact minimum (3)", "abc", "abc"],
    ["exact maximum (30)", "a".repeat(30), "a".repeat(30)],
    ["underscores", "a_b_c", "a_b_c"],
    ["digits", "user2024", "user2024"],
    ["numeric only", "12345", "12345"],
    ["uppercase is canonicalized, not rejected", "TestUser", "testuser"],
    ["surrounding whitespace is trimmed", "  testuser  ", "testuser"],
  ])("accepts %s", async (_label, input, canonical) => {
    const res = await ask(input);
    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe(canonical);
  });

  it.each([
    ["empty", ""],
    ["below minimum (2)", "ab"],
    ["above maximum (31)", "a".repeat(31)],
    ["inner space", "test user"],
    ["hyphen", "test-user"],
    ["dot", "test.user"],
    ["unsupported symbol", "test@user"],
    ["non-Latin script", "пользователь"],
    ["emoji", "test🎉"],
    ["absurdly long input", "a".repeat(10_000)],
  ])("rejects %s with 400 and never reaches the database", async (_label, input) => {
    const res = await ask(input);
    expect(res.status).toBe(400);
    expect(repo.findByUsername).not.toHaveBeenCalled();
  });

  /**
   * Casing is not a second identity: `TestUser`, `testuser` and `TESTUSER` are one handle, so
   * a profile holding `testuser` makes all three unavailable.
   */
  it.each(["TestUser", "testuser", "TESTUSER"])(
    "resolves %s against the same stored handle",
    async (input) => {
      repo.findByUsername.mockResolvedValue({ userId: "someone-else" });

      const res = await ask(input);

      expect(res.status).toBe(200);
      expect(res.body.data.available).toBe(false);
      expect(repo.findByUsername).toHaveBeenCalledWith("testuser");
    }
  );
});

describe("username rule — one definition", () => {
  it("is the same schema object on the availability check and on the profile write", async () => {
    const { usernameSchema } = await import(
      "../../src/api/validators/username.validator.js"
    );
    const { updateProfileSchema } = await import(
      "../../src/api/validators/profile.validator.js"
    );

    // Same instance, so the two can never drift apart.
    expect(updateProfileSchema.shape.username.unwrap()).toBe(usernameSchema);
  });
});
