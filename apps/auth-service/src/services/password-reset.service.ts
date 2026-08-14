import type { Request } from "express";

import { BadRequestError, NotFoundError } from "@aimess/errors";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";
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
import { assertOtpRequestAllowed } from "../lib/otp-rate-limit.js";
import {
  createPasswordResetToken,
  hashPasswordResetToken,
} from "../lib/password-reset-token.js";
import { revokeSessionsForPasswordChange } from "../lib/revoke-password-sessions.js";
import { buildSessionContext } from "../lib/session-context.js";
import { env } from "../config/env.js";
import { publishPasswordResetOtpSafe } from "../messaging/publish-password-reset-otp.js";
import { authRepository } from "../repositories/auth.repository.js";
import { otpRepository } from "../repositories/otp.repository.js";
import { passwordResetRepository } from "../repositories/password-reset.repository.js";
import type { VerifyPasswordResetOtpResult } from "../types/password-reset.types.js";

function canResetPassword(user: {
  passwordHash: string | null;
  status: AccountStatus;
  deletedAt: Date | null;
  linkedAccounts: { id: string }[];
}): boolean {
  const isSocialUser = user.linkedAccounts.length > 0;
  return (
    (isSocialUser || Boolean(user.passwordHash)) &&
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
    const session = buildSessionContext(req);

    await assertOtpRequestAllowed(email, session.ipAddress);

    const user = await authRepository.findByEmailForPasswordReset(email);

    if (!user || !canResetPassword(user)) {
      throw new NotFoundError("AUTH_PASSWORD_RESET_EMAIL_NOT_FOUND");
    }

    const plainCode = generateOtpCode();
    const codeHash = await hashOtpCode(plainCode);
    const expiresAt = new Date(Date.now() + env.OTP_TTL_SECONDS * 1000);

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

    publishPasswordResetOtpSafe({
      email,
      code: plainCode,
      ttlSeconds: env.OTP_TTL_SECONDS,
      requestedAt: new Date().toISOString(),
    });

    // Recorded only past the existence + eligibility checks above, so the row
    // always means "a reset was really started for this account". The OTP itself
    // never leaves this function.
    publishAdminActivitySafe({
      actorId: user.id,
      action: USER_AUDIT_ACTIONS.USER_PASSWORD_RESET_REQUESTED,
      targetType: "user",
      targetId: user.id,
    });
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
      throw new BadRequestError("AUTH_OTP_INVALID");
    }

    if (otp.attempts >= otp.maxAttempts) {
      throw new BadRequestError("AUTH_OTP_MAX_ATTEMPTS");
    }

    const codeValid = await verifyOtpCode(input.code, otp.codeHash);
    if (!codeValid) {
      await otpRepository.incrementAttempts(otp.id);
      throw new BadRequestError("AUTH_OTP_INVALID");
    }

    const user = await authRepository.findByEmailForPasswordReset(email);
    if (!user || !canResetPassword(user)) {
      throw new BadRequestError("AUTH_OTP_INVALID");
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
      throw new BadRequestError("AUTH_RESET_TOKEN_INVALID");
    }

    if (record.expiresAt <= new Date()) {
      throw new BadRequestError("AUTH_RESET_TOKEN_EXPIRED");
    }

    const account = await authRepository.findPasswordHashByUserId(
      record.userId
    );

    // const isSocialUser = user.linkedAccounts.length > 0;

    if (
      !account ||
      account.deletedAt ||
      account.status !== AccountStatus.ACTIVE
    ) {
      throw new BadRequestError("AUTH_RESET_TOKEN_INVALID");
    }

    let sameAsCurrent = null;

    if (!account.linkedAccounts?.length && account.passwordHash) {
      sameAsCurrent = await bcrypt.compare(
        input.password,
        account.passwordHash
      );
    }

    if (sameAsCurrent) {
      throw new BadRequestError("AUTH_PASSWORD_SAME_AS_CURRENT");
    }

    const passwordHash = await bcrypt.hash(input.password, 12);

    await authRepository.updatePasswordHash(record.userId, passwordHash);
    await passwordResetRepository.markConsumed(record.id);

    // Every session dies — no session is trusted after a reset, so no
    // exceptSessionId. This also drops every device's push token and kicks
    // their live sockets; before, a reset revoked the sessions but left the
    // tokens registered, so the attacker's device kept receiving push.
    const revokedSessions = await revokeSessionsForPasswordChange(
      record.userId
    );

    publishAdminActivitySafe({
      actorId: record.userId,
      action: USER_AUDIT_ACTIONS.USER_PASSWORD_RESET_COMPLETED,
      targetType: "user",
      targetId: record.userId,
      after: { revokedSessions },
    });
  },
};
