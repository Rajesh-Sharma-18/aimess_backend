/**
 * POST /api/auth/social/google/link, /social/apple/link, /social/unlink
 * (all auth required). The ESM-only verifiers are stubbed; the account-guard,
 * linked-account and auth repositories are mocked so the link/unlink guards
 * (already-linked, linked-elsewhere, provider-already-linked, not-linked,
 * last-sign-in-method) all run.
 */
jest.mock("../../src/lib/google-id-token.js", () => ({
  verifyGoogleIdToken: jest.fn(),
}));
jest.mock("../../src/lib/apple-id-token.js", () => ({
  verifyAppleIdToken: jest.fn(),
}));
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByIdForAccountOps: jest.fn(),
    setPrimaryAccountIfUnset: jest.fn(),
  },
}));
jest.mock("../../src/repositories/linked-account.repository.js", () => ({
  linkedAccountRepository: {
    findByProvider: jest.fn(),
    findByUserIdAndProvider: jest.fn(),
    create: jest.fn(async () => undefined),
    countByUserId: jest.fn(),
    deleteByUserIdAndProvider: jest.fn(async () => undefined),
  },
}));

import request from "supertest";

import app from "../../src/app.js";
import { verifyGoogleIdToken } from "../../src/lib/google-id-token.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { linkedAccountRepository } from "../../src/repositories/linked-account.repository.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const verifyGoogle = verifyGoogleIdToken as unknown as jest.Mock;
const repo = authRepository as unknown as Record<string, jest.Mock>;
const linkRepo = linkedAccountRepository as unknown as Record<
  string,
  jest.Mock
>;

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_USER_ID,
    email: "john@example.com",
    emailVerified: true,
    passwordHash: "hash",
    status: "ACTIVE",
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  verifyGoogle.mockResolvedValue({
    sub: "google-sub-123",
    email: "john@example.com",
    displayName: "John",
  });
  repo.findByIdForAccountOps.mockResolvedValue(activeUser());
  repo.setPrimaryAccountIfUnset.mockResolvedValue("GOOGLE");
  linkRepo.findByProvider.mockResolvedValue(null);
  linkRepo.findByUserIdAndProvider.mockResolvedValue(null);
  linkRepo.countByUserId.mockResolvedValue(2);
});

describe("POST /api/auth/social/google/link", () => {
  it("links a Google account → 200", async () => {
    const res = await request(app)
      .post("/api/auth/social/google/link")
      .set(bearer(makeAccessToken()))
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.provider).toBe("GOOGLE");
    expect(linkRepo.create).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when the provider is already linked to THIS user", async () => {
    linkRepo.findByProvider.mockResolvedValue({ userId: TEST_USER_ID });

    const res = await request(app)
      .post("/api/auth/social/google/link")
      .set(bearer(makeAccessToken()))
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(400);
    expect(linkRepo.create).not.toHaveBeenCalled();
  });

  it("returns 409 when the provider account is linked to ANOTHER user", async () => {
    linkRepo.findByProvider.mockResolvedValue({ userId: "someone-else" });

    const res = await request(app)
      .post("/api/auth/social/google/link")
      .set(bearer(makeAccessToken()))
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(409);
  });

  it("returns 400 when the user already has a Google provider linked", async () => {
    linkRepo.findByUserIdAndProvider.mockResolvedValue({ id: "link-1" });

    const res = await request(app)
      .post("/api/auth/social/google/link")
      .set(bearer(makeAccessToken()))
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(400);
  });

  it("returns 401 when the account is not active (guard throws)", async () => {
    repo.findByIdForAccountOps.mockResolvedValue(
      activeUser({ status: "SUSPENDED" })
    );

    const res = await request(app)
      .post("/api/auth/social/google/link")
      .set(bearer(makeAccessToken()))
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(401);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/auth/social/google/link")
      .send({ idToken: "valid-google-token" });

    expect(res.status).toBe(401);
  });

  it.each([
    ["missing idToken", {}],
    ["empty idToken", { idToken: "" }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/auth/social/google/link")
      .set(bearer(makeAccessToken()))
      .send(body);

    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/social/unlink", () => {
  beforeEach(() => {
    linkRepo.findByUserIdAndProvider.mockResolvedValue({ id: "link-1" });
    linkRepo.countByUserId.mockResolvedValue(1);
  });

  it("unlinks a provider when other sign-in methods remain → 200", async () => {
    // User has a password + 1 linked account = 2 methods, so unlink is allowed.
    const res = await request(app)
      .post("/api/auth/social/unlink")
      .set(bearer(makeAccessToken()))
      .send({ provider: "GOOGLE" });

    expect(res.status).toBe(200);
    expect(res.body.data.provider).toBe("GOOGLE");
    expect(linkRepo.deleteByUserIdAndProvider).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when the provider is not linked", async () => {
    linkRepo.findByUserIdAndProvider.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/social/unlink")
      .set(bearer(makeAccessToken()))
      .send({ provider: "GOOGLE" });

    expect(res.status).toBe(400);
    expect(linkRepo.deleteByUserIdAndProvider).not.toHaveBeenCalled();
  });

  it("returns 400 when unlinking the last remaining sign-in method", async () => {
    // No password + exactly 1 linked account → cannot unlink the only method.
    repo.findByIdForAccountOps.mockResolvedValue(
      activeUser({ passwordHash: null, email: null })
    );

    const res = await request(app)
      .post("/api/auth/social/unlink")
      .set(bearer(makeAccessToken()))
      .send({ provider: "GOOGLE" });

    expect(res.status).toBe(400);
    expect(linkRepo.deleteByUserIdAndProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid provider enum", { provider: "FACEBOOK" }],
    ["missing provider", {}],
    ["lowercase provider", { provider: "google" }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/auth/social/unlink")
      .set(bearer(makeAccessToken()))
      .send(body);

    expect(res.status).toBe(400);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/auth/social/unlink")
      .send({ provider: "GOOGLE" });

    expect(res.status).toBe(401);
  });
});
