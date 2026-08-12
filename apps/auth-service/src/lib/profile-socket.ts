/**
 * Realtime "your account email changed" fan-out to the owner's OTHER devices.
 *
 * Mirrors user-service `lib/profile-socket.ts`: same `user:profile_updated`
 * event on `notify:<userId>`, so clients keep ONE handler (one authoritative
 * `GET /profile` refetch) rather than a second sync mechanism. Email lives in
 * auth-service, so linking/changing it has to emit from here.
 *
 * Signal only — no email value crosses the socket. Fire-and-forget: a Redis
 * hiccup must never fail the verify call that already committed.
 */
import { randomUUID } from "node:crypto";

import { publishUserSocketEvent } from "@aimess/redis";
import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";

export function emitProfileUpdatedSafe(userId: string): void {
  void publishUserSocketEvent(redis, userId, "user:profile_updated", {
    userId,
    eventId: randomUUID(),
    updatedAt: new Date().toISOString(),
  }).catch((error) => {
    logger.warn(`Failed to publish user:profile_updated to notify:${userId}`);
    logger.warn(error);
  });
}
