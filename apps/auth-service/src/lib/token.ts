import { createHash, randomBytes } from "node:crypto";

import { signAccessToken, type PlatformRole } from "@aimess/auth-jwt";
import { logger } from "@aimess/logger";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";
import { publishSessionCreatedEvent } from "@aimess/redis";

import { env, accessTokenSigningKey } from "../config/env.js";
import { redis } from "../config/redis.js";
import { markSessionActive } from "./session-active-cache.js";
import type { SessionContext } from "./session-context.js";
import { toActiveSessionItem } from "./session-serializer.js";
import { publishSecurityNewLoginSafe } from "../messaging/publish-auth-security.js";
import { authRepository } from "../repositories/auth.repository.js";
import { recordAuditEventSafe } from "../services/audit.service.js";

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
};

/** Tokens plus the id of the session row they belong to (needed e.g. to undo a device link). */
export type IssuedAuthTokens = {
  tokens: AuthTokens;
  sessionId: string;
};

function parseExpiresInSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid JWT expiry value: ${value}`);
  }
  return Math.floor(seconds);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createRefreshTokenValue(): string {
  return randomBytes(48).toString("base64url");
}

/** Per-call knobs for the shared session funnel. */
export type IssueAuthTokensOptions = {
  /**
   * Emit the "New login detected" security notification for this new session.
   * Defaults to true (password / social login). Registration and QR device-link
   * pass false — the former has no other devices to alert; the latter is
   * self-initiated from an already-authenticated same-user session (spec §7).
   */
  notifyNewLogin?: boolean;
};

export async function issueAuthTokens(
  userId: string,
  role: PlatformRole,
  session: SessionContext,
  rememberMe?: boolean,
  options?: IssueAuthTokensOptions
): Promise<IssuedAuthTokens> {
  const accessTokenExpiresIn = parseExpiresInSeconds(env.JWT_ACCESS_EXPIRES_IN);
  const refreshTokenExpiresIn = parseExpiresInSeconds(
    rememberMe
      ? env.JWT_REFRESH_EXPIRES_IN_REMEMBER_ME
      : env.JWT_REFRESH_EXPIRES_IN
  );

  const refreshToken = createRefreshTokenValue();
  const refreshExpiresAt = new Date(Date.now() + refreshTokenExpiresIn * 1000);

  const createdSession = await authRepository.createSessionWithRefreshToken({
    userId,
    deviceId: session.deviceId,
    deviceType: session.deviceType,
    deviceName: session.deviceName,
    osVersion: session.osVersion,
    appVersion: session.appVersion,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    countryCode: session.countryCode,
    refreshTokenHash: hashToken(refreshToken),
    refreshExpiresAt,
  });

  const accessToken = signAccessToken({
    userId,
    sessionId: createdSession.id,
    signingKey: accessTokenSigningKey,
    expiresInSeconds: accessTokenExpiresIn,
    role,
  });

  await markSessionActive(createdSession.id, refreshTokenExpiresIn);

  // Single funnel: every new device/session — normal login AND QR device-link
  // approval both call issueAuthTokens — lands here, so "Linked Device Created"
  // is audited exactly once per call site instead of duplicated at each caller.
  recordAuditEventSafe({
    event: "LINKED_DEVICE_CREATED",
    targetType: "linked_device",
    targetId: createdSession.id,
    userId,
    metadata: { deviceId: session.deviceId, deviceType: session.deviceType },
    ip: session.ipAddress,
    userAgent: session.userAgent,
  });

  // Same funnel feeds the admin panel's audit log: every new ACTIVE session is a login,
  // whether it came from password, social or QR device-link.
  publishAdminActivitySafe({
    actorId: userId,
    action: USER_AUDIT_ACTIONS.USER_LOGIN,
    targetType: "session",
    targetId: createdSession.id,
    after: {
      deviceType: session.deviceType,
      deviceName: session.deviceName,
      countryCode: session.countryCode,
    },
    ip: session.ipAddress,
    userAgent: session.userAgent,
  });

  // Realtime linked-device sync: the session is now persisted + ACTIVE, so push
  // the persisted DTO to the user's OTHER live devices via the existing
  // session:list_updated event. Fully guarded — a serialize/publish hiccup must
  // never fail login or QR device-linking.
  try {
    void publishSessionCreatedEvent(
      redis,
      userId,
      toActiveSessionItem(createdSession)
    ).catch((error) => {
      logger.error("Failed to publish session-created socket event");
      logger.error(error);
    });
  } catch (error) {
    logger.error("Failed to serialize session for session-created event");
    logger.error(error);
  }

  // Same single funnel drives the "New login detected" alert, so it fires
  // exactly once per new ACTIVE session with a real sessionId + device metadata,
  // reusing the existing auth.security_new_login → notifications pipeline.
  if (options?.notifyNewLogin !== false) {
    publishSecurityNewLoginSafe({
      userId,
      at: new Date().toISOString(),
      sessionId: createdSession.id,
      deviceName: session.deviceName,
      deviceType: session.deviceType,
      ipAddress: session.ipAddress,
      countryCode: session.countryCode,
      browser: session.browserName,
      os: session.osName,
    });
  }

  return {
    tokens: {
      accessToken,
      refreshToken,
      accessTokenExpiresIn,
      refreshTokenExpiresIn,
    },
    sessionId: createdSession.id,
  };
}
