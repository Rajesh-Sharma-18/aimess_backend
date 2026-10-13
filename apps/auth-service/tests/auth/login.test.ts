/**
 * POST /api/auth/login — credential check (real bcrypt compare) plus the
 * account-state guard rails: unknown account, wrong password (records a failed
 * attempt), locked account, and non-ACTIVE status.
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
jest.mock("../../src/services/account-ban.service.js", () => ({
  accountBanService: { liftExpiredSuspension: jest.fn() },
}));

import request from "supertest";
import bcrypt from "bcryptjs";

import app from "../../src/app.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { issueAuthTokens } from "../../src/lib/token.js";
import { accountBanService } from "../../src/services/account-ban.service.js";

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
  // Cost 4 keeps the suite fast while exercising the real compare path.
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    account: "johndoe",
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

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    repo.findByAccountForLogin.mockResolvedValue(activeUser());
    repo.recordSuccessfulLogin.mockResolvedValue(undefined);
    repo.recordFailedLogin.mockResolvedValue(undefined);
    repo.mergeFcmTokens.mockResolvedValue(undefined);
    issue.mockResolvedValue({ tokens: TOKENS, sessionId: "sess-1" });
  });

  it("logs in with valid credentials → 200 with tokens", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tokens.accessToken).toBe(TOKENS.accessToken);
    expect(repo.recordSuccessfulLogin).toHaveBeenCalledWith("user-1");
  });

  it("returns 401 for an unknown account", async () => {
    repo.findByAccountForLogin.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "ghostuser", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 and records a failed attempt for a wrong password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: "WrongPassword999" });

    expect(res.status).toBe(401);
    expect(repo.recordFailedLogin).toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("5th wrong password within 10 min locks for 15 min → AUTH_ACCOUNT_LOCKED + retryAfter 900", async () => {
    repo.findByAccountForLogin.mockResolvedValue(activeUser({ id: "user-lock" }));
    const attempt = () =>
      request(app)
        .post("/api/auth/login")
        .send({ account: "johndoe", password: "WrongPassword999" });

    for (let i = 0; i < 4; i += 1) {
      const res = await attempt();
      expect(res.body.code).toBe("AUTH_INVALID_CREDENTIALS");
    }
    const res = await attempt();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_ACCOUNT_LOCKED");
    expect(res.body.error.retryAfter).toBe(900);
    expect(res.headers["retry-after"]).toBe("900");
    expect(repo.recordFailedLogin).toHaveBeenLastCalledWith("user-lock", 900);
  });

  it("a locked account answers AUTH_ACCOUNT_LOCKED with the remaining seconds", async () => {
    repo.findByAccountForLogin.mockResolvedValue(
      activeUser({ lockedUntil: new Date(Date.now() + 60_000) })
    );

    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD });

    expect(res.body.error.code).toBe("AUTH_ACCOUNT_LOCKED");
    expect(res.body.error.retryAfter).toBeGreaterThan(55);
    expect(res.body.error.retryAfter).toBeLessThanOrEqual(60);
  });

  it("returns 401 when the account is locked", async () => {
    repo.findByAccountForLogin.mockResolvedValue(
      activeUser({ lockedUntil: new Date(Date.now() + 60_000) })
    );

    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD });

    expect(res.status).toBe(401);
  });

  // A DISABLED account keeps the sentence it always had. The deleted-account
  // code added alongside it (see login-extra.test.ts) must not swallow this
  // one: disabled and deleted are different states with different advice.
  it("returns 401 AUTH_ACCOUNT_NOT_ACTIVE when the account is not ACTIVE", async () => {
    repo.findByAccountForLogin.mockResolvedValue(
      activeUser({ status: "PENDING_DELETION" })
    );

    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("AUTH_ACCOUNT_NOT_ACTIVE");
    expect(res.body.message).toBe(
      "Your account has been disabled. Please contact support."
    );
  });

  // 403, not 401: a ban is permanent, so the client must stop retrying rather
  // than read it as "sign in again".
  it("returns 403 ACCOUNT_BANNED for a permanently banned account", async () => {
    repo.findByAccountForLogin.mockResolvedValue(
      activeUser({ status: "BANNED" })
    );

    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_BANNED");
  });

  it("ban message carries the reason, but only for the right password", async () => {
    repo.findByAccountForLogin.mockResolvedValue(
      activeUser({ status: "BANNED", suspendedReason: "Spam" })
    );

    const ok = await request(app)
      .post("/api/auth/login")
      .set("x-lang", "en")
      .send({ account: "johndoe", password: PASSWORD });
    expect(ok.status).toBe(403);
    expect(ok.body.code).toBe("ACCOUNT_BANNED");
    expect(ok.body.error.message).toBe(
      "Your account has been permanently banned. Reason: Spam"
    );
    expect(ok.body.error.details).toEqual({ reason: "Spam" });

    const wrong = await request(app)
      .post("/api/auth/login")
      .set("x-lang", "en")
      .send({ account: "johndoe", password: "WrongPassword999" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("ACCOUNT_BANNED");
    expect(wrong.body.error.details).toBeUndefined();
  });

  it("live suspension → 403 ACCOUNT_SUSPENDED with until in the viewer's zone", async () => {
    const until = Date.UTC(2099, 9, 20, 15, 0);
    repo.findByAccountForLogin.mockResolvedValue(
      activeUser({
        status: "SUSPENDED",
        suspendedReason: "Abuse",
        suspendedUntil: new Date(until),
      })
    );

    const res = await request(app)
      .post("/api/auth/login")
      .set("x-lang", "en")
      .set("x-timezone", "Asia/Ho_Chi_Minh")
      .send({ account: "johndoe", password: PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
    expect(res.body.error.message).toBe(
      "Your account is suspended until 10:00 PM, Oct 20, 2099. Reason: Abuse"
    );
    expect(res.body.error.details).toEqual({ until, reason: "Abuse" });
    expect(issue).not.toHaveBeenCalled();
  });

  it("elapsed suspension is lifted at sign-in and the login succeeds", async () => {
    repo.findByAccountForLogin.mockResolvedValue(
      activeUser({
        status: "SUSPENDED",
        suspendedReason: "Abuse",
        suspendedUntil: new Date(Date.now() - 1000),
      })
    );

    const res = await request(app)
      .post("/api/auth/login")
      .send({ account: "johndoe", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(accountBanService.liftExpiredSuspension).toHaveBeenCalledWith(
      "user-1"
    );
  });
});
