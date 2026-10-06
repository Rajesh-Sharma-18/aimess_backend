/**
 * POST /api/auth/accounts/validate — account-availability check. Real Zod
 * validation + service run; only the repository is mocked. Available → 200,
 * taken → 409, malformed account → 400.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByAccount: jest.fn(),
    findByAccountForLogin: jest.fn(),
  },
}));

import request from "supertest";

import app from "../../src/app.js";
import { authRepository } from "../../src/repositories/auth.repository.js";

const repo = authRepository as unknown as {
  findByAccount: jest.Mock;
  findByAccountForLogin: jest.Mock;
};

describe("POST /api/auth/accounts/validate", () => {
  beforeEach(() => {
    repo.findByAccount.mockResolvedValue(null);
  });

  it("returns 200 + available:true when the account is free", async () => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "johndoe" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.account).toBe("johndoe");
    expect(repo.findByAccount).toHaveBeenCalledWith("johndoe");
  });

  it("returns 409 when the account is already taken", async () => {
    repo.findByAccount.mockResolvedValue({ id: "existing-user" });

    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "johndoe" });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it("trims surrounding whitespace before checking availability", async () => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "  johndoe  " });

    expect(res.status).toBe(200);
    expect(repo.findByAccount).toHaveBeenCalledWith("johndoe");
  });

  it.each([
    ["missing account", {}],
    ["empty account", { account: "" }],
    ["account too short", { account: "ab" }],
    ["account too long (33 chars)", { account: "a".repeat(33) }],
    ["illegal space", { account: "john doe" }],
    ["illegal symbol", { account: "john@doe" }],
    ["wrong type (number)", { account: 12345 }],
    ["null account", { account: null }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(repo.findByAccount).not.toHaveBeenCalled();
  });

  it("accepts the boundary lengths (3 and 32 chars)", async () => {
    const min = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "abc" });
    expect(min.status).toBe(200);

    const max = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "a".repeat(32) });
    expect(max.status).toBe(200);
  });

  it("safely rejects a NoSQL-injection-shaped object payload (not a string)", async () => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: { $ne: null } });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(repo.findByAccount).not.toHaveBeenCalled();
  });

  /**
   * AIM-31. This endpoint is an availability oracle by design — a signup form
   * has to say "taken" while you type — and answering 409 vs 200 enumerates the
   * whole handle namespace, which is the input to targeted credential stuffing
   * against /login.
   *
   * It was priced with a single-use proof of work; that was removed because it
   * made every keystroke of a signup form fetch and solve a challenge first.
   * `sensitiveAuthRateLimiter` is now the only thing standing between a caller
   * and the namespace, so these pin that a probe needs NOTHING else — if a
   * challenge or any other credential creeps back onto this route, the signup
   * form breaks again and this is where it shows up.
   */
  describe("enumeration cost", () => {
    it("answers a bare probe carrying no proof of work", async () => {
      const res = await request(app)
        .post("/api/auth/accounts/validate")
        .send({ account: "johndoe" });

      expect(res.status).toBe(200);
      expect(res.body.data.available).toBe(true);
    });

    it("answers repeated probes for different handles", async () => {
      const first = await request(app)
        .post("/api/auth/accounts/validate")
        .send({ account: "johndoe" });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post("/api/auth/accounts/validate")
        .send({ account: "janedoe" });
      expect(second.status).toBe(200);

      expect(repo.findByAccount).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * Login step 1 (`purpose: "login"`): an existing account that cannot use a
 * password answers its provider code instead of AUTH_ACCOUNT_TAKEN, so the
 * client never shows a password field that can never succeed. Still 409 — the
 * account exists — so a client that only reads the status behaves as before.
 */
describe("POST /api/auth/accounts/validate — purpose: login", () => {
  const loginUser = (overrides: Record<string, unknown> = {}) => ({
    id: "u1",
    passwordHash: "$2a$hash",
    deletedAt: null,
    emailVerified: true,
    lockedUntil: null,
    status: "ACTIVE",
    linkedAccounts: [],
    ...overrides,
  });
  const probe = (body: Record<string, unknown>) =>
    request(app).post("/api/auth/accounts/validate").send(body);

  beforeEach(() => {
    repo.findByAccount.mockResolvedValue({ id: "u1" });
    repo.findByAccountForLogin.mockReset();
  });

  it.each([
    ["Google-only", [{ provider: "GOOGLE" }], "AUTH_GOOGLE_LOGIN_REQUIRED"],
    ["Apple-only", [{ provider: "APPLE" }], "AUTH_APPLE_LOGIN_REQUIRED"],
    [
      "Google + Apple",
      [{ provider: "GOOGLE" }, { provider: "APPLE" }],
      "AUTH_SOCIAL_LOGIN_REQUIRED",
    ],
  ])("%s, no password -> 409 %s", async (_label, linkedAccounts, code) => {
    repo.findByAccountForLogin.mockResolvedValue(
      loginUser({ passwordHash: null, linkedAccounts })
    );

    const res = await probe({ account: "social_user_123", purpose: "login" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(code);
    // Nothing beyond the code: no provider ids, email or credential detail.
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|providerUserId|u1/);
  });

  it.each([
    ["password only", []],
    ["Google + password", [{ provider: "GOOGLE" }]],
    ["Apple + password", [{ provider: "APPLE" }]],
    ["Google + Apple + password", [{ provider: "GOOGLE" }, { provider: "APPLE" }]],
  ])("%s -> plain AUTH_ACCOUNT_TAKEN (password step)", async (_label, linkedAccounts) => {
    repo.findByAccountForLogin.mockResolvedValue(loginUser({ linkedAccounts }));

    const res = await probe({ account: "tom", purpose: "login" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AUTH_ACCOUNT_TAKEN");
  });

  // Login's precedence decides these; step 1 must not pre-empt it with "use Google".
  it.each([
    ["banned", { status: "BANNED" }],
    ["suspended/inactive", { status: "SUSPENDED" }],
    ["deleted", { deletedAt: new Date() }],
    ["locked", { lockedUntil: new Date(Date.now() + 60_000) }],
  ])("%s Google-only account -> plain AUTH_ACCOUNT_TAKEN", async (_label, overrides) => {
    repo.findByAccountForLogin.mockResolvedValue(
      loginUser({ passwordHash: null, linkedAccounts: [{ provider: "GOOGLE" }], ...overrides })
    );

    const res = await probe({ account: "social_user_123", purpose: "login" });

    expect(res.body.error.code).toBe("AUTH_ACCOUNT_TAKEN");
  });

  it("without purpose, a Google-only account keeps AUTH_ACCOUNT_TAKEN (signup / old clients)", async () => {
    const res = await probe({ account: "social_user_123" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AUTH_ACCOUNT_TAKEN");
    expect(repo.findByAccountForLogin).not.toHaveBeenCalled();
  });

  it("resolves a mixed-case handle through the shared lookup before deciding", async () => {
    repo.findByAccountForLogin.mockResolvedValue(
      loginUser({ passwordHash: null, linkedAccounts: [{ provider: "GOOGLE" }] })
    );

    const res = await probe({ account: "Rajesh_Sharma", purpose: "login" });

    expect(res.body.error.code).toBe("AUTH_GOOGLE_LOGIN_REQUIRED");
    expect(repo.findByAccountForLogin).toHaveBeenCalledWith(
      repo.findByAccount.mock.calls[0][0]
    );
  });

  it("an unknown account stays 200 available", async () => {
    repo.findByAccount.mockResolvedValue(null);

    const res = await probe({ account: "ghostuser", purpose: "login" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ account: "ghostuser", available: true });
  });

  it("rejects an unknown purpose value", async () => {
    const res = await probe({ account: "tom", purpose: "signup" });

    expect(res.status).toBe(400);
  });
});
