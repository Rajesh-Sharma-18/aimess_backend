import { createHash, randomBytes } from "node:crypto";

import { signAccessToken, type PlatformRole } from "@aimess/auth-jwt";

import { env } from "../config/env.js";
import { markSessionActive } from "./session-active-cache.js";
import type { SessionContext } from "./session-context.js";
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

export async function issueAuthTokens(
  userId: string,
  role: PlatformRole,
  session: SessionContext,
  rememberMe?: boolean
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
    refreshTokenHash: hashToken(refreshToken),
    refreshExpiresAt,
  });

  const accessToken = signAccessToken({
    userId,
    sessionId: createdSession.id,
    secret: env.JWT_ACCESS_SECRET,
    expiresInSeconds: accessTokenExpiresIn,
    role,
  });

  await markSessionActive(createdSession.id);

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
