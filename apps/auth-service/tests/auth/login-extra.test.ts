/**
 * POST /api/auth/login — branches not covered by login.test.ts:
 *   - email-identifier login path (findByEmailForLogin) + unverified-email guard
 *   - password-not-set guard (social-only account)
 *   - rememberMe + fcmTokens pass-through and isProfileCompleted/role in the body
 *   - mass-assignment: privileged fields in the body are ignored
 *   - AUDIT F1: /login is wired WITH validateBody(loginSchema) again. It was
 *     commented out, so a missing `account` reached the service and threw (500
 *     instead of 400) and neither field was type-checked. Login uses a laxer
 *     password rule than registration on purpose — see the schema.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByAccountForLogin: jest.fn(),
    findByEmailForLogin: jest.fn(),
    recordSuccessfulLogin: jest.fn(),
    recordFailedLogin: jest.fn(),
    mergeFcmTokens: jest.fn(),
  },
}));
jest.mock("../../src/lib/token.js", () => ({
  issueAuthTokens: jest.fn(),
}));

import request from "supertest";
import bcrypt from "bcryptjs";

import app from "../../src/app.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { issueAuthTokens } from "../../src/lib/token.js";

const repo = authRepository as unknown as Record<string, jest.Mock>;
const issue = issueAuthTokens as unknown as jest.Mock;

const PASSWORD = "Correct-Horse-Battery-7";
let passwordHash: string;

const TOKENS = {
  accessToken: "access.jwt.token",
  refreshToken: "refresh-token-value",
  accessTokenExpiresIn: 3600,
  refreshTokenExpiresIn: 604800,
};

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    account: "johndoe",
    email: "john@example.com",
    passwordHash,
    deletedAt: null,
    emailVerified: true,
    lockedUntil: null,
    status: "ACTIVE",
    isProfileCompleted: true,
    role: "USER",
    // Selected by loginUserSelect and read only when passwordHash is null.
    primaryAccount: null,
    linkedAccounts: [],
    ...overrides,
  };
}

describe("POST /api/auth/login (extra branches)", () => {
  beforeEach(() => {
    repo.findByAccountForLogin.mockResolvedValue(activeUser());
    repo.findByEmailForLogin.mockResolvedValue(activeUser());
    repo.recordSuccessfulLogin.mockResolvedValue(undefined);
    repo.recordFailedLogin.mockResolvedValue(undefined);
    repo.mergeFcmTokens.mockResolvedValue(undefined);
    issue.mockResolvedValue({ tokens: TOKENS, sessionId: "sess-1" });
  });

  it("logs in via an email identifier (routes to findByEmailForLogin)", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "john@example.com", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(repo.findByEmailForLogin).toHaveBeenCalledWith("john@example.com");
    expect(repo.findByAccountForLogin).not.toHaveBeenCalled();
  });

  // Every path that STORES an email lowercases it, and the lookup is an exact
  // -match unique index — so a user who linked name@example.com and typed it back
  // with the capitals their keyboard offered was told the credentials were wrong.
  it("matches a linked email case-insensitively", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "  John@Example.COM ", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(repo.findByEmailForLogin).toHaveBeenCalledWith("john@example.com");
  });

  // The counterpart: account names are stored with the case the user chose, so
  // folding them here would break username login for every mixed-case handle.
  it("preserves the case of an account-name identifier", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "  JohnDoe ", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(repo.findByAccountForLogin).toHaveBeenCalledWith("JohnDoe");
  });

  it("returns 401 when logging in by email that is not yet verified", async () => {
    repo.findByEmailForLogin.mockResolvedValue(
      activeUser({ emailVerified: false })
    );

    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "john@example.com", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(issue).not.toHaveBeenCalled();
  });

  it("returns 401 when the account has no password set (social-only)", async () => {
    repo.findByAccountForLogin.mockResolvedValue(
      activeUser({ passwordHash: null })
    );

    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(issue).not.toHaveBeenCalled();
  });

  // A soft delete sets deletedAt AND status PENDING_DELETION, so before this
  // the account fell into the generic non-ACTIVE branch on every surface that
  // reached it — "Your account has been disabled. Please contact support." for
  // an account the user deleted themselves.
  it("names a soft-deleted account as DELETED, not disabled, on a correct password", async () => {
    repo.findByAccountForLogin.mockResolvedValue(
      activeUser({ deletedAt: new Date(), status: "PENDING_DELETION" })
    );

    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("AUTH_ACCOUNT_DELETED");
    expect(res.body.message).toBe("This account has been deleted.");
    expect(issue).not.toHaveBeenCalled();
    expect(repo.recordSuccessfulLogin).not.toHaveBeenCalled();
  });

  // The other half of that answer, and the reason it is safe: the deleted state
  // is named only to someone who already typed the password. A wrong one is
  // answered exactly as an unknown account is, so nothing here can be used to
  // ask "did this person delete their account?".
  it("keeps the generic credential answer for a deleted account + wrong password", async () => {
    repo.findByAccountForLogin.mockResolvedValue(
      activeUser({ deletedAt: new Date(), status: "PENDING_DELETION" })
    );

    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: "WrongPassword999" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("AUTH_INVALID_CREDENTIALS");
    // A deleted account has no lockout state left to move, and moving one would
    // itself be an oracle (a locked answer means the account exists).
    expect(repo.recordFailedLogin).not.toHaveBeenCalled();
  });

  // A social-only account has no password to verify, so there is nothing to
  // prove ownership with here — it stays indistinguishable from an unknown
  // account. Its Google/Apple sign-in is the surface that names the deletion.
  it("keeps the generic credential answer for a deleted password-less account", async () => {
    repo.findByAccountForLogin.mockResolvedValue(
      activeUser({
        deletedAt: new Date(),
        status: "PENDING_DELETION",
        passwordHash: null,
      })
    );

    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("AUTH_INVALID_CREDENTIALS");
  });

  it("returns isProfileCompleted + role in the success envelope and passes rememberMe", async () => {
    repo.findByAccountForLogin.mockResolvedValue(
      activeUser({ isProfileCompleted: false, role: "ADMIN" })
    );

    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD, rememberMe: true });

    expect(res.status).toBe(200);
    expect(res.body.data.isProfileCompleted).toBe(false);
    expect(res.body.data.role).toBe("ADMIN");
    // issueAuthTokens(userId, role, session, rememberMe) — rememberMe is the 4th arg.
    expect(issue.mock.calls[0][3]).toBe(true);
  });

  it("merges supplied fcmTokens on a successful login", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({
        account: "johndoe",
        password: PASSWORD,
        fcmTokens: ["tok-a", "tok-b"],
      });

    expect(res.status).toBe(200);
    expect(repo.mergeFcmTokens).toHaveBeenCalledWith("user-1", [
      "tok-a",
      "tok-b",
    ]);
  });

  it("ignores mass-assignment of privileged fields in the body", async () => {
    const res = await request(app).post("/api/auth/login").send({
      account: "johndoe",
      password: PASSWORD,
      role: "ADMIN",
      status: "BANNED",
      id: "attacker-id",
    });

    expect(res.status).toBe(200);
    // Role echoed back is the stored USER role, not the injected ADMIN.
    expect(res.body.data.role).toBe("USER");
    expect(repo.recordSuccessfulLogin).toHaveBeenCalledWith("user-1");
  });

  // AUDIT F1 — `validateBody(loginSchema)` was commented out of this route, so a
  // missing `account` threw inside the service and surfaced as a 500 rather than
  // a 400, and neither `account` nor `password` was ever type-checked: an
  // object `account` reached the repository and a non-string `password` reached
  // bcrypt. The validator is back on the route.
  it("400s on a missing account instead of throwing a 500 out of the service", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ password: PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it.each([
    ["object account", { account: { $ne: null }, password: PASSWORD }],
    ["non-string password", { account: "johndoe", password: 12345678 }],
    ["array account", { account: ["johndoe"], password: PASSWORD }],
  ])("400s on a %s — it never reaches the repo or bcrypt", async (_l, body) => {
    const res = await request(app).post("/api/auth/login").send(body);

    expect(res.status).toBe(400);
    expect(repo.findByAccountForLogin).not.toHaveBeenCalled();
    expect(repo.findByEmailForLogin).not.toHaveBeenCalled();
  });

  // Login must NOT apply the password CREATION policy (min 8). An account made
  // before that rule would otherwise be unable to log in at all — a validation
  // error instead of a credential check.
  it("does not reject a short password at the schema — bcrypt decides", async () => {
    repo.findByAccountForLogin.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: "short" });

    expect(res.status).not.toBe(400);
  });

  // The sign-in form renders `message` verbatim, so an over-long password used
  // to reach the user as zod's own "Too big: expected string to have <=128
  // characters". Every other field on this schema already carries its own
  // sentence; this one now does too.
  it("400s on an over-long password with a sentence, not zod's default", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: "a".repeat(129) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.message).toBe("Password is too long");
  });
});
