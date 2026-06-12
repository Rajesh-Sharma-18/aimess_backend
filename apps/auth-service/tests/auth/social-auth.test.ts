/**
 * POST /api/auth/google and POST /api/auth/apple — social login. The ESM-only
 * token verifiers (google-auth-library / jose) are stubbed; the repository +
 * token issuance are mocked. Exercises: existing-link login, auto-link by
 * verified email, brand-new account creation, the email-required conflict, the
 * account-state guards, and the Zod body matrix.
 */
jest.mock("../../src/lib/google-id-token.js", () => ({
  verifyGoogleIdToken: jest.fn(),
}));
jest.mock("../../src/lib/apple-id-token.js", () => ({
  verifyAppleIdToken: jest.fn(),
}));
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    mergeFcmTokens: jest.fn(),
    recordSuccessfulLogin: jest.fn(),
    getProfileCompleted: jest.fn(),
    findByEmail: jest.fn(),
    createUserWithLinkedAccount: jest.fn(),
  },
}));
jest.mock("../../src/repositories/linked-account.repository.js", () => ({
  linkedAccountRepository: {
    findByProvider: jest.fn(),
    create: jest.fn(),
  },
}));
jest.mock("../../src/lib/token.js", () => ({
  issueAuthTokens: jest.fn(),
}));
jest.mock("../../src/lib/social-account.util.js", () => ({
  buildSocialAccountBase: jest.fn(() => "googleuser"),
  generateUniqueAccount: jest.fn(async () => "googleuser1"),
}));

import request from "supertest";

import app from "../../src/app.js";
import { verifyGoogleIdToken } from "../../src/lib/google-id-token.js";
import { verifyAppleIdToken } from "../../src/lib/apple-id-token.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { linkedAccountRepository } from "../../src/repositories/linked-account.repository.js";
import { issueAuthTokens } from "../../src/lib/token.js";

const verifyGoogle = verifyGoogleIdToken as unknown as jest.Mock;
const verifyApple = verifyAppleIdToken as unknown as jest.Mock;
const repo = authRepository as unknown as Record<string, jest.Mock>;
const linkRepo = linkedAccountRepository as unknown as Record<
  string,
  jest.Mock
>;
const issue = issueAuthTokens as unknown as jest.Mock;

const TOKENS = {
  accessToken: "access.jwt.token",
  refreshToken: "refresh-token-value",
  accessTokenExpiresIn: 3600,
  refreshTokenExpiresIn: 604800,
};

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    account: "johndoe",
    email: "john@example.com",
    status: "ACTIVE",
    lockedUntil: null,
    deletedAt: null,
    isProfileCompleted: true,
    ...overrides,
  };
}

beforeEach(() => {
  verifyGoogle.mockResolvedValue({
    sub: "google-sub-123",
    email: "john@example.com",
    emailVerified: true,
    displayName: "John",
  });
  verifyApple.mockResolvedValue({
    sub: "apple-sub-123",
    email: "john@example.com",
    emailVerified: true,
    displayName: "John",
  });
  repo.mergeFcmTokens.mockResolvedValue(undefined);
  repo.recordSuccessfulLogin.mockResolvedValue(undefined);
  repo.getProfileCompleted.mockResolvedValue(true);
  repo.findByEmail.mockResolvedValue(null);
  repo.createUserWithLinkedAccount.mockResolvedValue({
    id: "new-user-1",
    account: "googleuser1",
    email: "john@example.com",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  linkRepo.findByProvider.mockResolvedValue(null);
  linkRepo.create.mockResolvedValue(undefined);
  issue.mockResolvedValue({ tokens: TOKENS, sessionId: "sess-1" });
});

describe("POST /api/auth/google", () => {
  it("logs in an existing linked user → 200, isNewUser:false", async () => {
    linkRepo.findByProvider.mockResolvedValue({ user: activeUser() });

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isNewUser).toBe(false);
    expect(res.body.data.tokens.accessToken).toBe(TOKENS.accessToken);
    expect(repo.recordSuccessfulLogin).toHaveBeenCalledWith("user-1");
  });

  it("auto-links a verified email to an existing account → 200, isNewUser:false", async () => {
    repo.findByEmail.mockResolvedValue(activeUser());

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(200);
    expect(res.body.data.isNewUser).toBe(false);
    expect(linkRepo.create).toHaveBeenCalledTimes(1);
  });

  it("creates a brand-new account when no link/email match → 200, isNewUser:true", async () => {
    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(200);
    expect(res.body.data.isNewUser).toBe(true);
    expect(res.body.data.isProfileCompleted).toBe(false);
    expect(repo.createUserWithLinkedAccount).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-link when the provider email is unverified (creates new instead)", async () => {
    verifyGoogle.mockResolvedValue({
      sub: "google-sub-123",
      email: "john@example.com",
      emailVerified: false,
      displayName: "John",
    });
    repo.findByEmail.mockResolvedValue(activeUser());

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(200);
    expect(res.body.data.isNewUser).toBe(true);
    expect(repo.findByEmail).not.toHaveBeenCalled();
  });

  it("returns 409 when the provider returns no email for a new user", async () => {
    verifyGoogle.mockResolvedValue({
      sub: "google-sub-123",
      email: null,
      emailVerified: false,
      displayName: "John",
    });

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 when the linked account is not ACTIVE", async () => {
    linkRepo.findByProvider.mockResolvedValue({
      user: activeUser({ status: "SUSPENDED" }),
    });

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(401);
  });

  it("returns 401 when the linked account is locked", async () => {
    linkRepo.findByProvider.mockResolvedValue({
      user: activeUser({ lockedUntil: new Date(Date.now() + 60_000) }),
    });

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(401);
  });

  it("propagates a token-verification failure as 500 (verifier throws)", async () => {
    verifyGoogle.mockRejectedValue(new Error("invalid signature"));

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "tampered-token" });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });

  it.each([
    ["missing idToken", {}],
    ["empty idToken", { idToken: "" }],
    ["wrong type", { idToken: 123 }],
    ["null idToken", { idToken: null }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app).post("/api/auth/google").send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(verifyGoogle).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/apple", () => {
  it("logs in via Apple with a verified token → 200", async () => {
    linkRepo.findByProvider.mockResolvedValue({ user: activeUser() });

    const res = await request(app)
      .post("/api/auth/apple")
      .send({ identityToken: "valid-apple-token" });

    expect(res.status).toBe(200);
    expect(res.body.data.isNewUser).toBe(false);
    expect(verifyApple).toHaveBeenCalledWith("valid-apple-token");
  });

  it("creates a new account from a client-supplied email when the token omits it", async () => {
    verifyApple.mockResolvedValue({
      sub: "apple-sub-123",
      email: null,
      emailVerified: false,
      displayName: null,
    });

    const res = await request(app)
      .post("/api/auth/apple")
      .send({ identityToken: "valid-apple-token", email: "john@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.data.isNewUser).toBe(true);
    // Client-supplied email is NOT trusted as verified → must not auto-link.
    expect(repo.findByEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["missing identityToken", {}],
    ["empty identityToken", { identityToken: "" }],
    ["invalid email format", { identityToken: "tok", email: "not-an-email" }],
    [
      "fullName too long (>100)",
      { identityToken: "tok", fullName: "a".repeat(101) },
    ],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app).post("/api/auth/apple").send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
