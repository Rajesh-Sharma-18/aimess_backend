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

export async function markSessionActive(sessionId: string): Promise<void> {
  try {
    await registerActiveSession(redis, sessionId, refreshTtlSeconds());
  } catch {
    // Redis optional for login; DB revoke still blocks refresh
  }
}

/**
 * Revoked markers live as long as an ACTIVE one (the refresh TTL), not just as
 * long as an access token. Blocking the next API call only needs the access
 * TTL, but this key is also the fallback oracle notifications-service uses at
 * send time to refuse a push to a revoked session — if the RabbitMQ cleanup
 * event was lost, an hour-long marker means the device silently resumes
 * receiving push once it expires. Session ids are never reused, so a stale
 * "revoked" marker can never deny a live session.
 */
export async function markSessionRevoked(sessionId: string): Promise<void> {
  try {
    await revokeActiveSession(redis, sessionId, refreshTtlSeconds());
  } catch {
    // ignore
  }
}

export async function markSessionsRevoked(sessionIds: string[]): Promise<void> {
  try {
    await revokeActiveSessions(redis, sessionIds, refreshTtlSeconds());
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
