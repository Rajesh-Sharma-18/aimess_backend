import { randomInt } from "node:crypto";

import { BadRequestError, UnauthorizedError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import bcrypt from "bcryptjs";

import { env } from "../config/env.js";
import type { OtpPurpose } from "../generated/prisma/client.js";
import { otpRepository } from "../repositories/otp.repository.js";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function generateOtpCode(): string {
  if (env.NODE_ENV === "development" && env.OTP_DEV_FIXED_CODE) {
    return env.OTP_DEV_FIXED_CODE;
  }

  const max = 10 ** env.OTP_LENGTH;
  return String(randomInt(0, max)).padStart(env.OTP_LENGTH, "0");
}

export async function hashOtpCode(code: string): Promise<string> {
  return bcrypt.hash(code, 10);
}

export async function verifyOtpCode(
  code: string,
  codeHash: string
): Promise<boolean> {
  return bcrypt.compare(code, codeHash);
}

/** Logs OTP in development until email delivery is wired up. */
export function logDevOtp(email: string, code: string, context = "OTP"): void {
  if (env.NODE_ENV !== "development") {
    return;
  }

  logger.info(
    `[dev] ${context} for ${email}: ${code} (use OTP_DEV_FIXED_CODE=${code} in .env)`
  );
}

/**
 * Verifies an OTP belonging to a known user and consumes it on success.
 *
 * Reproduces the shared verify-and-consume sequence used by the
 * account-deletion and email-link flows: find the latest active OTP for the
 * identifier/purpose, confirm it belongs to `userId`, enforce the attempt
 * limit, verify the code (incrementing attempts on failure), then mark it
 * consumed. Error keys are parameterized so each caller keeps its exact keys.
 */
export async function verifyAndConsumeOtp(params: {
  identifier: string;
  purpose: OtpPurpose;
  userId: string;
  code: string;
  invalidErrorKey?: string;
  maxAttemptsErrorKey?: string;
}): Promise<void> {
  const {
    identifier,
    purpose,
    userId,
    code,
    invalidErrorKey = "AUTH_OTP_INVALID",
    maxAttemptsErrorKey = "AUTH_OTP_MAX_ATTEMPTS",
  } = params;

  const otp = await otpRepository.findLatestActive(identifier, purpose);

  if (!otp || otp.userId !== userId) {
    throw new UnauthorizedError(invalidErrorKey);
  }

  if (otp.attempts >= otp.maxAttempts) {
    throw new BadRequestError(maxAttemptsErrorKey);
  }

  const codeValid = await verifyOtpCode(code, otp.codeHash);
  if (!codeValid) {
    await otpRepository.incrementAttempts(otp.id);
    throw new UnauthorizedError(invalidErrorKey);
  }

  await otpRepository.markConsumed(otp.id);
}
