import { logger } from "@aimess/logger";
import {
  getActiveSessionFromCache,
  registerActiveSession,
  revokeActiveSession,
  revokeActiveSessions,
} from "@aimess/redis";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { adminSessionRepository } from "../repositories/admin-session.repository.js";

/**
 * Namespace admin session ids so the shared active-session helpers don't collide
 * with user-service keys. Keys become `aimess:session:active:admin:<id>`.
 */
function nsId(sessionId: string): string {
  return `admin:${sessionId}`;
}

function refreshTtlSeconds(): number {
  const seconds = Number(env.JWT_ADMIN_REFRESH_EXPIRES_IN);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 604800;
}

function accessTtlSeconds(): number {
  const seconds = Number(env.JWT_ADMIN_EXPIRES_IN);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 28800;
}

export async function markAdminSessionActive(sessionId: string): Promise<void> {
  try {
    await registerActiveSession(redis, nsId(sessionId), refreshTtlSeconds());
  } catch {
    // Redis optional for login; DB revoke still blocks refresh
  }
}

export async function markAdminSessionRevoked(
  sessionId: string
): Promise<void> {
  try {
    await revokeActiveSession(redis, nsId(sessionId), accessTtlSeconds());
  } catch (err) {
    // A failed revoke write can leave a stale-active token until the login key
    // TTL expires — surface it rather than swallowing.
    logger.warn(`admin session revoke cache write failed (${sessionId})`, err);
  }
}

export async function markAdminSessionsRevoked(
  sessionIds: string[]
): Promise<void> {
  try {
    await revokeActiveSessions(redis, sessionIds.map(nsId), accessTtlSeconds());
  } catch (err) {
    logger.warn(
      `admin session revoke cache write failed (${sessionIds.join(",")})`,
      err
    );
  }
}

/** Redis first, then DB (covers sessions created before this feature). */
export async function isAdminSessionActiveForRequest(
  sessionId: string
): Promise<boolean> {
  try {
    const cached = await getActiveSessionFromCache(redis, nsId(sessionId));
    if (cached === true) return true;
    if (cached === false) return false;
  } catch {
    // fall through to DB
  }

  const row = await adminSessionRepository.findActiveById(sessionId);
  return (
    row !== null && row.revokedAt === null && row.refreshExpiresAt > new Date()
  );
}
