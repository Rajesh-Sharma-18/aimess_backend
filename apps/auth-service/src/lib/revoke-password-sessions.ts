import { publishSessionRevokedEvent } from "@aimess/redis";

import { redis } from "../config/redis.js";
import { markSessionsRevoked } from "./session-active-cache.js";
import { publishAllSessionsRevokedSafe } from "../messaging/publish-session-revoked.js";
import { authRepository } from "../repositories/auth.repository.js";
import { sessionRepository } from "../repositories/session.repository.js";

/**
 * The single revocation point for both password flows (change + reset).
 *
 * Revoking sessions in the database is only half the job — a revoked device
 * keeps its FCM/APNs row in notifications-service, and therefore keeps
 * receiving push, unless `session.all_revoked` is published for it. Both
 * callers previously did the DB half and change-password did the socket half;
 * neither published the device-token event, so every password change silently
 * left every signed-out device push-enabled forever.
 *
 * Everything a revocation must fan out now lives here, so a future password
 * flow cannot forget one of the three:
 *   1. revoke sessions + refresh tokens in the DB,
 *   2. bust the Redis active-session cache (live access tokens stop validating),
 *   3. drop the revoked devices' push tokens AND kick their live sockets.
 *
 * `exceptSessionId` spares the caller's own session — a signed-in password
 * change keeps the device that made it. Password RESET passes nothing, because
 * there no session is trusted.
 */
export async function revokeSessionsForPasswordChange(
  userId: string,
  exceptSessionId?: string
): Promise<void> {
  const active = await sessionRepository.listActiveSessionIds(userId);
  await authRepository.revokeSessionsAfterPasswordChange(
    userId,
    exceptSessionId
  );

  const revokedIds = active
    .map((row) => row.id)
    .filter((id) => id !== exceptSessionId);
  await markSessionsRevoked(revokedIds);

  // Push-token teardown. all_revoked (rather than one device_revoked per id)
  // also clears rows registered before device tokens carried a sessionId —
  // those cannot be attributed to a session and are stale by definition.
  publishAllSessionsRevokedSafe({
    userId,
    ...(exceptSessionId ? { exceptSessionId } : {}),
  });

  // Kick the revoked devices off the socket layer now rather than at token
  // expiry — same signal "Logout Device" and account deletion use.
  for (const sessionId of revokedIds) {
    void publishSessionRevokedEvent(redis, userId, sessionId).catch(
      () => undefined
    );
  }
}
