import { logger } from "@aimess/logger";

import { communityRepository } from "../repositories/community.repository.js";

const THROTTLE_MS = 3_600_000;
const lastTouch = new Map<string, number>();

/**
 * Record that `userId` was active in `communityId` (send / open / admin action).
 * Only the ADMIN row is written, at most hourly; the in-process map keeps hot
 * paths (every message send) off the database.
 */
export function touchAdminActivity(communityId: string, userId: string): void {
  const key = `${communityId}:${userId}`;
  const now = Date.now();
  if (now - (lastTouch.get(key) ?? 0) < THROTTLE_MS) return;
  // ponytail: whole-map reset bounds memory; an LRU only if this ever churns.
  if (lastTouch.size > 50_000) lastTouch.clear();
  lastTouch.set(key, now);
  void Promise.resolve()
    .then(() =>
      communityRepository.touchAdminActivity(communityId, userId, new Date(now))
    )
    .catch((err: unknown) => {
      logger.warn(
        `touchAdminActivity failed community=${communityId} user=${userId}: ${String(err)}`
      );
    });
}
