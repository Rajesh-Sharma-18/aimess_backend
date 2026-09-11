import type { Request } from "express";

import { BadRequestError, UnauthorizedError } from "@aimess/errors";

import type {
  RequestLinkEmailOtpInput,
  VerifyLinkEmailOtpInput,
} from "../api/validators/email-link.validator.js";
import {
  AccountStatus,
  AuthProvider,
  OtpPurpose,
} from "../generated/prisma/client.js";
import {
  generateOtpCode,
  hashOtpCode,
  logDevOtp,
  normalizeEmail,
  verifyAndConsumeOtp,
} from "../lib/otp.js";
import { assertNotBanned, assertNotDeleted } from "../lib/account-guard.js";
import { assertEmailAvailable } from "../lib/email-availability.js";
import { assertOtpRequestAllowed } from "../lib/otp-rate-limit.js";
import { rethrowAsEmailConflict } from "../lib/email-conflict.js";
import { emitProfileUpdatedSafe } from "../lib/profile-socket.js";
import { buildSessionContext } from "../lib/session-context.js";
import { env } from "../config/env.js";
import { publishLinkEmailOtpSafe } from "../messaging/publish-auth-email-otp.js";
import { authRepository } from "../repositories/auth.repository.js";
import { otpRepository } from "../repositories/otp.repository.js";

export type LinkEmailResult = {
  userId: string;
  emailVerified: boolean;
  primaryAccount: AuthProvider | null;
};

export type RequestLinkEmailOtpResult = {
  messageKey: "AUTH_LINK_EMAIL_OTP_SENT" | "AUTH_EMAIL_ALREADY_ON_ACCOUNT";
};

async function loadActiveUser(userId: string) {
  const user = await authRepository.findByIdForEmailLink(userId);

  if (!user) {
    throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
  }

  assertNotDeleted(user.deletedAt);
  assertNotBanned(user.status);

  if (user.status !== AccountStatus.ACTIVE) {
    throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
  }

  return user;
}

async function sendLinkEmailOtp(
  req: Request,
  userId: string,
  email: string
): Promise<void> {
  const session = buildSessionContext(req);

  await assertOtpRequestAllowed(email, session.ipAddress);

  const plainCode = generateOtpCode();
  const codeHash = await hashOtpCode(plainCode);
  const expiresAt = new Date(Date.now() + env.OTP_TTL_SECONDS * 1000);

  await otpRepository.consumeActiveForIdentifier(
    email,
    OtpPurpose.EMAIL_VERIFY
  );

  await otpRepository.create({
    userId,
    identifier: email,
    purpose: OtpPurpose.EMAIL_VERIFY,
    codeHash,
    expiresAt,
    ipAddress: session.ipAddress,
    maxAttempts: env.OTP_MAX_ATTEMPTS,
  });

  logDevOtp(email, plainCode, "Link email OTP");
  publishLinkEmailOtpSafe({
    email,
    code: plainCode,
    ttlSeconds: env.OTP_TTL_SECONDS,
    requestedAt: new Date().toISOString(),
  });
}

export const emailLinkService = {
  async requestOtp(
    req: Request,
    userId: string,
    input: RequestLinkEmailOtpInput
  ): Promise<RequestLinkEmailOtpResult> {
    const email = normalizeEmail(input.email);
    const user = await loadActiveUser(userId);

    const alreadyOnAccount = user.email === email;

    if (alreadyOnAccount && user.emailVerified) {
      throw new BadRequestError("AUTH_EMAIL_ALREADY_LINKED");
    }

    // Runs on the resend path too: the row excludes this user, but an admin
    // account may have claimed the address since it was first written here.
    await assertEmailAvailable(email, userId);

    await sendLinkEmailOtp(req, userId, email);

    return {
      messageKey: alreadyOnAccount
        ? "AUTH_EMAIL_ALREADY_ON_ACCOUNT"
        : "AUTH_LINK_EMAIL_OTP_SENT",
    };
  },

  async verifyAndLink(
    userId: string,
    input: VerifyLinkEmailOtpInput
  ): Promise<LinkEmailResult> {
    const email = normalizeEmail(input.email);
    await loadActiveUser(userId);

    await assertEmailAvailable(email, userId);

    await verifyAndConsumeOtp({
      identifier: email,
      purpose: OtpPurpose.EMAIL_VERIFY,
      userId,
      code: input.code,
    });

    // Atomic: links email + sets primaryAccount in one transaction so that a
    // concurrent getAccountSummary gRPC call from user-service can never read
    // a half-written state (email present but primaryAccount still null).
    const result = await authRepository
      .linkVerifiedEmailAndSetPrimary(userId, email, AuthProvider.EMAIL)
      .catch(rethrowAsEmailConflict);

    // The verifying device already has the new state in its HTTP response; this
    // tells the user's OTHER sessions to re-fetch their profile.
    emitProfileUpdatedSafe(userId);

    return {
      userId: result.id,
      emailVerified: result.emailVerified,
      primaryAccount: result.primaryAccount,
    };
  },
};
