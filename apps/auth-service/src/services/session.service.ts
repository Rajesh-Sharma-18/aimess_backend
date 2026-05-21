import { signAccessToken } from "@aimess/auth-jwt";
import { NotFoundError, UnauthorizedError } from "@aimess/errors";

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
import { env } from "../config/env.js";
import { refreshTokenRepository } from "../repositories/refresh-token.repository.js";
import { sessionRepository } from "../repositories/session.repository.js";
import type { AuthTokensResponse } from "../types/auth.types.js";
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
    });

    await markSessionActive(stored.sessionId);

    return toAuthTokensResponse({
      accessToken,
      refreshToken: newRefreshToken,
      accessTokenExpiresIn,
      refreshTokenExpiresIn,
    });
  },

  async logout(userId: string, sessionId: string): Promise<void> {
    const result = await sessionRepository.revokeForUser(
      userId,
      sessionId,
      SessionRevokeReason.USER_SIGNED_OUT
    );

    if (result.revoked) {
      await markSessionRevoked(sessionId);
    }
  },

  async listSessions(
    userId: string,
    currentSessionId: string
  ): Promise<ListSessionsResult> {
    const rows = await sessionRepository.listActiveByUserId(userId);

    const sessions: ActiveSessionItem[] = rows.map((row) => ({
      sessionId: row.id,
      deviceId: row.deviceId,
      deviceName: row.deviceName,
      deviceType: row.deviceType,
      osVersion: row.osVersion,
      appVersion: row.appVersion,
      ipAddress: row.ipAddress,
      countryCode: row.countryCode,
      lastActiveAt: row.lastActiveAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      isCurrent: row.id === currentSessionId,
    }));

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

    return result;
  },
};
