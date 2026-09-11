/**
 * POST /api/auth/login — the account/password form against an account whose
 * only sign-in method is Google or Apple.
 *
 * Such an account has no `passwordHash`, so no password can ever be correct for
 * it. The endpoint used to answer with the generic AUTH_PASSWORD_NOT_SET, which
 * every client rendered as "Incorrect account or password" — a sentence that
 * sends the user off to reset a password they never had. It now names the
 * provider, so the client can point at the button that works.
 *
 * The line drawn here is `passwordHash === null`, NOT "has a Google link". An
 * account that set a password and later linked a provider supports both, and
 * these tests pin that it still gets an ordinary credential check.
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
const WRONG_PASSWORD = "Wrong-Horse-Battery-8";
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

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    account: "johndoe",
    email: null,
    emailVerified: true,
    passwordHash,
    deletedAt: null,
    lockedUntil: null,
    status: "ACTIVE",
    isProfileCompleted: true,
    role: "USER",
    primaryAccount: null,
    linkedAccounts: [],
    ...overrides,
  };
}

/** An account founded by a social sign-in: no password, one provider link. */
function socialOnlyUser(provider: "GOOGLE" | "APPLE") {
  return user({
    passwordHash: null,
    primaryAccount: provider,
    linkedAccounts: [{ provider }],
  });
}

const login = (body: Record<string, unknown>) =>
  request(app).post("/api/auth/login").send(body);

describe("POST /api/auth/login — provider-required errors", () => {
  beforeEach(() => {
    repo.findByAccountForLogin.mockResolvedValue(user());
    repo.recordSuccessfulLogin.mockResolvedValue(undefined);
    repo.recordFailedLogin.mockResolvedValue(undefined);
    repo.mergeFcmTokens.mockResolvedValue(undefined);
    issue.mockResolvedValue({ tokens: TOKENS, sessionId: "sess-1" });
  });

  it("signs in a password account with the right password", async () => {
    const res = await login({ account: "johndoe", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.tokens.accessToken).toBe(TOKENS.accessToken);
  });

  it("answers AUTH_INVALID_CREDENTIALS for a password account with the wrong password", async () => {
    const res = await login({ account: "johndoe", password: WRONG_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(repo.recordFailedLogin).toHaveBeenCalled();
  });

  it("answers AUTH_GOOGLE_LOGIN_REQUIRED for a Google-only account", async () => {
    repo.findByAccountForLogin.mockResolvedValue(socialOnlyUser("GOOGLE"));

    const res = await login({ account: "johndoe", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_GOOGLE_LOGIN_REQUIRED");
    expect(res.body.error.message).toBe(
      "Your account is linked to Google. Please continue with Google to log in."
    );
    expect(issue).not.toHaveBeenCalled();
    // No credential was checked, so nothing counts toward the lockout: pressing
    // the wrong button must not lock the user out of the right one.
    expect(repo.recordFailedLogin).not.toHaveBeenCalled();
  });

  it("answers AUTH_APPLE_LOGIN_REQUIRED for an Apple-only account", async () => {
    repo.findByAccountForLogin.mockResolvedValue(socialOnlyUser("APPLE"));

    const res = await login({ account: "johndoe", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_APPLE_LOGIN_REQUIRED");
    expect(res.body.error.message).toBe(
      "Your account is linked to Apple. Please continue with Apple to log in."
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it("localizes the provider sentence from the Accept-Language header", async () => {
    repo.findByAccountForLogin.mockResolvedValue(socialOnlyUser("GOOGLE"));

    const res = await request(app)
      .post("/api/auth/login")
      .set("Accept-Language", "vi")
      .send({ account: "johndoe", password: PASSWORD });

    expect(res.body.error.code).toBe("AUTH_GOOGLE_LOGIN_REQUIRED");
    expect(res.body.error.message).toBe(
      "Tài khoản của bạn được liên kết với Google. Vui lòng tiếp tục bằng Google để đăng nhập"
    );
  });

  // The requirement this feature exists to NOT break: a linked provider is not
  // by itself a reason to refuse a password.
  it.each(["GOOGLE", "APPLE"] as const)(
    "still signs in a password account that also has %s linked",
    async (provider) => {
      repo.findByAccountForLogin.mockResolvedValue(
        user({ primaryAccount: provider, linkedAccounts: [{ provider }] })
      );

      const res = await login({ account: "johndoe", password: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data.tokens.accessToken).toBe(TOKENS.accessToken);
    }
  );

  it.each(["GOOGLE", "APPLE"] as const)(
    "answers AUTH_INVALID_CREDENTIALS, not a provider error, for a wrong password on an account with %s linked",
    async (provider) => {
      repo.findByAccountForLogin.mockResolvedValue(
        user({ primaryAccount: provider, linkedAccounts: [{ provider }] })
      );

      const res = await login({ account: "johndoe", password: WRONG_PASSWORD });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTH_INVALID_CREDENTIALS");
    }
  );

  it("keeps the generic AUTH_PASSWORD_NOT_SET when nothing social is linked", async () => {
    // Reachable for an account with neither a password nor a provider — there
    // is no button to send the user to, so the reason stays generic.
    repo.findByAccountForLogin.mockResolvedValue(
      user({ passwordHash: null, primaryAccount: "EMAIL", linkedAccounts: [] })
    );

    const res = await login({ account: "johndoe", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_PASSWORD_NOT_SET");
  });

  it("names the provider even when primaryAccount is EMAIL", async () => {
    // An OTP-linked address can hold the primary slot while the only usable
    // sign-in method is still the provider link.
    repo.findByAccountForLogin.mockResolvedValue(
      user({
        passwordHash: null,
        primaryAccount: "EMAIL",
        linkedAccounts: [{ provider: "APPLE" }],
      })
    );

    const res = await login({ account: "johndoe", password: PASSWORD });

    expect(res.body.error.code).toBe("AUTH_APPLE_LOGIN_REQUIRED");
  });

  it("answers AUTH_INVALID_CREDENTIALS for an unknown account", async () => {
    repo.findByAccountForLogin.mockResolvedValue(null);

    const res = await login({ account: "ghostuser", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_INVALID_CREDENTIALS");
  });

  // The provider hint refines a branch that already answered differently from
  // an unknown account, so it reveals nothing new — but the two shapes must
  // stay distinct in the direction the security model expects.
  it("does not answer a provider error for an identifier no account owns", async () => {
    repo.findByEmailForLogin.mockResolvedValue(null);

    const res = await login({
      account: "nobody@example.com",
      password: PASSWORD,
    });

    expect(res.body.error.code).toBe("AUTH_INVALID_CREDENTIALS");
  });

  it("routes an email identifier through the same provider decision", async () => {
    repo.findByEmailForLogin.mockResolvedValue({
      ...socialOnlyUser("GOOGLE"),
      email: "john@example.com",
    });

    const res = await login({
      account: "john@example.com",
      password: PASSWORD,
    });

    expect(res.body.error.code).toBe("AUTH_GOOGLE_LOGIN_REQUIRED");
  });
});
