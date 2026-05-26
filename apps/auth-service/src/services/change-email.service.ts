import type { Request } from "express";

import {
  BadRequestError,
  ConflictError,
  UnauthorizedError,
} from "@aimess/errors";

import type {
  RequestChangeEmailInput,
  VerifyChangeEmailInput,
} from "../api/validators/change-email.validator.js";
import { OtpPurpose } from "../generated/prisma/client.js";
import { loadActiveAuthUser } from "../lib/account-guard.js";
import { normalizeEmail, verifyOtpCode } from "../lib/otp.js";
import { sendEmailOtp } from "../lib/send-email-otp.js";
import { env } from "../config/env.js";
import { publishChangeEmailOtpSafe } from "../messaging/publish-auth-email-otp.js";
import { authRepository } from "../repositories/auth.repository.js";
import { otpRepository } from "../repositories/otp.repository.js";

export type ChangeEmailResult = {
  userId: string;
  emailVerified: boolean;
};

export const changeEmailService = {
  async requestOtp(
    req: Request,
    userId: string,
    input: RequestChangeEmailInput
  ): Promise<void> {
    const oldEmail = normalizeEmail(input.oldEmail);
    const newEmail = normalizeEmail(input.newEmail);
    const user = await loadActiveAuthUser(userId);

    if (!user.email) {
      throw new BadRequestError("AUTH_EMAIL_NOT_SET");
    }

    if (user.email !== oldEmail) {
      throw new BadRequestError("AUTH_OLD_EMAIL_MISMATCH");
    }

    if (oldEmail === newEmail) {
      throw new BadRequestError("AUTH_NEW_EMAIL_SAME_AS_OLD");
    }

    const taken = await authRepository.findEmailTakenByOtherUser(
      newEmail,
      userId
    );
    if (taken) {
      throw new ConflictError("AUTH_EMAIL_EXISTS");
    }

    const { code } = await sendEmailOtp(req, {
      userId,
      identifier: newEmail,
      purpose: OtpPurpose.EMAIL_CHANGE,
      logContext: "Change email OTP",
    });
    publishChangeEmailOtpSafe({
      email: newEmail,
      code,
      ttlSeconds: env.OTP_TTL_SECONDS,
      requestedAt: new Date().toISOString(),
    });
  },

  async verifyAndChange(
    userId: string,
    input: VerifyChangeEmailInput
  ): Promise<ChangeEmailResult> {
    const oldEmail = normalizeEmail(input.oldEmail);
    const newEmail = normalizeEmail(input.newEmail);
    const user = await loadActiveAuthUser(userId);

    if (!user.email) {
      throw new BadRequestError("AUTH_EMAIL_NOT_SET");
    }

    if (user.email !== oldEmail) {
      throw new BadRequestError("AUTH_OLD_EMAIL_MISMATCH");
    }

    if (oldEmail === newEmail) {
      throw new BadRequestError("AUTH_NEW_EMAIL_SAME_AS_OLD");
    }

    const taken = await authRepository.findEmailTakenByOtherUser(
      newEmail,
      userId
    );
    if (taken) {
      throw new ConflictError("AUTH_EMAIL_EXISTS");
    }

    const otp = await otpRepository.findLatestActive(
      newEmail,
      OtpPurpose.EMAIL_CHANGE
    );

    if (!otp || otp.userId !== userId) {
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

    await otpRepository.markConsumed(otp.id);

    const updated = await authRepository.updateVerifiedEmail(userId, newEmail);

    return {
      userId: updated.id,
      emailVerified: updated.emailVerified,
    };
  },
};
