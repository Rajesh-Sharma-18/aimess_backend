import {
  getActiveSessionFromCache,
  registerActiveSession,
  revokeActiveSession,
  revokeActiveSessions,
} from "@aimess/redis";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { sessionRepository } from "../repositories/session.repository.js";

function refreshTtlSeconds(): number {
  const seconds = Number(env.JWT_REFRESH_EXPIRES_IN);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 604800;
}

function accessTtlSeconds(): number {
  const seconds = Number(env.JWT_ACCESS_EXPIRES_IN);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 3600;
}

export async function markSessionActive(sessionId: string): Promise<void> {
  try {
    await registerActiveSession(redis, sessionId, refreshTtlSeconds());
  } catch {
    // Redis optional for login; DB revoke still blocks refresh
  }
}

export async function markSessionRevoked(sessionId: string): Promise<void> {
  try {
    await revokeActiveSession(redis, sessionId, accessTtlSeconds());
  } catch {
    // ignore
  }
}

export async function markSessionsRevoked(sessionIds: string[]): Promise<void> {
  try {
    await revokeActiveSessions(redis, sessionIds, accessTtlSeconds());
  } catch {
    // ignore
  }
}

/** Redis first, then DB (covers sessions created before this feature). */
export async function isSessionActiveForRequest(
  sessionId: string
): Promise<boolean> {
  try {
    const cached = await getActiveSessionFromCache(redis, sessionId);
    if (cached === true) return true;
    if (cached === false) return false;
  } catch {
    // fall through to DB
  }

  const row = await sessionRepository.isSessionActive(sessionId);
  return row !== null;
}
