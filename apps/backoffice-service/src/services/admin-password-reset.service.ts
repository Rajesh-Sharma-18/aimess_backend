import { BadRequestError } from "@aimess/errors";

import { AUDIT_ACTIONS } from "../constants/index.js";
import { env } from "../config/env.js";
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
import { blacklistJti } from "../lib/jti-blacklist.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { publishAdminPasswordResetOtpSafe } from "../messaging/publish-admin-password-reset-otp.js";
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

    const admin = await adminUserRepository.findByEmail(email);
    if (!admin || admin.status !== "ACTIVE") {
      // Neutral: do not reveal whether the email maps to an admin.
      return;
    }

    const plainCode = generateOtpCode();
    const codeHash = await hashOtpCode(plainCode);
    const expiresAt = new Date(Date.now() + env.ADMIN_OTP_TTL_SECONDS * 1000);

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

    publishAdminPasswordResetOtpSafe({
      email,
      code: plainCode,
      ttlSeconds: env.ADMIN_OTP_TTL_SECONDS,
      requestedAt: new Date().toISOString(),
    });

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
   * session (blacklist each jti for its remaining TTL, then revoke the rows).
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

    // Force-revoke all active sessions: blacklist each jti for its remaining
    // TTL so the access token can no longer pass, then revoke the rows.
    const active = await adminSessionRepository.listActiveByAdmin(admin.id);
    for (const row of active) {
      const ttl = Math.max(
        1,
        Math.ceil((row.expiresAt.getTime() - Date.now()) / 1000)
      );
      await blacklistJti(row.jti, ttl);
    }
    await adminSessionRepository.revokeAllForAdmin(admin.id);

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
