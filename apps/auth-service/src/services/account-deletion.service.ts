import type { Request } from "express";

import bcrypt from "bcryptjs";

import { BadRequestError, UnauthorizedError } from "@aimess/errors";

import type { DeleteAccountInput } from "../api/validators/account-deletion.validator.js";
import { OtpPurpose } from "../generated/prisma/client.js";
import { loadActiveAuthUser } from "../lib/account-guard.js";
import type { ActiveAuthUser } from "../lib/account-guard.js";
import { verifyAndConsumeOtp } from "../lib/otp.js";
import { sendEmailOtp } from "../lib/send-email-otp.js";
import { markSessionsRevoked } from "../lib/session-active-cache.js";
import { publishUserDeletedSafe } from "../messaging/publish-user-deleted.js";
import { authRepository } from "../repositories/auth.repository.js";

export type DeleteAccountResult = {
  deletedAt: string;
};

/**
 * Confirm the caller's identity before deletion. Password accounts re-enter
 * their current password; passwordless accounts confirm via an emailed OTP.
 */
async function confirmDeletion(
  user: ActiveAuthUser,
  input: DeleteAccountInput
): Promise<void> {
  if (user.passwordHash) {
    if (!input.currentPassword) {
      throw new BadRequestError("AUTH_DELETE_CONFIRMATION_REQUIRED");
    }

    const valid = await bcrypt.compare(
      input.currentPassword,
      user.passwordHash
    );
    if (!valid) {
      throw new UnauthorizedError("AUTH_CURRENT_PASSWORD_INVALID");
    }

    return;
  }

  if (!input.otp || !user.email) {
    throw new BadRequestError("AUTH_DELETE_CONFIRMATION_REQUIRED");
  }

  await verifyAndConsumeOtp({
    identifier: user.email,
    purpose: OtpPurpose.ACCOUNT_DELETION_CONFIRM,
    userId: user.id,
    code: input.otp,
  });
}

export const accountDeletionService = {
  async requestDeletionOtp(req: Request, userId: string): Promise<void> {
    const user = await loadActiveAuthUser(userId);

    if (!user.email) {
      throw new BadRequestError("AUTH_EMAIL_NOT_SET");
    }

    await sendEmailOtp(req, {
      userId,
      identifier: user.email,
      purpose: OtpPurpose.ACCOUNT_DELETION_CONFIRM,
      logContext: "Account deletion OTP",
    });
  },

  async deleteAccount(
    _req: Request,
    userId: string,
    input: DeleteAccountInput
  ): Promise<DeleteAccountResult> {
    const user = await loadActiveAuthUser(userId);

    await confirmDeletion(user, input);

    const { deletedAt, revokedSessionIds } =
      await authRepository.softDeleteUser(userId);

    await markSessionsRevoked(revokedSessionIds);

    publishUserDeletedSafe({
      userId,
      deletedAt: deletedAt.toISOString(),
    });

    return { deletedAt: deletedAt.toISOString() };
  },
};
