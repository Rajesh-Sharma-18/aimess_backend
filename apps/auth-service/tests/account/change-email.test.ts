/**
 * POST /api/auth/change-email/request and /verify (auth required). The OTP
 * issuance helper + email publisher are stubbed; the account-guard and OTP
 * repositories are mocked so the email-state guards (no email set, old mismatch,
 * same old/new, taken elsewhere, OTP invalid) all run.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByIdForAccountOps: jest.fn(),
    findEmailTakenByOtherUser: jest.fn(),
    updateVerifiedEmail: jest.fn(),
  },
}));
jest.mock("../../src/repositories/otp.repository.js", () => ({
  otpRepository: {
    findLatestActive: jest.fn(),
    incrementAttempts: jest.fn(async () => undefined),
    markConsumed: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/lib/send-email-otp.js", () => ({
  sendEmailOtp: jest.fn(async () => ({ code: "123456" })),
}));
jest.mock("../../src/lib/otp.js", () => ({
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
  verifyOtpCode: jest.fn(async () => true),
}));
jest.mock("../../src/messaging/publish-auth-email-otp.js", () => ({
  publishChangeEmailOtpSafe: jest.fn(),
  publishLinkEmailOtpSafe: jest.fn(),
}));
jest.mock("../../src/lib/profile-socket.js", () => ({
  emitProfileUpdatedSafe: jest.fn(),
}));

import request from "supertest";

import app from "../../src/app.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { otpRepository } from "../../src/repositories/otp.repository.js";
import { verifyOtpCode } from "../../src/lib/otp.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const repo = authRepository as unknown as Record<string, jest.Mock>;
const otpRepo = otpRepository as unknown as Record<string, jest.Mock>;
const verifyCode = verifyOtpCode as unknown as jest.Mock;

const OLD = "old@example.com";
const NEW = "new@example.com";

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_USER_ID,
    email: OLD,
    emailVerified: true,
    passwordHash: "hash",
    status: "ACTIVE",
    deletedAt: null,
    ...overrides,
  };
}

describe("POST /api/auth/change-email/request", () => {
  beforeEach(() => {
    repo.findByIdForAccountOps.mockResolvedValue(activeUser());
    repo.findEmailTakenByOtherUser.mockResolvedValue(null);
  });

  it("sends a change-email OTP for a valid request → 200", async () => {
    const res = await request(app)
      .post("/api/auth/change-email/request")
      .set(bearer(makeAccessToken()))
      .send({ oldEmail: OLD, newEmail: NEW });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when the account has no email set", async () => {
    repo.findByIdForAccountOps.mockResolvedValue(activeUser({ email: null }));

    const res = await request(app)
      .post("/api/auth/change-email/request")
      .set(bearer(makeAccessToken()))
      .send({ oldEmail: OLD, newEmail: NEW });

    expect(res.status).toBe(400);
  });

  it("returns 400 when oldEmail does not match the account email", async () => {
    const res = await request(app)
      .post("/api/auth/change-email/request")
      .set(bearer(makeAccessToken()))
      .send({ oldEmail: "wrong@example.com", newEmail: NEW });

    expect(res.status).toBe(400);
  });

  it("returns 400 when newEmail equals oldEmail", async () => {
    const res = await request(app)
      .post("/api/auth/change-email/request")
      .set(bearer(makeAccessToken()))
      .send({ oldEmail: OLD, newEmail: OLD });

    expect(res.status).toBe(400);
  });

  it("returns 409 when the new email is taken by another user", async () => {
    repo.findEmailTakenByOtherUser.mockResolvedValue({ id: "other-user" });

    const res = await request(app)
      .post("/api/auth/change-email/request")
      .set(bearer(makeAccessToken()))
      .send({ oldEmail: OLD, newEmail: NEW });

    expect(res.status).toBe(409);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/auth/change-email/request")
      .send({ oldEmail: OLD, newEmail: NEW });

    expect(res.status).toBe(401);
  });

  it.each([
    ["invalid newEmail", { oldEmail: OLD, newEmail: "nope" }],
    ["missing newEmail", { oldEmail: OLD }],
    ["invalid oldEmail", { oldEmail: "nope", newEmail: NEW }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/auth/change-email/request")
      .set(bearer(makeAccessToken()))
      .send(body);

    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/change-email/verify", () => {
  beforeEach(() => {
    repo.findByIdForAccountOps.mockResolvedValue(activeUser());
    repo.findEmailTakenByOtherUser.mockResolvedValue(null);
    repo.updateVerifiedEmail.mockResolvedValue({
      id: TEST_USER_ID,
      emailVerified: true,
    });
    otpRepo.findLatestActive.mockResolvedValue({
      id: "otp-1",
      userId: TEST_USER_ID,
      attempts: 0,
      maxAttempts: 5,
      codeHash: "hashed",
    });
    verifyCode.mockResolvedValue(true);
  });

  it("verifies the OTP and changes the email → 200", async () => {
    const res = await request(app)
      .post("/api/auth/change-email/verify")
      .set(bearer(makeAccessToken()))
      .send({ oldEmail: OLD, newEmail: NEW, code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.data.emailVerified).toBe(true);
    expect(repo.updateVerifiedEmail).toHaveBeenCalledWith(TEST_USER_ID, NEW);
  });

  it("returns 400 when no active OTP exists", async () => {
    otpRepo.findLatestActive.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/change-email/verify")
      .set(bearer(makeAccessToken()))
      .send({ oldEmail: OLD, newEmail: NEW, code: "123456" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when the OTP belongs to a different user (IDOR-safe)", async () => {
    otpRepo.findLatestActive.mockResolvedValue({
      id: "otp-1",
      userId: "someone-else",
      attempts: 0,
      maxAttempts: 5,
      codeHash: "hashed",
    });

    const res = await request(app)
      .post("/api/auth/change-email/verify")
      .set(bearer(makeAccessToken()))
      .send({ oldEmail: OLD, newEmail: NEW, code: "123456" });

    expect(res.status).toBe(400);
    expect(repo.updateVerifiedEmail).not.toHaveBeenCalled();
  });

  it("returns 400 and increments attempts on a wrong code", async () => {
    verifyCode.mockResolvedValue(false);

    const res = await request(app)
      .post("/api/auth/change-email/verify")
      .set(bearer(makeAccessToken()))
      .send({ oldEmail: OLD, newEmail: NEW, code: "000000" });

    expect(res.status).toBe(400);
    expect(otpRepo.incrementAttempts).toHaveBeenCalledWith("otp-1");
  });

  it("returns 400 on a malformed code", async () => {
    const res = await request(app)
      .post("/api/auth/change-email/verify")
      .set(bearer(makeAccessToken()))
      .send({ oldEmail: OLD, newEmail: NEW, code: "12" });

    expect(res.status).toBe(400);
  });
});
