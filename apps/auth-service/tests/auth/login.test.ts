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
      activeUser({ status: "SUSPENDED" })
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
});
