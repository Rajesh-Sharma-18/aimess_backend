/**
 * Public auth flows that need NO admin bearer:
 *   POST /v1/auth/refresh
 *   POST /v1/auth/forgot-password
 *   POST /v1/auth/verify-otp
 *   POST /v1/auth/resend-otp
 *   POST /v1/auth/reset-password
 *
 * Routing, the Zod schemas (incl. the strict admin-password policy + the
 * confirmPassword cross-field refine), the controllers and the success/error
 * envelopes run for real; the service layer is mocked so each branch is driven
 * deterministically (invalid OTP → 400, expired/invalid reset token → 400, …).
 */
jest.mock("../../src/services/index.js", () => {
  const actual = jest.requireActual("../../src/services/index.js");
  return {
    __esModule: true,
    ...actual,
    adminAuthService: { refresh: jest.fn() },
    adminPasswordResetService: {
      requestOtp: jest.fn(async () => undefined),
      resendOtp: jest.fn(async () => undefined),
      verifyOtp: jest.fn(),
      resetPassword: jest.fn(async () => undefined),
    },
  };
});

import request from "supertest";
import { BadRequestError, UnauthorizedError } from "@aimess/errors";

import { app } from "../../src/app.js";
import {
  adminAuthService,
  adminPasswordResetService,
} from "../../src/services/index.js";

const refreshSvc = adminAuthService as unknown as { refresh: jest.Mock };
const pr = adminPasswordResetService as unknown as {
  requestOtp: jest.Mock;
  resendOtp: jest.Mock;
  verifyOtp: jest.Mock;
  resetPassword: jest.Mock;
};

const VALID_PASSWORD = "Sup3rSecret!"; // 12 chars: upper+lower+digit+special
const RESET_TOKEN = "a".repeat(40); // >= 32 chars

