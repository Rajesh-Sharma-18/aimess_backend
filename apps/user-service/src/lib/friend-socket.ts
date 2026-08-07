/**
 * Realtime friendship fan-out. user-service owns no sockets — it publishes
 * to the SAME `user:<userId>` Redis channel the api-gateway `/chat`
 * namespace already psubscribes and relays to Socket.IO room `user:<id>`
 * (see `publishChatUserEvent` in `@aimess/redis`, and
 * `apps/api-gateway/src/sockets/namespaces/chat.ns.ts`). Since every
 * connected device joins that room on connect, one publish reaches every
 * logged-in device for that user, on every gateway instance behind the
 * Redis Socket.IO adapter — no gateway-specific code needed.
 *
 * Fire-and-forget by design (mirrors `publish-friendship.ts`): a Redis
 * hiccup must never fail the friendship REST call that triggered it.
 */
import { publishChatUserEvent } from "@aimess/redis";
import { logger } from "@aimess/logger";
import type {
  FriendSocketEventType,
  ConversationSocketEventType,
} from "@aimess/shared-types";

import { redis } from "../config/redis.js";

/** Publish one realtime friendship (or conversation) event to one user's devices. Never throws. */
export function emitFriendEventSafe(
  userId: string,
  event: FriendSocketEventType | ConversationSocketEventType,
  data: unknown
): void {
  void publishChatUserEvent(redis, userId, event, data).catch((error) => {
    logger.warn(`Failed to publish ${event} to user:${userId}`);
    logger.warn(error);
  });
}

/**
 * Push a settings change to the owner's OTHER logged-in devices.
 *
 * Rides the same `user:<userId>` channel, but the /chat relay redirects
 * `settings:updated` to the `self:<userId>` room (see the `isSelfOnlyEvent`
 * list in `chat.ns.ts`). That redirect is load-bearing, not an optimization:
 * `presence:subscribe` lets a peer join `user:<peerId>`, so publishing a user's
 * own privacy settings to the shared identity room would hand them to exactly
 * the people those settings exist to exclude.
 */
export function emitSettingsUpdatedSafe(
  userId: string,
  settings: unknown
): void {
  void publishChatUserEvent(redis, userId, "settings:updated", settings).catch(
    (error) => {
      logger.warn(`Failed to publish settings:updated to user:${userId}`);
      logger.warn(error);
    }
  );
}

/** Publish the same realtime event to two users at once (e.g. both sides of a friendship change). */
export function emitFriendEventToPairSafe(
  userAId: string,
  userBId: string,
  event: FriendSocketEventType | ConversationSocketEventType,
  dataFor: (targetUserId: string) => unknown
): void {
  emitFriendEventSafe(userAId, event, dataFor(userAId));
  emitFriendEventSafe(userBId, event, dataFor(userBId));
}
