import type { Request } from "express";

import {
  BadRequestError,
  ConflictError,
  UnauthorizedError,
} from "@aimess/errors";

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
import { assertOtpRequestAllowed } from "../lib/otp-rate-limit.js";
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

  if (!user || user.deletedAt) {
    throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
  }

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

    if (user.email === email) {
      if (user.emailVerified) {
        throw new BadRequestError("AUTH_EMAIL_ALREADY_LINKED");
      }

      await sendLinkEmailOtp(req, userId, email);

      return { messageKey: "AUTH_EMAIL_ALREADY_ON_ACCOUNT" };
    }

    const taken = await authRepository.findEmailTakenByOtherUser(email, userId);
    if (taken) {
      throw new ConflictError("AUTH_EMAIL_EXISTS");
    }

    await sendLinkEmailOtp(req, userId, email);

    return { messageKey: "AUTH_LINK_EMAIL_OTP_SENT" };
  },

  async verifyAndLink(
    userId: string,
    input: VerifyLinkEmailOtpInput
  ): Promise<LinkEmailResult> {
    const email = normalizeEmail(input.email);
    await loadActiveUser(userId);

    const taken = await authRepository.findEmailTakenByOtherUser(email, userId);
    if (taken) {
      throw new ConflictError("AUTH_EMAIL_EXISTS");
    }

    await verifyAndConsumeOtp({
      identifier: email,
      purpose: OtpPurpose.EMAIL_VERIFY,
      userId,
      code: input.code,
    });

    // Atomic: links email + sets primaryAccount in one transaction so that a
    // concurrent getAccountSummary gRPC call from user-service can never read
    // a half-written state (email present but primaryAccount still null).
    const result = await authRepository.linkVerifiedEmailAndSetPrimary(
      userId,
      email,
      AuthProvider.EMAIL
    );

    return {
      userId: result.id,
      emailVerified: result.emailVerified,
      primaryAccount: result.primaryAccount,
    };
  },
};
