import { BadRequestError } from "@aimess/errors";
import { publishSessionRevokedEvent } from "@aimess/redis";
import bcrypt from "bcryptjs";

import { redis } from "../config/redis.js";
import { loadActiveAuthUser } from "../lib/account-guard.js";
import { markSessionsRevoked } from "../lib/session-active-cache.js";
import { publishAllSessionsRevokedSafe } from "../messaging/publish-session-revoked.js";
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
   * SOFT-deletes the authenticated user's account — and only ever soft. If the
   * account has a password it MUST be confirmed against
   * `auth_users.passwordHash`; social-only accounts (no passwordHash) can be
   * deleted without one.
   *
   * Nothing in this flow removes a row anywhere: the AuthUser is marked
   * (deletedAt + status PENDING_DELETION + a 30-day scheduledDeletionAt), its
   * sessions/refresh tokens are revoked in place, linked Google/Apple rows are
   * kept, and user-service soft-deletes the profile the same way. Every login
   * path — password login AND any linked provider — is blocked by the
   * deletedAt/status guards in auth.service & social-auth.service.
   *
   * The one exception is push device tokens, which ARE removed
   * (`publishAllSessionsRevokedSafe` below). Those are delivery credentials,
   * not user data — the same thing "sign out from all devices" does — and
   * removing them is what keeps a deleted account from receiving pushes.
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
        // 400, NOT 401 — and this is load-bearing, not a style choice. The
        // caller's SESSION is perfectly valid here; only the re-authentication
        // they typed into the confirmation dialog was wrong. A 401 tells every
        // standard client "your access token died", so their interceptor
        // refreshes the token, silently REPLAYS this same delete request with
        // the same wrong password, gets a second 401, and signs the user out —
        // the user typed one wrong character and got logged out instead of an
        // error message (and burned two rate-limit slots doing it).
        // change-password.service.ts already returns BadRequestError for the
        // same "wrong current password" case; this endpoint was the outlier.
        throw new BadRequestError("AUTH_PASSWORD_INCORRECT");
      }
    }

    const { deletedAt, revokedSessionIds } =
      await authRepository.softDeleteUser(userId);

    await markSessionsRevoked(revokedSessionIds);

    // Drop every FCM/APNs device token for this user. Deletion must produce no
    // push on any of their devices — and without this the tokens outlive the
    // account, so any notification still in flight (a chat message, a friend
    // event) would land on a phone whose account is gone. Same signal "sign out
    // from all devices" uses (notifications-service session.consumer.ts).
    publishAllSessionsRevokedSafe({ userId });

    // Kick every still-connected device NOW instead of waiting for its access
    // token to expire — same per-session signal "Logout Device"/"Sign out from
    // all other devices" already use (api-gateway session-revoke.ts). Includes
    // the caller's own session: the account is gone, so every socket must drop.
    //
    // Deletion is specified to be SILENT: no notification of any kind, for the
    // deleting user or anyone else. The "account_deleted" reason force-
    // disconnects exactly like a normal revoke but suppresses both the
    // client-facing `auth:session_terminated` notice and the
    // `session:list_updated` list churn, so no device shows a "your session was
    // terminated" card on the way out. Nothing here writes a notification row
    // or enqueues a push — do not add one.
    for (const sessionId of revokedSessionIds) {
      void publishSessionRevokedEvent(
        redis,
        userId,
        sessionId,
        "account_deleted"
      ).catch(() => undefined);
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
