import { randomInt } from "node:crypto";

import { logger } from "@aimess/logger";
import bcrypt from "bcryptjs";

import { env } from "../config/env.js";

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