describe("POST /v1/auth/refresh", () => {
  beforeEach(() => {
    refreshSvc.refresh.mockResolvedValue({
      tokens: {
        accessToken: "new.access",
        refreshToken: "new-refresh",
        accessTokenExpiresIn: 28800,
        refreshTokenExpiresIn: 604800,
      },
      admin: { id: "admin-1", role: "ADMIN", permissions: [] },
    });
  });

  it("rotates the token pair → 200", async () => {
    const res = await request(app)
      .post("/v1/auth/refresh")
      .send({ refreshToken: "old-refresh-token" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tokens.accessToken).toBe("new.access");
  });

  it("returns 401 for an invalid / already-rotated refresh token", async () => {
    refreshSvc.refresh.mockRejectedValue(
      new UnauthorizedError("AUTH_INVALID_TOKEN")
    );
    const res = await request(app)
      .post("/v1/auth/refresh")
      .send({ refreshToken: "tampered" });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it.each([
    ["missing refreshToken", {}],
    ["empty refreshToken", { refreshToken: "" }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app).post("/v1/auth/refresh").send(body);
    expect(res.status).toBe(400);
    expect(refreshSvc.refresh).not.toHaveBeenCalled();
  });
});

describe("POST /v1/auth/forgot-password (enumeration-safe)", () => {
  it("returns 200 + echoes the email for a known address", async () => {
    const res = await request(app)
      .post("/v1/auth/forgot-password")
      .send({ email: "Admin@Aimess.Local" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The validator lowercases the email before the service receives it.
    expect(res.body.data.email).toBe("admin@aimess.local");
    expect(pr.requestOtp).toHaveBeenCalledTimes(1);
  });

  it("returns the SAME 200 for an unknown address (no enumeration)", async () => {
    // The service silently no-ops for unknown emails; the controller still 200s.
    const res = await request(app)
      .post("/v1/auth/forgot-password")
      .send({ email: "ghost@aimess.local" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it.each([
    ["missing email", {}],
    ["malformed email", { email: "nope" }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app).post("/v1/auth/forgot-password").send(body);
    expect(res.status).toBe(400);
    expect(pr.requestOtp).not.toHaveBeenCalled();
  });
});

describe("POST /v1/auth/verify-otp", () => {
  beforeEach(() => {
    pr.verifyOtp.mockResolvedValue({
      resetToken: RESET_TOKEN,
      resetTokenExpiresIn: 600,
    });
  });

  it("verifies a correct 6-digit OTP → 200 with a reset token", async () => {
    const res = await request(app)
      .post("/v1/auth/verify-otp")
      .send({ email: "admin@aimess.local", code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.resetToken).toBe(RESET_TOKEN);
  });

  it("returns 400 for an invalid / expired OTP (service throws OTP_INVALID)", async () => {
    pr.verifyOtp.mockRejectedValue(new BadRequestError("OTP_INVALID"));
    const res = await request(app)
      .post("/v1/auth/verify-otp")
      .send({ email: "admin@aimess.local", code: "000000" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 after too many OTP attempts (OTP_MAX_ATTEMPTS)", async () => {
    pr.verifyOtp.mockRejectedValue(new BadRequestError("OTP_MAX_ATTEMPTS"));
    const res = await request(app)
      .post("/v1/auth/verify-otp")
      .send({ email: "admin@aimess.local", code: "123456" });

    expect(res.status).toBe(400);
  });

  it.each([
    ["non-numeric code", { email: "admin@aimess.local", code: "abcdef" }],
    ["too-short code", { email: "admin@aimess.local", code: "123" }],
    ["too-long code", { email: "admin@aimess.local", code: "1234567" }],
    ["missing code", { email: "admin@aimess.local" }],
    ["missing email", { code: "123456" }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app).post("/v1/auth/verify-otp").send(body);
    expect(res.status).toBe(400);
    expect(pr.verifyOtp).not.toHaveBeenCalled();
  });
});

describe("POST /v1/auth/resend-otp", () => {
  it("returns 200 + echoes the email", async () => {
    const res = await request(app)
      .post("/v1/auth/resend-otp")
      .send({ email: "admin@aimess.local" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(pr.resendOtp).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for a malformed email", async () => {
    const res = await request(app)
      .post("/v1/auth/resend-otp")
      .send({ email: "nope" });
    expect(res.status).toBe(400);
    expect(pr.resendOtp).not.toHaveBeenCalled();
  });
});

describe("POST /v1/auth/reset-password", () => {
  it("consumes the reset token + sets the password → 200", async () => {
    const res = await request(app).post("/v1/auth/reset-password").send({
      resetToken: RESET_TOKEN,
      password: VALID_PASSWORD,
      confirmPassword: VALID_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.reset).toBe(true);
    // confirmPassword is a validation-only field — never forwarded to the service.
    expect(pr.resetPassword).toHaveBeenCalledWith(expect.any(Object), {
      resetToken: RESET_TOKEN,
      password: VALID_PASSWORD,
    });
  });

  it("returns 400 for an invalid reset token (service throws RESET_TOKEN_INVALID)", async () => {
    pr.resetPassword.mockRejectedValue(
      new BadRequestError("RESET_TOKEN_INVALID")
    );
    const res = await request(app).post("/v1/auth/reset-password").send({
      resetToken: RESET_TOKEN,
      password: VALID_PASSWORD,
      confirmPassword: VALID_PASSWORD,
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for an expired reset token (RESET_TOKEN_EXPIRED)", async () => {
    pr.resetPassword.mockRejectedValue(
      new BadRequestError("RESET_TOKEN_EXPIRED")
    );
    const res = await request(app).post("/v1/auth/reset-password").send({
      resetToken: RESET_TOKEN,
      password: VALID_PASSWORD,
      confirmPassword: VALID_PASSWORD,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the new password equals the current one", async () => {
    pr.resetPassword.mockRejectedValue(
      new BadRequestError("PASSWORD_SAME_AS_CURRENT")
    );
    const res = await request(app).post("/v1/auth/reset-password").send({
      resetToken: RESET_TOKEN,
      password: VALID_PASSWORD,
      confirmPassword: VALID_PASSWORD,
    });
    expect(res.status).toBe(400);
  });

  it.each([
    [
      "mismatched confirmPassword",
      {
        resetToken: RESET_TOKEN,
        password: VALID_PASSWORD,
        confirmPassword: "Different1!",
      },
    ],
    [
      "password missing uppercase",
      {
        resetToken: RESET_TOKEN,
        password: "lowercase1!",
        confirmPassword: "lowercase1!",
      },
    ],
    [
      "password missing digit",
      {
        resetToken: RESET_TOKEN,
        password: "NoDigitsHere!",
        confirmPassword: "NoDigitsHere!",
      },
    ],
    [
      "password missing special char",
      {
        resetToken: RESET_TOKEN,
        password: "NoSpecial123",
        confirmPassword: "NoSpecial123",
      },
    ],
    [
      "password too short",
      { resetToken: RESET_TOKEN, password: "Ab1!", confirmPassword: "Ab1!" },
    ],
    [
      "reset token too short",
      {
        resetToken: "short",
        password: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
      },
    ],
    ["empty body", {}],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app).post("/v1/auth/reset-password").send(body);
    expect(res.status).toBe(400);
    expect(pr.resetPassword).not.toHaveBeenCalled();
  });
});
