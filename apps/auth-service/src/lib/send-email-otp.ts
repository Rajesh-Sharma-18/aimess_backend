import type { Request } from "express";

import type { OtpPurpose } from "../generated/prisma/client.js";
import { generateOtpCode, hashOtpCode, logDevOtp } from "./otp.js";
import { buildSessionContext } from "./session-context.js";
import { env } from "../config/env.js";
import { otpRepository } from "../repositories/otp.repository.js";

export async function sendEmailOtp(
  req: Request,
  params: {
    userId: string;
    identifier: string;
    purpose: OtpPurpose;
    logContext: string;
  }
): Promise<void> {
  const plainCode = generateOtpCode();
  const codeHash = await hashOtpCode(plainCode);
  const expiresAt = new Date(Date.now() + env.OTP_TTL_SECONDS * 1000);
  const session = buildSessionContext(req);

  await otpRepository.consumeActiveForIdentifier(
    params.identifier,
    params.purpose
  );

  await otpRepository.create({
    userId: params.userId,
    identifier: params.identifier,
    purpose: params.purpose,
    codeHash,
    expiresAt,
    ipAddress: session.ipAddress,
    maxAttempts: env.OTP_MAX_ATTEMPTS,
  });

  logDevOtp(params.identifier, plainCode, params.logContext);
}
