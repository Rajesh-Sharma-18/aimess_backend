import { signAccessToken } from "@aimess/auth-jwt";
import { NotFoundError, UnauthorizedError } from "@aimess/errors";
import { logger } from "@aimess/logger";
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
import { assertNotBanned } from "../lib/account-guard.js";
import { toActiveSessionItem } from "../lib/session-serializer.js";
import { env, accessTokenSigningKey } from "../config/env.js";
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

/**
 * How long a just-rotated refresh token still answers, instead of being treated
 * as theft.
 *
 * Rotation has an unavoidable race: the server has replaced the token before
 * the client has stored the replacement. A dropped response, a background tab
 * refreshing at the same moment as the foreground one, or an app killed mid-
 * flight all produce a second request carrying the OLD token — through no
 * fault of the holder. Treating that as a stolen token logs the user out of
 * every device, which is a far worse outcome than the narrow window this
 * allows.
 *
 * Short enough that a genuine thief cannot rely on it: they would have to
 * replay within seconds of the legitimate holder's own refresh.
 */
const REFRESH_ROTATION_GRACE_SECONDS = 60;

/**
 * Decide whether a reuse of an already-rotated refresh token is a benign replay
 * or a stolen credential — and revoke everything if it is the latter.
 *
 * Returns normally for a replay inside the grace window. Throws
 * AUTH_REFRESH_TOKEN_INVALID otherwise, after revoking every session for the
 * account, which is the tripwire that makes rotation worth doing at all.
 *
 * The rotation time is the successor's `createdAt`: the successor is created in
 * the same transaction that revokes its parent, so it needs no extra column.
 */
async function assertNotStolenReplay(stored: {
  id: string;
  userId: string;
  rotatedToId: string | null;
}): Promise<{ benignReplayOfTokenId: string } | null> {
  if (stored.rotatedToId) {
    const successor = await refreshTokenRepository.findSuccessor(
      stored.rotatedToId
    );
    const rotatedAt = successor?.createdAt;
    const withinGrace =
      rotatedAt !== undefined &&
      Date.now() - rotatedAt.getTime() <= REFRESH_ROTATION_GRACE_SECONDS * 1000;

    // A successor that has itself been rotated or revoked means the chain moved
    // on: this is not the immediate race, so the grace does not apply.
    const successorStillCurrent =
      successor !== null &&
      successor !== undefined &&
      successor.rotatedToId === null &&
      successor.revokedAt === null;

    if (withinGrace && successorStillCurrent) {
      logger.warn("refresh token replayed inside the rotation grace window", {
        service: "auth-service",
        userId: stored.userId,
      });
      // The caller continues from the SUCCESSOR, not from the token it was
      // handed: that one is spent, and its `revokedAt` would otherwise reject
      // the request a few lines further down. Rotating the successor keeps the
      // chain single-threaded, so a second replay still trips the tripwire.
      return { benignReplayOfTokenId: successor.id };
    }
  }

  const active = await sessionRepository.listActiveSessionIds(stored.userId);
  await sessionRepository.revokeAllForUser(
    stored.userId,
    SessionRevokeReason.TOKEN_REUSE_DETECTED
  );
  await markSessionsRevoked(active.map((row) => row.id));
  // All sessions revoked, so all push tokens go with them.
  publishAllSessionsRevokedSafe({ userId: stored.userId });
  auditTokenReuseRevoke(stored.userId, active.length);
  throw new UnauthorizedError("AUTH_REFRESH_TOKEN_INVALID");
}

