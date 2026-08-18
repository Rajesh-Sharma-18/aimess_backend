/**
 * POST /api/auth/link-email/request and /verify (auth required). Links a fresh
 * email to a (likely social-only) account. Covers: new-email OTP issuance,
 * the "same email already verified" rejection, the re-send when the email is on
 * the account but unverified, conflict when the email is taken elsewhere, and a
 * successful verify+link.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByIdForEmailLink: jest.fn(),
    findEmailTakenByOtherUser: jest.fn(),
    linkVerifiedEmailAndSetPrimary: jest.fn(),
  },
}));
jest.mock("../../src/repositories/otp.repository.js", () => ({
  otpRepository: {
    consumeActiveForIdentifier: jest.fn(async () => undefined),
    create: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/lib/otp.js", () => ({
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
  generateOtpCode: jest.fn(() => "123456"),
  hashOtpCode: jest.fn(async () => "hashed-code"),
  logDevOtp: jest.fn(),
  verifyAndConsumeOtp: jest.fn(async () => undefined),
}));
jest.mock("../../src/messaging/publish-auth-email-otp.js", () => ({
  publishLinkEmailOtpSafe: jest.fn(),
  publishChangeEmailOtpSafe: jest.fn(),
}));
jest.mock("../../src/lib/profile-socket.js", () => ({
  emitProfileUpdatedSafe: jest.fn(),
}));

import request from "supertest";

import app from "../../src/app.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { emitProfileUpdatedSafe } from "../../src/lib/profile-socket.js";
import { verifyAndConsumeOtp } from "../../src/lib/otp.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const repo = authRepository as unknown as Record<string, jest.Mock>;
const consumeOtp = verifyAndConsumeOtp as unknown as jest.Mock;

const EMAIL = "fresh@example.com";

function linkUser(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_USER_ID,
    email: null,
    emailVerified: false,
    status: "ACTIVE",
    deletedAt: null,
    ...overrides,
  };
}

describe("POST /api/auth/link-email/request", () => {
  beforeEach(() => {
    repo.findByIdForEmailLink.mockResolvedValue(linkUser());
    repo.findEmailTakenByOtherUser.mockResolvedValue(null);
  });

  it("sends an OTP for a brand-new email → 200", async () => {
    const res = await request(app)
      .post("/api/auth/link-email/request")
      .set(bearer(makeAccessToken()))
      .send({ email: EMAIL });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when the email is already verified on this account", async () => {
    repo.findByIdForEmailLink.mockResolvedValue(
      linkUser({ email: EMAIL, emailVerified: true })
    );

    const res = await request(app)
      .post("/api/auth/link-email/request")
      .set(bearer(makeAccessToken()))
      .send({ email: EMAIL });

    expect(res.status).toBe(400);
  });

  it("re-sends an OTP when the email is on the account but unverified → 200", async () => {
    repo.findByIdForEmailLink.mockResolvedValue(
      linkUser({ email: EMAIL, emailVerified: false })
    );

    const res = await request(app)
      .post("/api/auth/link-email/request")
      .set(bearer(makeAccessToken()))
      .send({ email: EMAIL });

    expect(res.status).toBe(200);
  });

  it("returns 409 when the email is taken by another user", async () => {
    repo.findEmailTakenByOtherUser.mockResolvedValue({ id: "other-user" });

    const res = await request(app)
      .post("/api/auth/link-email/request")
      .set(bearer(makeAccessToken()))
      .send({ email: EMAIL });

    expect(res.status).toBe(409);
  });

  it("returns 401 when the account is not active (guard throws)", async () => {
    repo.findByIdForEmailLink.mockResolvedValue(
      linkUser({ status: "SUSPENDED" })
    );

    const res = await request(app)
      .post("/api/auth/link-email/request")
      .set(bearer(makeAccessToken()))
      .send({ email: EMAIL });

    expect(res.status).toBe(401);
  });

  // A permanent ban is a distinct, terminal verdict — 403, not the generic
  // "account not active" 401 that tells the client to re-authenticate.
  it("returns 403 ACCOUNT_BANNED when the account is permanently banned", async () => {
    repo.findByIdForEmailLink.mockResolvedValue(linkUser({ status: "BANNED" }));

    const res = await request(app)
      .post("/api/auth/link-email/request")
      .set(bearer(makeAccessToken()))
      .send({ email: EMAIL });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_BANNED");
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/auth/link-email/request")
      .send({ email: EMAIL });

    expect(res.status).toBe(401);
  });

  it.each([
    ["invalid email", { email: "nope" }],
    ["missing email", {}],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/auth/link-email/request")
      .set(bearer(makeAccessToken()))
      .send(body);

    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/link-email/verify", () => {
  beforeEach(() => {
    repo.findByIdForEmailLink.mockResolvedValue(linkUser());
    repo.findEmailTakenByOtherUser.mockResolvedValue(null);
    repo.linkVerifiedEmailAndSetPrimary.mockResolvedValue({
      id: TEST_USER_ID,
      emailVerified: true,
      primaryAccount: "EMAIL",
    });
    consumeOtp.mockResolvedValue(undefined);
  });

  it("verifies the OTP and links the email → 200", async () => {
    const res = await request(app)
      .post("/api/auth/link-email/verify")
      .set(bearer(makeAccessToken()))
      .send({ email: EMAIL, code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.data.emailVerified).toBe(true);
    expect(res.body.data.primaryAccount).toBe("EMAIL");
    expect(repo.linkVerifiedEmailAndSetPrimary).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the email got taken by another user before verify", async () => {
    repo.findEmailTakenByOtherUser.mockResolvedValue({ id: "other-user" });

    const res = await request(app)
      .post("/api/auth/link-email/verify")
      .set(bearer(makeAccessToken()))
      .send({ email: EMAIL, code: "123456" });

    expect(res.status).toBe(409);
    expect(consumeOtp).not.toHaveBeenCalled();
  });

  it("propagates an OTP-consume failure (invalid code → 400)", async () => {
    const { BadRequestError } = await import("@aimess/errors");
    consumeOtp.mockRejectedValue(new BadRequestError("AUTH_OTP_INVALID"));

    const res = await request(app)
      .post("/api/auth/link-email/verify")
      .set(bearer(makeAccessToken()))
      .send({ email: EMAIL, code: "000000" });

    expect(res.status).toBe(400);
    expect(repo.linkVerifiedEmailAndSetPrimary).not.toHaveBeenCalled();
  });

  it("signals the user's other devices to re-fetch their profile", async () => {
    (emitProfileUpdatedSafe as unknown as jest.Mock).mockClear();

    await request(app)
      .post("/api/auth/link-email/verify")
      .set(bearer(makeAccessToken()))
      .send({ email: EMAIL, code: "123456" });

    expect(emitProfileUpdatedSafe).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it("maps a unique-index race on the email to 409, not 500", async () => {
    // Both accounts passed findEmailTakenByOtherUser; the loser hits P2002.
    repo.linkVerifiedEmailAndSetPrimary.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    const res = await request(app)
      .post("/api/auth/link-email/verify")
      .set(bearer(makeAccessToken()))
      .send({ email: EMAIL, code: "123456" });

    expect(res.status).toBe(409);
  });

  it("returns 400 on a malformed code", async () => {
    const res = await request(app)
      .post("/api/auth/link-email/verify")
      .set(bearer(makeAccessToken()))
      .send({ email: EMAIL, code: "abc" });

    expect(res.status).toBe(400);
  });
});
