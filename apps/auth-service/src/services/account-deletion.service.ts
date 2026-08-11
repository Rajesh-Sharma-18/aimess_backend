import { BadRequestError, UnauthorizedError } from "@aimess/errors";
import { publishSessionRevokedEvent } from "@aimess/redis";
import bcrypt from "bcryptjs";

import { redis } from "../config/redis.js";
import { loadActiveAuthUser } from "../lib/account-guard.js";
import { markSessionsRevoked } from "../lib/session-active-cache.js";
import { publishUserDeletedSafe } from "../messaging/publish-user-deleted.js";
import { authRepository } from "../repositories/auth.repository.js";
import { recordAuditEventSafe } from "./audit.service.js";

export type DeleteAccountResult = {
  deletedAt: string;
};

export type DeleteAccountContext = {
  ip?: string | null;
  userAgent?: string | null;
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
    password?: string,
    context: DeleteAccountContext = {}
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

    // Kick every still-connected device NOW instead of waiting for its access
    // token to expire — same per-session signal "Logout Device"/"Sign out from
    // all other devices" already use (api-gateway session-revoke.ts). Includes
    // the caller's own session: the account is gone, so every socket must drop.
    for (const sessionId of revokedSessionIds) {
      void publishSessionRevokedEvent(redis, userId, sessionId).catch(
        () => undefined
      );
    }

    recordAuditEventSafe({
      event: "ACCOUNT_DELETED",
      targetType: "auth_user",
      targetId: userId,
      userId,
      metadata: { revokedSessionCount: revokedSessionIds.length },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });

    publishUserDeletedSafe({
      userId,
      deletedAt: deletedAt.toISOString(),
    });

    return { deletedAt: deletedAt.toISOString() };
  },
};
