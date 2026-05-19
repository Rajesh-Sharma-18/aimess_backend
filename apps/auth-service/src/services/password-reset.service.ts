import type { Request } from "express";

import { BadRequestError, UnauthorizedError } from "@aimess/errors";
import bcrypt from "bcryptjs";

import type {
  RequestPasswordResetOtpInput,
  ResetPasswordInput,
  VerifyPasswordResetOtpInput,
} from "../api/validators/password-reset.validator.js";
import { AccountStatus, OtpPurpose } from "../generated/prisma/client.js";
import {
  generateOtpCode,
  hashOtpCode,
  logDevOtp,
  normalizeEmail,
  verifyOtpCode,
} from "../lib/otp.js";
import {
  createPasswordResetToken,
  hashPasswordResetToken,
} from "../lib/password-reset-token.js";
import { markSessionsRevoked } from "../lib/session-active-cache.js";
import { buildSessionContext } from "../lib/session-context.js";
import { env } from "../config/env.js";
import { authRepository } from "../repositories/auth.repository.js";
import { otpRepository } from "../repositories/otp.repository.js";
import { passwordResetRepository } from "../repositories/password-reset.repository.js";
import { sessionRepository } from "../repositories/session.repository.js";
import type { VerifyPasswordResetOtpResult } from "../types/password-reset.types.js";

function canResetPassword(user: {
  passwordHash: string | null;
  status: AccountStatus;
  deletedAt: Date | null;
}): boolean {
  return (
    Boolean(user.passwordHash) &&
    !user.deletedAt &&
    user.status === AccountStatus.ACTIVE
  );
}

export const passwordResetService = {
  async requestOtp(
    req: Request,
    input: RequestPasswordResetOtpInput
  ): Promise<void> {
    const email = normalizeEmail(input.email);
    const user = await authRepository.findByEmailForPasswordReset(email);

    if (!user || !canResetPassword(user)) {
      return;
    }

    const plainCode = generateOtpCode();
    const codeHash = await hashOtpCode(plainCode);
    const expiresAt = new Date(Date.now() + env.OTP_TTL_SECONDS * 1000);
    const session = buildSessionContext(req);

    await otpRepository.consumeActiveForIdentifier(
      email,
      OtpPurpose.PASSWORD_RESET
    );

    await otpRepository.create({
      userId: user.id,
      identifier: email,
      purpose: OtpPurpose.PASSWORD_RESET,
      codeHash,
      expiresAt,
      ipAddress: session.ipAddress,
      maxAttempts: env.OTP_MAX_ATTEMPTS,
    });

    logDevOtp(email, plainCode);
  },

  async verifyOtp(
    input: VerifyPasswordResetOtpInput
  ): Promise<VerifyPasswordResetOtpResult> {
    const email = normalizeEmail(input.email);
    const otp = await otpRepository.findLatestActive(
      email,
      OtpPurpose.PASSWORD_RESET
    );

    if (!otp) {
      throw new UnauthorizedError("AUTH_OTP_INVALID");
    }

    if (otp.attempts >= otp.maxAttempts) {
      throw new BadRequestError("AUTH_OTP_MAX_ATTEMPTS");
    }

    const codeValid = await verifyOtpCode(input.code, otp.codeHash);
    if (!codeValid) {
      await otpRepository.incrementAttempts(otp.id);
      throw new UnauthorizedError("AUTH_OTP_INVALID");
    }

    const user = await authRepository.findByEmailForPasswordReset(email);
    if (!user || !canResetPassword(user)) {
      throw new UnauthorizedError("AUTH_OTP_INVALID");
    }

    await otpRepository.markConsumed(otp.id);
    await passwordResetRepository.consumeActiveForUser(user.id);

    const resetToken = createPasswordResetToken();
    const expiresAt = new Date(
      Date.now() + env.PASSWORD_RESET_TOKEN_TTL_SECONDS * 1000
    );

    await passwordResetRepository.create({
      userId: user.id,
      tokenHash: hashPasswordResetToken(resetToken),
      expiresAt,
    });

    return {
      resetToken,
      resetTokenExpiresIn: env.PASSWORD_RESET_TOKEN_TTL_SECONDS,
    };
  },

  async resetPassword(input: ResetPasswordInput): Promise<void> {
    const tokenHash = hashPasswordResetToken(input.resetToken);
    const record =
      await passwordResetRepository.findValidByTokenHash(tokenHash);

    if (!record || record.consumedAt) {
      throw new UnauthorizedError("AUTH_RESET_TOKEN_INVALID");
    }

    if (record.expiresAt <= new Date()) {
      throw new UnauthorizedError("AUTH_RESET_TOKEN_EXPIRED");
    }

    const account = await authRepository.findPasswordHashByUserId(
      record.userId
    );

    if (
      !account ||
      account.deletedAt ||
      account.status !== AccountStatus.ACTIVE ||
      !account.passwordHash
    ) {
      throw new UnauthorizedError("AUTH_RESET_TOKEN_INVALID");
    }

    const sameAsCurrent = await bcrypt.compare(
      input.password,
      account.passwordHash
    );
    if (sameAsCurrent) {
      throw new BadRequestError("AUTH_PASSWORD_SAME_AS_CURRENT");
    }

    const passwordHash = await bcrypt.hash(input.password, 12);

    await authRepository.updatePasswordHash(record.userId, passwordHash);
    await passwordResetRepository.markConsumed(record.id);

    const active = await sessionRepository.listActiveSessionIds(record.userId);
    await authRepository.revokeSessionsAfterPasswordChange(record.userId);
    await markSessionsRevoked(active.map((row) => row.id));
  },
};
