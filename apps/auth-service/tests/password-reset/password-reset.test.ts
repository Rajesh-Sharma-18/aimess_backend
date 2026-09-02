/**
 * Forgot-password flow (all unauthenticated):
 *   POST /api/auth/forgot-password/request  → issues an OTP (404 if email unknown)
 *   POST /api/auth/forgot-password/verify   → verifies OTP, mints a reset token
 *   POST /api/auth/forgot-password/reset    → swaps the password for the token
 * Repositories + the OTP/reset-token crypto helpers are mocked so each guard is
 * driven from data; real Zod validation runs at the route boundary.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByEmailForPasswordReset: jest.fn(),
    findPasswordHashByUserId: jest.fn(),
    updatePasswordHash: jest.fn(async () => undefined),
    revokeSessionsAfterPasswordChange: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/repositories/otp.repository.js", () => ({
  otpRepository: {
    consumeActiveForIdentifier: jest.fn(async () => undefined),
    create: jest.fn(async () => undefined),
    findLatestActive: jest.fn(),
    incrementAttempts: jest.fn(async () => undefined),
    markConsumed: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/repositories/password-reset.repository.js", () => ({
  passwordResetRepository: {
    consumeActiveForUser: jest.fn(async () => undefined),
    create: jest.fn(async () => undefined),
    findValidByTokenHash: jest.fn(),
    markConsumed: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/repositories/session.repository.js", () => ({
  sessionRepository: {
    listActiveSessionIds: jest.fn(async () => []),
  },
}));
jest.mock("../../src/lib/otp.js", () => ({
  generateOtpCode: jest.fn(() => "123456"),
  hashOtpCode: jest.fn(async () => "hashed-code"),
  verifyOtpCode: jest.fn(async () => true),
  logDevOtp: jest.fn(),
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
}));
jest.mock("../../src/lib/password-reset-token.js", () => ({
  createPasswordResetToken: jest.fn(() => "a".repeat(64)),
  hashPasswordResetToken: jest.fn(() => "reset-token-hash"),
}));
jest.mock("../../src/messaging/publish-password-reset-otp.js", () => ({
  publishPasswordResetOtpSafe: jest.fn(),
}));
jest.mock("../../src/messaging/publish-session-revoked.js", () => ({
  publishSessionDeviceRevokedSafe: jest.fn(),
  publishAllSessionsRevokedSafe: jest.fn(),
}));
jest.mock("@aimess/redis", () => ({
  ...jest.requireActual("@aimess/redis"),
  publishSessionRevokedEvent: jest.fn(async () => 0),
}));

import request from "supertest";

import { publishSessionRevokedEvent } from "@aimess/redis";

import app from "../../src/app.js";
import { publishAllSessionsRevokedSafe } from "../../src/messaging/publish-session-revoked.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { otpRepository } from "../../src/repositories/otp.repository.js";
import { passwordResetRepository } from "../../src/repositories/password-reset.repository.js";
import { sessionRepository } from "../../src/repositories/session.repository.js";
import { verifyOtpCode } from "../../src/lib/otp.js";

const authRepo = authRepository as unknown as Record<string, jest.Mock>;
const sessionRepo = sessionRepository as unknown as Record<string, jest.Mock>;
const publishAllRevoked = publishAllSessionsRevokedSafe as unknown as jest.Mock;
const publishRevoked = publishSessionRevokedEvent as unknown as jest.Mock;
const otpRepo = otpRepository as unknown as Record<string, jest.Mock>;
const resetRepo = passwordResetRepository as unknown as Record<
  string,
  jest.Mock
>;
const verifyCode = verifyOtpCode as unknown as jest.Mock;

function resettableUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    passwordHash: "stored-hash",
    status: "ACTIVE",
    deletedAt: null,
    linkedAccounts: [],
    ...overrides,
  };
}

function activeOtp(overrides: Record<string, unknown> = {}) {
  return {
    id: "otp-1",
    userId: "user-1",
    attempts: 0,
    maxAttempts: 5,
    codeHash: "hashed-code",
    ...overrides,
  };
}

describe("POST /api/auth/forgot-password/request", () => {
  beforeEach(() => {
    authRepo.findByEmailForPasswordReset.mockResolvedValue(resettableUser());
  });

  it("issues an OTP for a known, resettable account → 200", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password/request")
      .send({ email: "john@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe("john@example.com");
    expect(otpRepo.create).toHaveBeenCalledTimes(1);
  });

  it("normalizes the email to lowercase in the response", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password/request")
      .send({ email: "JOHN@Example.com" });

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe("john@example.com");
  });

  /**
   * AIM-07 / AIM-64. These two previously asserted a 404, which made the
   * endpoint a membership oracle: 404 for an unknown address, 200 for a
   * registered one, so any email could be tested for an account by status code
   * alone — the input to targeted credential stuffing. The answer is now
   * identical either way, matching the backoffice equivalent. No OTP is issued
   * for an address that cannot reset, which is what the `otpRepo` assertions
   * pin.
   */
  it("answers 200 for an unknown email, issuing no OTP", async () => {
    authRepo.findByEmailForPasswordReset.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/forgot-password/request")
      .send({ email: "ghost@example.com" });

    expect(res.status).toBe(200);
    expect(otpRepo.create).not.toHaveBeenCalled();
  });

  it("answers 200 for a deleted account (cannot reset), issuing no OTP", async () => {
    authRepo.findByEmailForPasswordReset.mockResolvedValue(
      resettableUser({ deletedAt: new Date() })
    );

    const res = await request(app)
      .post("/api/auth/forgot-password/request")
      .send({ email: "john@example.com" });

    expect(res.status).toBe(200);
    expect(otpRepo.create).not.toHaveBeenCalled();
  });

  it("is indistinguishable from a real request: same status and body", async () => {
    // The whole point of the change — a caller must not be able to tell the two
    // apart. The SAME address is used for both calls, so nothing
    // address-dependent can explain a difference; only the lookup result
    // varies.
    //
    // A fresh address, because the OTP issuance throttle is keyed by identifier
    // and the cases above have already spent quota on `john@example.com` —
    // reusing it here would throttle the second call and compare a 429 against
    // a 200.
    const probe = "indistinguishability-probe@example.com";

    authRepo.findByEmailForPasswordReset.mockResolvedValue(resettableUser());
    const real = await request(app)
      .post("/api/auth/forgot-password/request")
      .send({ email: probe });

    authRepo.findByEmailForPasswordReset.mockResolvedValue(null);
    const ghost = await request(app)
      .post("/api/auth/forgot-password/request")
      .send({ email: probe });

    expect(real.status).toBe(200);
    expect(ghost.status).toBe(real.status);
    expect(ghost.body).toEqual(real.body);
  });

  it.each([
    ["missing email", {}],
    ["invalid email", { email: "not-an-email" }],
    ["empty email", { email: "" }],
    ["wrong type", { email: 42 }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/auth/forgot-password/request")
      .send(body);

    expect(res.status).toBe(400);
    expect(authRepo.findByEmailForPasswordReset).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/forgot-password/verify", () => {
  beforeEach(() => {
    otpRepo.findLatestActive.mockResolvedValue(activeOtp());
    authRepo.findByEmailForPasswordReset.mockResolvedValue(resettableUser());
    verifyCode.mockResolvedValue(true);
  });

  it("verifies a correct OTP and returns a reset token → 200", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password/verify")
      .send({ email: "john@example.com", code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.data.resetToken).toBeDefined();
    expect(res.body.data.resetTokenExpiresIn).toBeGreaterThan(0);
    expect(resetRepo.create).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when no active OTP exists", async () => {
    otpRepo.findLatestActive.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/forgot-password/verify")
      .send({ email: "john@example.com", code: "123456" });

    expect(res.status).toBe(400);
  });

  it("returns 400 and increments attempts on a wrong code", async () => {
    verifyCode.mockResolvedValue(false);

    const res = await request(app)
      .post("/api/auth/forgot-password/verify")
      .send({ email: "john@example.com", code: "000000" });

    expect(res.status).toBe(400);
    expect(otpRepo.incrementAttempts).toHaveBeenCalledWith("otp-1");
    expect(resetRepo.create).not.toHaveBeenCalled();
  });

  it("returns 400 when the OTP attempt cap is already reached", async () => {
    otpRepo.findLatestActive.mockResolvedValue(
      activeOtp({ attempts: 5, maxAttempts: 5 })
    );

    const res = await request(app)
      .post("/api/auth/forgot-password/verify")
      .send({ email: "john@example.com", code: "123456" });

    expect(res.status).toBe(400);
    expect(verifyCode).not.toHaveBeenCalled();
  });

  it.each([
    ["code not 6 digits", { email: "john@example.com", code: "123" }],
    ["non-numeric code", { email: "john@example.com", code: "abcdef" }],
    ["missing code", { email: "john@example.com" }],
    ["missing email", { code: "123456" }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/auth/forgot-password/verify")
      .send(body);

    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/forgot-password/reset", () => {
  beforeEach(() => {
    resetRepo.findValidByTokenHash.mockResolvedValue({
      id: "prt-1",
      userId: "user-1",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    authRepo.findPasswordHashByUserId.mockResolvedValue({
      passwordHash: null,
      status: "ACTIVE",
      deletedAt: null,
      linkedAccounts: [{ id: "link-1" }],
    });
    // clearMocks only clears call history, not queued resolutions — reset the
    // session list explicitly so one test's device fixture can't leak forward.
    sessionRepo.listActiveSessionIds.mockResolvedValue([]);
  });

  it("resets the password with a valid token → 200", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password/reset")
      .send({ resetToken: "a".repeat(64), password: "NewPassword123" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(authRepo.updatePasswordHash).toHaveBeenCalledTimes(1);
    expect(resetRepo.markConsumed).toHaveBeenCalledWith("prt-1");
  });

  // A reset trusts no session, so EVERY device is signed out — and every
  // device's push token has to go with it. Before this, the reset revoked the
  // sessions and published nothing, so the attacker's device stayed both
  // socket-connected and push-enabled.
  it("drops every push token and kicks every socket on a successful reset", async () => {
    sessionRepo.listActiveSessionIds.mockResolvedValue([
      { id: "sess-a" },
      { id: "sess-b" },
    ]);

    const res = await request(app)
      .post("/api/auth/forgot-password/reset")
      .send({ resetToken: "a".repeat(64), password: "NewPassword123" });

    expect(res.status).toBe(200);
    // No exceptSessionId — nothing is trusted after a reset.
    expect(publishAllRevoked).toHaveBeenCalledWith({ userId: "user-1" });
    expect(publishRevoked.mock.calls.map((call) => call[2])).toEqual([
      "sess-a",
      "sess-b",
    ]);
  });

  it("publishes nothing when the reset token is rejected", async () => {
    resetRepo.findValidByTokenHash.mockResolvedValue(null);

    await request(app)
      .post("/api/auth/forgot-password/reset")
      .send({ resetToken: "a".repeat(64), password: "NewPassword123" });

    expect(publishAllRevoked).not.toHaveBeenCalled();
    expect(publishRevoked).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown / invalid reset token", async () => {
    resetRepo.findValidByTokenHash.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/forgot-password/reset")
      .send({ resetToken: "a".repeat(64), password: "NewPassword123" });

    expect(res.status).toBe(400);
    expect(authRepo.updatePasswordHash).not.toHaveBeenCalled();
  });

  it("returns 400 for an already-consumed token", async () => {
    resetRepo.findValidByTokenHash.mockResolvedValue({
      id: "prt-1",
      userId: "user-1",
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request(app)
      .post("/api/auth/forgot-password/reset")
      .send({ resetToken: "a".repeat(64), password: "NewPassword123" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for an expired token", async () => {
    resetRepo.findValidByTokenHash.mockResolvedValue({
      id: "prt-1",
      userId: "user-1",
      consumedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await request(app)
      .post("/api/auth/forgot-password/reset")
      .send({ resetToken: "a".repeat(64), password: "NewPassword123" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when the account is no longer active", async () => {
    authRepo.findPasswordHashByUserId.mockResolvedValue({
      passwordHash: null,
      status: "SUSPENDED",
      deletedAt: null,
      linkedAccounts: [{ id: "link-1" }],
    });

    const res = await request(app)
      .post("/api/auth/forgot-password/reset")
      .send({ resetToken: "a".repeat(64), password: "NewPassword123" });

    expect(res.status).toBe(400);
  });

  // Reset COMPLETION is the one password-reset step where a valid one-time
  // token already proves ownership, so naming the ban leaks nothing an attacker
  // could enumerate. Requesting the OTP deliberately stays ambiguous.
  it("returns 403 ACCOUNT_BANNED when the account is permanently banned", async () => {
    authRepo.findPasswordHashByUserId.mockResolvedValue({
      passwordHash: null,
      status: "BANNED",
      deletedAt: null,
      linkedAccounts: [{ id: "link-1" }],
    });

    const res = await request(app)
      .post("/api/auth/forgot-password/reset")
      .send({ resetToken: "a".repeat(64), password: "NewPassword123" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_BANNED");
  });

  it.each([
    [
      "reset token too short",
      { resetToken: "short", password: "NewPassword123" },
    ],
    ["password too short", { resetToken: "a".repeat(64), password: "short" }],
    ["missing password", { resetToken: "a".repeat(64) }],
    ["missing reset token", { password: "NewPassword123" }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/auth/forgot-password/reset")
      .send(body);

    expect(res.status).toBe(400);
  });
});
