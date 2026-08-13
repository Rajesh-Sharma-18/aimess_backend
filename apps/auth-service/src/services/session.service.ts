import { signAccessToken } from "@aimess/auth-jwt";
import { NotFoundError, UnauthorizedError } from "@aimess/errors";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";
import { publishSessionRevokedEvent } from "@aimess/redis";

import {
  AccountStatus,
  SessionRevokeReason,
} from "../generated/prisma/client.js";
import {
  createRefreshTokenValue,
  hashToken,
  type AuthTokens,
} from "../lib/token.js";
import {
  markSessionActive,
  markSessionRevoked,
  markSessionsRevoked,
} from "../lib/session-active-cache.js";
import { toActiveSessionItem } from "../lib/session-serializer.js";
import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { refreshTokenRepository } from "../repositories/refresh-token.repository.js";
import { sessionRepository } from "../repositories/session.repository.js";
import {
  publishSessionDeviceRevokedSafe,
  publishAllSessionsRevokedSafe,
} from "../messaging/publish-session-revoked.js";
import { recordAuditEventSafe } from "./audit.service.js";
import { recordSessionActionSafe } from "../grpc/notification.client.js";
import type {
  AccessTokenResponse,
  AuthTokensResponse,
} from "../types/auth.types.js";
import type {
  ActiveSessionItem,
  ListSessionsResult,
  RevokeSessionsResult,
} from "../types/session.types.js";

function parseExpiresInSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid JWT expiry value: ${value}`);
  }
  return Math.floor(seconds);
}

// Refresh-token reuse trips the tripwire and pulls EVERY session for the account. The
// platform did that, not the user, so it is recorded as SYSTEM against the user.
function auditTokenReuseRevoke(userId: string, revokedSessions: number): void {
  publishAdminActivitySafe({
    actorId: null,
    actorType: "SYSTEM",
    action: USER_AUDIT_ACTIONS.USER_SESSION_REVOKED,
    targetType: "user",
    targetId: userId,
    after: { reason: "TOKEN_REUSE_DETECTED", revokedSessions, userId },
  });
}

function toAuthTokensResponse(tokens: AuthTokens): AuthTokensResponse {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresIn: tokens.accessTokenExpiresIn,
    refreshTokenExpiresIn: tokens.refreshTokenExpiresIn,
  };
}

export const sessionService = {
  async refresh(refreshToken: string): Promise<AuthTokensResponse> {
    const tokenHash = hashToken(refreshToken);
    const stored = await refreshTokenRepository.findByTokenHash(tokenHash);

    if (!stored) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_INVALID");
    }

    if (stored.rotatedToId) {
      const active = await sessionRepository.listActiveSessionIds(
        stored.userId
      );
      await sessionRepository.revokeAllForUser(
        stored.userId,
        SessionRevokeReason.TOKEN_REUSE_DETECTED
      );
      await markSessionsRevoked(active.map((row) => row.id));
      // Every session is gone; leaving the push tokens behind would keep
      // delivering notifications to devices that can no longer sign in.
      publishAllSessionsRevokedSafe({ userId: stored.userId });
      auditTokenReuseRevoke(stored.userId, active.length);
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_INVALID");
    }

    const now = new Date();

    if (stored.revokedAt) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_INVALID");
    }

    if (stored.expiresAt <= now) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_EXPIRED");
    }

    if (stored.session.revokedAt) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_INVALID");
    }

    if (stored.user.deletedAt || stored.user.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
    }

    const accessTokenExpiresIn = parseExpiresInSeconds(
      env.JWT_ACCESS_EXPIRES_IN
    );
    const refreshTokenExpiresIn = parseExpiresInSeconds(
      env.JWT_REFRESH_EXPIRES_IN
    );

    const newRefreshToken = createRefreshTokenValue();
    const newRefreshExpiresAt = new Date(
      Date.now() + refreshTokenExpiresIn * 1000
    );

    await refreshTokenRepository.rotate({
      oldTokenId: stored.id,
      userId: stored.userId,
      sessionId: stored.sessionId,
      newTokenHash: hashToken(newRefreshToken),
      newExpiresAt: newRefreshExpiresAt,
    });

    const accessToken = signAccessToken({
      userId: stored.userId,
      sessionId: stored.sessionId,
      secret: env.JWT_ACCESS_SECRET,
      expiresInSeconds: accessTokenExpiresIn,
      role: stored.user.role === "ADMIN" ? "ADMIN" : "USER",
    });

    await markSessionActive(stored.sessionId);

    return toAuthTokensResponse({
      accessToken,
      refreshToken: newRefreshToken,
      accessTokenExpiresIn,
      refreshTokenExpiresIn,
    });
  },

  async issueAccessToken(refreshToken: string): Promise<AccessTokenResponse> {
    const tokenHash = hashToken(refreshToken);
    const stored = await refreshTokenRepository.findByTokenHash(tokenHash);

    if (!stored) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_INVALID");
    }

    if (stored.rotatedToId) {
      const active = await sessionRepository.listActiveSessionIds(
        stored.userId
      );
      await sessionRepository.revokeAllForUser(
        stored.userId,
        SessionRevokeReason.TOKEN_REUSE_DETECTED
      );
      await markSessionsRevoked(active.map((row) => row.id));
      // Same as refresh(): all sessions revoked → all push tokens go with them.
      publishAllSessionsRevokedSafe({ userId: stored.userId });
      auditTokenReuseRevoke(stored.userId, active.length);
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_INVALID");
    }

    if (stored.revokedAt) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_INVALID");
    }

    const now = new Date();
    if (stored.expiresAt <= now) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_EXPIRED");
    }

    if (stored.session.revokedAt) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_INVALID");
    }

    if (stored.user.deletedAt || stored.user.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
    }

    const accessTokenExpiresIn = parseExpiresInSeconds(
      env.JWT_ACCESS_EXPIRES_IN
    );

    const accessToken = signAccessToken({
      userId: stored.userId,
      sessionId: stored.sessionId,
      secret: env.JWT_ACCESS_SECRET,
      expiresInSeconds: accessTokenExpiresIn,
      role: stored.user.role === "ADMIN" ? "ADMIN" : "USER",
    });

    await markSessionActive(stored.sessionId);

    return { accessToken, accessTokenExpiresIn };
  },

  async logout(userId: string, sessionId: string): Promise<void> {
    // Fetch deviceId before revoking so we can clear the FCM token.
    const deviceId = await sessionRepository.getDeviceId(sessionId, userId);

    const result = await sessionRepository.revokeForUser(
      userId,
      sessionId,
      SessionRevokeReason.USER_SIGNED_OUT
    );

    if (result.revoked) {
      await markSessionRevoked(sessionId);
      // Always published, deviceId or not: notifications-service matches on
      // sessionId (deviceId is only a legacy-row fallback).
      publishSessionDeviceRevokedSafe({ userId, sessionId, deviceId });

      // Same realtime signal as revokeSession/revokeAllSessions: force-
      // disconnect this session's LIVE socket(s) and tell the user's other
      // devices to drop it from the Linked Devices list right now — reuses
      // the existing session-revoke:<userId> channel, no new event. The
      // "logout" reason keeps the gateway from telling THIS device its
      // session was terminated — it is the one that asked to sign out.
      // Fire-and-forget: a Redis hiccup must not fail logout.
      void publishSessionRevokedEvent(redis, userId, sessionId, "logout").catch(
        () => undefined
      );

      // Close out this session's "Login Detected" alert on the user's OTHER
      // devices (the signing-out device never sees its own). The session is
      // gone, so leaving the alert pending would let the 1-hour sweep later
      // resolve it as "This was you." about a session that no longer exists.
      recordSessionActionSafe({
        userId,
        sessionId,
        action: "TERMINATED",
        body: "Session terminated.",
      });

      publishAdminActivitySafe({
        actorId: userId,
        action: USER_AUDIT_ACTIONS.USER_LOGOUT,
        targetType: "session",
        targetId: sessionId,
      });
    }
  },

  async listSessions(
    userId: string,
    currentSessionId: string
  ): Promise<ListSessionsResult> {
    const rows = await sessionRepository.listActiveByUserId(userId);

    const sessions: ActiveSessionItem[] = rows.map((row) =>
      toActiveSessionItem(row, currentSessionId)
    );

    return { sessions };
  },

  async revokeSession(
    userId: string,
    currentSessionId: string,
    targetSessionId: string
  ): Promise<void> {
    const session = await sessionRepository.findActiveForUser(
      userId,
      targetSessionId
    );

    if (!session) {
      throw new NotFoundError("AUTH_SESSION_NOT_FOUND");
    }

    // Fetch deviceId before revoking so we can clear the FCM token.
    const deviceId = await sessionRepository.getDeviceId(
      targetSessionId,
      userId
    );

    const reason =
      targetSessionId === currentSessionId
        ? SessionRevokeReason.USER_SIGNED_OUT
        : SessionRevokeReason.REMOTE_SIGNOUT;

    const result = await sessionRepository.revokeForUser(
      userId,
      targetSessionId,
      reason
    );

    if (!result.revoked) {
      throw new NotFoundError("AUTH_SESSION_NOT_FOUND");
    }

    await markSessionRevoked(targetSessionId);

    recordAuditEventSafe({
      event: "LINKED_DEVICE_REVOKED",
      targetType: "linked_device",
      targetId: targetSessionId,
      userId,
      metadata: { reason },
    });

    publishAdminActivitySafe({
      actorId: userId,
      action: USER_AUDIT_ACTIONS.USER_SESSION_REVOKED,
      targetType: "session",
      targetId: targetSessionId,
      after: { reason },
    });

    publishSessionDeviceRevokedSafe({
      userId,
      sessionId: targetSessionId,
      deviceId,
    });

    // Force-disconnect this device's LIVE socket(s), if any, right now —
    // otherwise it would stay connected until its access token naturally
    // expires. Fire-and-forget: a Redis hiccup must not fail the revoke.
    void publishSessionRevokedEvent(redis, userId, targetSessionId).catch(
      () => undefined
    );

    // Update the login-detected notification so all devices see "Session
    // terminated." and the action buttons disappear without a page refresh.
    if (reason === SessionRevokeReason.REMOTE_SIGNOUT) {
      recordSessionActionSafe({
        userId,
        sessionId: targetSessionId,
        action: "TERMINATED",
        body: "Session terminated.",
      });
    }
  },

  /**
   * "It's Me" — mark the login-detected notification for targetSessionId as
   * trusted. The session itself is untouched; only the notification status
   * changes so the UI resolves without action buttons.
   */
  async trustSession(userId: string, targetSessionId: string): Promise<void> {
    // Verify the session belongs to this user (IDOR guard).
    const session = await sessionRepository.findActiveForUser(
      userId,
      targetSessionId
    );
    if (!session) {
      throw new NotFoundError("AUTH_SESSION_NOT_FOUND");
    }

    recordSessionActionSafe({
      userId,
      sessionId: targetSessionId,
      action: "TRUSTED",
      body: "This was you.",
    });
  },

  /** "Sign out from all other devices" — keeps the caller's current session active. */
  async revokeAllSessions(
    userId: string,
    currentSessionId: string
  ): Promise<RevokeSessionsResult> {
    const active = await sessionRepository.listActiveSessionIds(userId);
    const otherSessionIds = active
      .map((row) => row.id)
      .filter((id) => id !== currentSessionId);

    const result = await sessionRepository.revokeOthersForUser(
      userId,
      currentSessionId,
      SessionRevokeReason.REMOTE_SIGNOUT
    );

    await markSessionsRevoked(otherSessionIds);

    if (result.revokedCount > 0) {
      // The caller's own session survives this call, so its push token must
      // too — without the exception the user stays signed in here but silently
      // stops receiving notifications.
      publishAllSessionsRevokedSafe({
        userId,
        exceptSessionId: currentSessionId,
      });

      // One row for the whole action, not one per device — the single-session sibling
      // audits, so without this "sign out everywhere" was the only revoke leaving no trace.
      publishAdminActivitySafe({
        actorId: userId,
        action: USER_AUDIT_ACTIONS.USER_SESSION_REVOKED,
        targetType: "user",
        targetId: userId,
        after: {
          reason: "REMOTE_SIGNOUT_ALL",
          revokedSessions: result.revokedCount,
        },
      });

      // Reuse the same per-session force-disconnect + list-sync signal as
      // revokeSession, so every revoked device is kicked immediately and the
      // caller's remaining session(s) get session:list_updated.
      for (const sessionId of otherSessionIds) {
        void publishSessionRevokedEvent(redis, userId, sessionId).catch(
          () => undefined
        );
        // Same notification close-out single-session revoke does. Without it a
        // still-pending "Login Detected" alert for a session killed here would
        // sit unresolved until its 1-hour deadline and then be auto-approved —
        // claiming "This was you." about a session that no longer exists.
        recordSessionActionSafe({
          userId,
          sessionId,
          action: "TERMINATED",
          body: "Session terminated.",
        });
      }
    }

    return result;
  },
};
