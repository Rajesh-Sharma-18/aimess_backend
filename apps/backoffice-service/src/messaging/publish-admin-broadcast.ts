import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";

/**
 * Panel-wide "this list changed" bumps for the /admin Socket.IO namespace.
 *
 * The api-gateway joins every /admin socket to a shared `admin:broadcast` room
 * at connect and relays anything published on the Redis channel of the same
 * name (see `admin.ns.ts`), so a publisher needs no room bookkeeping and no
 * gateway change. stream-service already uses this channel for
 * `admin:livestreams:changed`; this is the same contract for the user
 * directory.
 *
 * The payload is EMPTY by contract. The panel answers a bump with a query
 * invalidation and the refetch is the source of truth, so no field can drift
 * and no permission is disclosed — an admin without `users.read` receives a
 * bump they do nothing with, and REST still gates the refetch.
 */
const ADMIN_BROADCAST_CHANNEL = "admin:broadcast";

/** A user's directory row or moderation status changed (ban/suspend/unban/re-activate). */
export const ADMIN_USERS_CHANGED = "admin:users:changed";

/**
 * The USER-facing half of the same fact, on its own channel because it has a
 * different audience and a different relay: the api-gateway turns it into one
 * payload-free `user:directory_changed` on `/notify`
 * (`user-directory-listener.ts`), so an ordinary reader with people search open
 * re-reads instead of being left looking at a banned account.
 *
 * Not in the `user:*` family on purpose — `chat.ns.ts` psubscribes that pattern
 * and reads the segment after the colon as a userId.
 */
const USER_DIRECTORY_CHANNEL = "broadcast:user-directory";

/** Fire-and-forget, same contract as {@link publishAdminBroadcastSafe}. */
export function publishUserDirectoryChangedSafe(): void {
  void redis
    .publish(USER_DIRECTORY_CHANNEL, JSON.stringify({ data: {} }))
    .catch((error: unknown) => {
      logger.warn(`Failed to publish on ${USER_DIRECTORY_CHANNEL}`);
      logger.warn(error);
    });
}

/**
 * Fire-and-forget: a moderation action has already been committed by the time
 * this runs, and must never fail because Redis blipped. A missed bump degrades
 * to the panel's existing refetch-on-mount behaviour, not to a wrong write.
 */
export function publishAdminBroadcastSafe(
  event: string,
  data: unknown = {}
): void {
  void redis
    .publish(ADMIN_BROADCAST_CHANNEL, JSON.stringify({ event, data }))
    .catch((error: unknown) => {
      logger.warn(`Failed to publish ${event} on ${ADMIN_BROADCAST_CHANNEL}`);
      logger.warn(error);
    });
}