// The refresh token carries its own lifetime: whatever window it was minted
// with is the window its successor gets. That keeps remember-me (30d) and
// normal (7d) sessions apart without a schema column, and clamps to the
// configured default if a row somehow predates this.
function rotatedTokenLifetimeSeconds(
  createdAt: Date | null | undefined,
  expiresAt: Date
): number {
  // createdAt is only absent for rows minted before it was selected here.
  const original = createdAt
    ? Math.floor((expiresAt.getTime() - createdAt.getTime()) / 1000)
    : 0;
  return original > 0
    ? original
    : parseExpiresInSeconds(env.JWT_REFRESH_EXPIRES_IN);
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

    // Reuse of an already-rotated token. `assertNotStolenReplay` reports the
    // narrow race where the client had not yet stored the replacement, and
    // otherwise revokes every session and throws — the tripwire that makes
    // rotation worth doing.
    const replay = stored.rotatedToId
      ? await assertNotStolenReplay(stored)
      : null;
    // On a benign replay the token in hand is spent; rotate the successor,
    // which is the current head of the chain.
    const rotateFromTokenId = replay?.benignReplayOfTokenId ?? stored.id;

    const now = new Date();

    // Skipped for a benign replay: the spent token is revoked BY the rotation
    // this replay is a duplicate of, so the check would reject the very case
    // the grace window exists to allow.
    if (!replay && stored.revokedAt) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_INVALID");
    }

    if (stored.expiresAt <= now) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_EXPIRED");
    }

    if (stored.session.revokedAt) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_INVALID");
    }

    if (stored.user.deletedAt) {
      throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
    }

    // Refresh is the bypass a ban has to close: a still-valid refresh token
    // would otherwise mint a fresh 15-minute access token every time, and the
    // gateway's socket keep-alive re-arms a live connection off exactly this
    // endpoint.
    assertNotBanned(stored.user.status);

    if (stored.user.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
    }

    const accessTokenExpiresIn = parseExpiresInSeconds(
      env.JWT_ACCESS_EXPIRES_IN
    );
    // Reuse the lifetime this session was issued with instead of the default.
    // Hardcoding JWT_REFRESH_EXPIRES_IN collapsed a 30-day "remember me"
    // session to 7 days on its very first rotation, so the user was signed out
    // a week into a month-long session.
    const refreshTokenExpiresIn = rotatedTokenLifetimeSeconds(
      stored.createdAt,
      stored.expiresAt
    );

    const newRefreshToken = createRefreshTokenValue();
    const newRefreshExpiresAt = new Date(
      Date.now() + refreshTokenExpiresIn * 1000
    );

    await refreshTokenRepository.rotate({
      oldTokenId: rotateFromTokenId,
      userId: stored.userId,
      sessionId: stored.sessionId,
      newTokenHash: hashToken(newRefreshToken),
      newExpiresAt: newRefreshExpiresAt,
    });

    const accessToken = signAccessToken({
      userId: stored.userId,
      sessionId: stored.sessionId,
      signingKey: accessTokenSigningKey,
      expiresInSeconds: accessTokenExpiresIn,
      role: stored.user.role === "ADMIN" ? "ADMIN" : "USER",
    });

    await markSessionActive(stored.sessionId, refreshTokenExpiresIn);

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

    // A token that has already been rotated is either a replay we caused, or a
    // stolen one. `assertNotStolenReplay` tells them apart by how long ago the
    // rotation happened; a genuine reuse revokes every session.
    const replay = stored.rotatedToId
      ? await assertNotStolenReplay(stored)
      : null;
    const rotateFromTokenId = replay?.benignReplayOfTokenId ?? stored.id;

    // See refresh(): the spent token's own revocation must not reject a replay
    // that is a duplicate of the rotation which set it.
    if (!replay && stored.revokedAt) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_INVALID");
    }

    const now = new Date();
    if (stored.expiresAt <= now) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_EXPIRED");
    }

    if (stored.session.revokedAt) {
      throw new UnauthorizedError("AUTH_REFRESH_TOKEN_INVALID");
    }

    if (stored.user.deletedAt) {
      throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
    }

    // Refresh is the bypass a ban has to close: a still-valid refresh token
    // would otherwise mint a fresh 15-minute access token every time, and the
    // gateway's socket keep-alive re-arms a live connection off exactly this
    // endpoint.
    assertNotBanned(stored.user.status);

    if (stored.user.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
    }

    const accessTokenExpiresIn = parseExpiresInSeconds(
      env.JWT_ACCESS_EXPIRES_IN
    );
    const refreshTokenExpiresIn = parseExpiresInSeconds(
      env.JWT_REFRESH_EXPIRES_IN
    );

    // Rotate, exactly as `refresh()` does.
    //
    // This endpoint used to mint an access token and leave the refresh token
    // untouched, so a stolen refresh token could be used indefinitely and never
    // tripped the reuse detection that protects `refresh()` — the thief simply
    // avoided the endpoint that rotates. Rotating here closes that: the moment
    // either party uses the old token again, the replay check below fires and
    // every session is revoked.
    //
    // The new token is RETURNED, so the caller can store it. The gateway's
    // `auth:refresh` socket handler relays it to the client for the same
    // reason.
    const newRefreshToken = createRefreshTokenValue();
    await refreshTokenRepository.rotate({
      oldTokenId: rotateFromTokenId,
      userId: stored.userId,
      sessionId: stored.sessionId,
      newTokenHash: hashToken(newRefreshToken),
      newExpiresAt: new Date(Date.now() + refreshTokenExpiresIn * 1000),
    });

    const accessToken = signAccessToken({
      userId: stored.userId,
      sessionId: stored.sessionId,
      signingKey: accessTokenSigningKey,
      expiresInSeconds: accessTokenExpiresIn,
      role: stored.user.role === "ADMIN" ? "ADMIN" : "USER",
    });

    // Non-rotating, so the marker keeps the sessions own remaining lifetime.
    await markSessionActive(
      stored.sessionId,
      rotatedTokenLifetimeSeconds(stored.createdAt, stored.expiresAt)
    );

    return {
      accessToken,
      accessTokenExpiresIn,
      refreshToken: newRefreshToken,
      refreshTokenExpiresIn,
    };
  },

  // Sign-out for a caller whose ACCESS token has already expired. The refresh
  // cookie is httpOnly, so the browser cannot drop it itself - without this the
  // "Sign out" button would leave a live 30-day session in the cookie jar.
  // Unknown or already-dead tokens resolve silently: logout is idempotent.
  async logoutByRefreshToken(refreshToken: string): Promise<void> {
    const stored = await refreshTokenRepository.findByTokenHash(
      hashToken(refreshToken)
    );

    if (!stored || stored.session.revokedAt) return;

    await this.logout(stored.userId, stored.sessionId);
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
