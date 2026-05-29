import { BadRequestError, UnauthorizedError } from "@aimess/errors";
import bcrypt from "bcryptjs";

import { loadActiveAuthUser } from "../lib/account-guard.js";
import { markSessionsRevoked } from "../lib/session-active-cache.js";
import { publishUserDeletedSafe } from "../messaging/publish-user-deleted.js";
import { authRepository } from "../repositories/auth.repository.js";

export type DeleteAccountResult = {
  deletedAt: string;
};

export const accountDeletionService = {
  /**
   * Soft-deletes the authenticated user's account. If the account has a
   * password it MUST be confirmed against `auth_users.passwordHash`;
   * social-only accounts (no passwordHash) can be deleted without one. The row
   * is retained (deletedAt + status PENDING_DELETION + a 30-day
   * scheduledDeletionAt) so the grace-period job can hard-purge it later.
   * Meanwhile every login path — password login AND any linked Google/Apple
   * provider — is blocked by the deletedAt/status guards in auth.service &
   * social-auth.service.
   */
  async deleteAccount(
    userId: string,
    password?: string
  ): Promise<DeleteAccountResult> {
    // Throws AUTH_ACCOUNT_NOT_ACTIVE if already deleted / not active.
    const user = await loadActiveAuthUser(userId);

    // Password confirmation is mandatory only for accounts that have one.
    if (user.passwordHash) {
      if (!password) {
        throw new BadRequestError("AUTH_PASSWORD_REQUIRED");
      }

      const passwordValid = await bcrypt.compare(password, user.passwordHash);
      if (!passwordValid) {
        throw new UnauthorizedError("AUTH_PASSWORD_INCORRECT");
      }
    }

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
