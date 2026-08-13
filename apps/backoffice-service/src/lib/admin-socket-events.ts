import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";

/**
 * Push an account-level event to one admin's open panel sessions. The gateway
 * PSUBSCRIBEs `admin:*` and re-emits on its `/admin` namespace to the room of
 * the same name (see api-gateway sockets/namespaces/admin.ns.ts).
 *
 * Never throws: a missed push costs the panel a live update, and the request
 * that made the change must not fail because Redis hiccuped.
 */
export async function publishAdminSocketEvent(
  adminId: string,
  event: string,
  data: unknown
): Promise<void> {
  try {
    await redis.publish(`admin:${adminId}`, JSON.stringify({ event, data }));
  } catch (err) {
    logger.warn(`admin socket publish failed (${event} → ${adminId})`, err);
  }
}
