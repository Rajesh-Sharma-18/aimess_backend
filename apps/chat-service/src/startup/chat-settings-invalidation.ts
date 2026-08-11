/**
 * Keeps `lib/account-chat-settings.ts` honest.
 *
 * That cache holds one user's Settings → Chat block for 60s because it is read
 * on hot paths (every private send for the auto-delete default, every mark-read
 * for the read-receipt switch). The TTL alone is fine for the auto-delete
 * default, but not for a privacy switch: a user who turns Read Receipt off
 * expects their next read to be silent, not their next read after a minute.
 *
 * user-service publishes one message here from `emitSettingsUpdatedSafe` — the
 * single chokepoint every settings write already goes through — so the cache is
 * dropped on the same event that pushes the new settings to the user's other
 * devices. Every chat-service instance subscribes, so one publish clears them
 * all.
 *
 * Best-effort by design: if Redis is down the TTL still expires and the switch
 * still takes effect, just a minute later. Nothing here may throw into startup.
 */
import { logger } from "@aimess/logger";

import { createRedisSubClient } from "../config/redis.js";
import { invalidateAccountChatSettings } from "../lib/account-chat-settings.js";

/** Must match the literal in user-service `src/lib/friend-socket.ts`. */
const CHANNEL = "chat-settings:invalidate";

export function startChatSettingsInvalidationListener(): void {
  const sub = createRedisSubClient();

  sub.on("message", (_channel: string, raw: string) => {
    try {
      const { userId } = JSON.parse(raw) as { userId?: unknown };
      if (typeof userId === "string" && userId) {
        invalidateAccountChatSettings(userId);
      }
    } catch (err) {
      logger.warn(`${CHANNEL} parse error: ${String(err)}`);
    }
  });

  void sub.subscribe(CHANNEL).catch((err: unknown) => {
    // Not fatal: the 60s TTL is the fallback invalidation path.
    logger.warn(`Failed to subscribe to ${CHANNEL}: ${String(err)}`);
  });
}
