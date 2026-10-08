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

import { publishChatUserEvent, publishUserSocketEvent } from "@aimess/redis";
import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";
import type { CustomStatus } from "../services/custom-status.service.js";

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

const CUSTOM_STATUS_EVENT = "user:custom_status_updated";

/**
 * `user:<id>` (/chat) reaches the owner's sockets and is mirrored by the gateway to
 * `presence:<id>` watchers — who are authorized by online-status scope, not profile
 * scope — so the status rides along only when the profile is visible to EVERYONE;
 * otherwise that copy is a signal (no `customStatus` key) and the owner's devices get
 * the full form on `notify:<id>` (/notify).
 */
export function emitCustomStatusUpdatedSafe(
  userId: string,
  updatedAt: Date,
  customStatus: CustomStatus | null
): void {
  const signal = { userId, updatedAt: updatedAt.getTime(), serverNow: Date.now() };
  const full = {
    ...signal,
    customStatus: customStatus && {
      emoji: customStatus.emoji,
      text: customStatus.text,
      startedAt: customStatus.startedAt.getTime(),
      expiresAt: customStatus.expiresAt.getTime(),
      updatedAt: customStatus.updatedAt.getTime(),
    },
  };
  const warn = (channel: string) => (error: unknown) => {
    logger.warn(`Failed to publish ${CUSTOM_STATUS_EVENT} to ${channel}:${userId}`);
    logger.warn(error);
  };
  void publishChatUserEvent(
    redis,
    userId,
    CUSTOM_STATUS_EVENT,
    full
  ).catch(warn("user"));
}
