import { BadRequestError } from "@aimess/errors";

import { AUDIT_ACTIONS } from "../constants/index.js";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { isDisposableEmail } from "../lib/disposable-email.js";
import { AdminOtpPurpose } from "../generated/prisma/client.js";
import {
  generateOtpCode,
  hashOtpCode,
  logDevOtp,
  normalizeEmail,
  verifyOtpCode,
} from "../lib/admin-otp.js";
import {
  assertOtpRequestAllowed,
  assertResendCooldown,
} from "../lib/admin-otp-throttle.js";
import {
  createPasswordResetToken,
  hashPasswordResetToken,
} from "../lib/admin-password-reset-token.js";
import { sendAdminPasswordResetOtpEmailSafe } from "../lib/admin-mailer.js";
import { markAdminSessionsRevoked } from "../lib/admin-session-cache.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import {
  adminOtpRepository,
  adminPasswordResetTokenRepository,
  adminSessionRepository,
  adminUserRepository,
} from "../repositories/index.js";
import type { AdminRequestContext } from "./admin-auth.service.js";
import { auditService } from "./audit.service.js";

export type RequestOtpInput = { email: string };
export type ResendOtpInput = { email: string };
export type VerifyOtpInput = { email: string; code: string };
export type ResetPasswordInput = {
  resetToken: string;
  password: string;
};

export type VerifyOtpResult = {
  resetToken: string;
  resetTokenExpiresIn: number;
};

export const adminPasswordResetService = {
  /**
   * Issue a password-reset OTP for an admin email. Enumeration-safe: the caller
   * never learns whether the email maps to an admin — issuance happens silently
   * only when a valid ACTIVE admin is found.
   */
  async requestOtp(
    ctx: AdminRequestContext,
    input: RequestOtpInput
  ): Promise<void> {
    const email = normalizeEmail(input.email);

    await assertOtpRequestAllowed(email, ctx.ip);

    // A public disposable inbox can be read by anyone, so mailing a reset code
    // to one hands over the account. Refused here as well as at seed time,
    // because an admin's email can be changed after creation.
    //
    // Returns neutrally like every other rejection on this path — telling the
    // caller "that domain is blocked" would confirm the address is otherwise
    // valid, which is the enumeration signal this endpoint exists without.
    if (isDisposableEmail(email)) {
      logger.warn("admin password reset refused: disposable email domain", {
        service: "backoffice-service",
        domain: email.slice(email.lastIndexOf("@") + 1),
      });
      return;
    }

    const admin = await adminUserRepository.findByEmail(email);
    if (!admin || admin.status !== "ACTIVE") {
      // Neutral: do not reveal whether the email maps to an admin.
      return;
    }

    const plainCode = generateOtpCode();
    const codeHash = await hashOtpCode(plainCode);
    const expiresAt = new Date(Date.now() + env.ADMIN_OTP_TTL_SECONDS * 1000); // 60 seconds * 1000 ms/sec = 60000 ms = 1 minute

    await adminOtpRepository.consumeActiveForIdentifier(
      email,
      AdminOtpPurpose.PASSWORD_RESET
    );
    await adminOtpRepository.create({
      adminId: admin.id,
      identifier: email,
      purpose: AdminOtpPurpose.PASSWORD_RESET,
      codeHash,
      expiresAt,
      ip: ctx.ip,
      maxAttempts: env.ADMIN_OTP_MAX_ATTEMPTS,
    });

    logDevOtp(email, plainCode);

    sendAdminPasswordResetOtpEmailSafe(
      email,
      plainCode,
      env.ADMIN_OTP_TTL_SECONDS
    );

    await auditService.record({
      actorId: admin.id,
      action: AUDIT_ACTIONS.ADMIN_PASSWORD_RESET_REQUESTED,
      targetType: "admin",
      targetId: admin.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });
  },

  /** Resend an OTP, enforcing the per-email cooldown before re-issuing. */
  async resendOtp(
    ctx: AdminRequestContext,
    input: ResendOtpInput
  ): Promise<void> {
    const email = normalizeEmail(input.email);
    await assertResendCooldown(email);
    await this.requestOtp(ctx, { email });
  },

  /** Verify an OTP and mint a single-use reset token on success. */
  async verifyOtp(input: VerifyOtpInput): Promise<VerifyOtpResult> {
    const email = normalizeEmail(input.email);

    const otp = await adminOtpRepository.findLatestActive(
      email,
      AdminOtpPurpose.PASSWORD_RESET
    );
    if (!otp) {
      throw new BadRequestError("OTP_INVALID");
    }

    if (otp.attempts >= otp.maxAttempts) {
      throw new BadRequestError("OTP_MAX_ATTEMPTS");
    }

    const codeValid = await verifyOtpCode(input.code, otp.codeHash);
    if (!codeValid) {
      await adminOtpRepository.incrementAttempts(otp.id);
      throw new BadRequestError("OTP_INVALID");
    }

    const admin = await adminUserRepository.findById(otp.adminId);
    if (!admin || admin.status !== "ACTIVE") {
      throw new BadRequestError("OTP_INVALID");
    }

    await adminOtpRepository.markConsumed(otp.id);
    await adminPasswordResetTokenRepository.consumeActiveForAdmin(admin.id);

    const resetToken = createPasswordResetToken();
    const expiresAt = new Date(
      Date.now() + env.ADMIN_PASSWORD_RESET_TOKEN_TTL_SECONDS * 1000
    );

    await adminPasswordResetTokenRepository.create({
      adminId: admin.id,
      tokenHash: hashPasswordResetToken(resetToken),
      expiresAt,
    });

    return {
      resetToken,
      resetTokenExpiresIn: env.ADMIN_PASSWORD_RESET_TOKEN_TTL_SECONDS,
    };
  },

  /**
   * Consume a reset token, set the new password, and force-revoke every active
   * session (revoke the rows + drop them from the active-session cache).
   */
  async resetPassword(
    ctx: AdminRequestContext,
    input: ResetPasswordInput
  ): Promise<void> {
    const tokenHash = hashPasswordResetToken(input.resetToken);
    const record =
      await adminPasswordResetTokenRepository.findValidByTokenHash(tokenHash);

    if (!record || record.consumedAt) {
      throw new BadRequestError("RESET_TOKEN_INVALID");
    }

    if (record.expiresAt <= new Date()) {
      throw new BadRequestError("RESET_TOKEN_EXPIRED");
    }

    const admin = record.admin;
    if (!admin || admin.status !== "ACTIVE") {
      throw new BadRequestError("RESET_TOKEN_INVALID");
    }

    const sameAsCurrent = await verifyPassword(
      input.password,
      admin.passwordHash
    );
    if (sameAsCurrent) {
      throw new BadRequestError("PASSWORD_SAME_AS_CURRENT");
    }

    const passwordHash = await hashPassword(input.password);
    await adminUserRepository.updatePasswordHash(admin.id, passwordHash);
    await adminPasswordResetTokenRepository.markConsumed(record.id);

    // Force-revoke all active sessions: revoke the rows and drop each one from
    // the active-session cache so existing access tokens can no longer pass.
    const active = await adminSessionRepository.listActiveByAdmin(admin.id);
    await adminSessionRepository.revokeAllForAdmin(admin.id);
    await markAdminSessionsRevoked(active.map((r) => r.id));

    await auditService.record({
      actorId: admin.id,
      action: AUDIT_ACTIONS.ADMIN_PASSWORD_RESET_COMPLETED,
      targetType: "admin",
      targetId: admin.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });
  },
};
