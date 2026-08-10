import { signAccessToken } from "@aimess/auth-jwt";
import { NotFoundError, UnauthorizedError } from "@aimess/errors";
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
      if (deviceId) {
        publishSessionDeviceRevokedSafe({ userId, deviceId });
      }

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

    if (deviceId) {
      publishSessionDeviceRevokedSafe({ userId, deviceId });
    }

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
      publishAllSessionsRevokedSafe({ userId });

      // Reuse the same per-session force-disconnect + list-sync signal as
      // revokeSession, so every revoked device is kicked immediately and the
      // caller's remaining session(s) get session:list_updated.
      for (const sessionId of otherSessionIds) {
        void publishSessionRevokedEvent(redis, userId, sessionId).catch(
          () => undefined
        );
      }
    }

    return result;
  },
};
