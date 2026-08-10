/**
 * Realtime "your own profile changed" fan-out to the owner's OTHER devices.
 *
 * Deliberately NOT the `user:<userId>` /chat channel `friend-socket.ts` uses:
 * a peer can join that room via `presence:subscribe`, so it is not a private
 * self channel. This rides `notify:<userId>`, which the api-gateway `/notify`
 * namespace relays to room `user:<userId>` — a room only the authenticated
 * user's own sockets ever join (`notify.ns.ts`).
 *
 * The event is a SIGNAL ONLY: it carries no profile field values, so no PII
 * crosses the socket and a client can never write a half-profile from it. The
 * client answers with one authoritative `GET /profile`.
 *
 * Fire-and-forget: a Redis hiccup must never fail the profile-update REST call.
 */
import { randomUUID } from "node:crypto";

import { publishUserSocketEvent } from "@aimess/redis";
import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";

/**
 * Tell a user's other logged-in devices to re-fetch their profile.
 *
 * `updatedAt` MUST be the persisted row's value — the client uses it as an
 * ordering key and drops anything older than what it already holds.
 * `excludeSessionId` is the editing device's own session: it already has the
 * new profile in its HTTP response and must not receive its own echo.
 */
export function emitProfileUpdatedSafe(
  userId: string,
  updatedAt: string,
  excludeSessionId?: string
): void {
  void publishUserSocketEvent(
    redis,
    userId,
    "user:profile_updated",
    { userId, eventId: randomUUID(), updatedAt },
    excludeSessionId
  ).catch((error) => {
    logger.warn(`Failed to publish user:profile_updated to notify:${userId}`);
    logger.warn(error);
  });
}
