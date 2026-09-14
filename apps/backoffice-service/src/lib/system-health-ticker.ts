import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";
import { systemHealthService } from "../services/system-health.service.js";

/**
 * Redis channel the snapshot is published on, and the /admin room it is
 * delivered to. The gateway's `admin:*` PSUBSCRIBE picks it up and emits only
 * into that room, which a socket joins through `admin:system-health:subscribe`
 * after a `systemhealth.read` check (api-gateway sockets/namespaces/admin.ns.ts).
 * Never `admin:broadcast`: that room is ungated, and this payload carries
 * internal hosts and bucket names.
 */
const SYSTEM_HEALTH_CHANNEL = "admin:system-health";
const SYSTEM_HEALTH_UPDATED_EVENT = "admin:system-health:updated";

/**
 * Push a full System Health snapshot (the GET /system-health body) to open
 * System Health pages every tick. The panel used to poll that endpoint, and
 * every poll is charged against the admin rate limit (100 requests / 15 min
 * per session) — a 10s poll spent 90 of it on its own and 429'd the rest of
 * the panel.
 *
 * Never throws: a missed tick costs the page one update, and the panel falls
 * back to a REST read when pushes stop.
 *
 * ponytail: ticks whether or not anyone is watching (one probe round per tick,
 * less than a single polling page used to cause) and once per replica
 * (duplicate snapshots are idempotent on the panel). Gate on a watcher count or
 * a SET NX tick lock if either ever matters.
 */
export function startSystemHealthTicker(intervalMs = 15_000): NodeJS.Timeout {
  return setInterval(() => {
    void systemHealthService
      .getSystemHealth()
      .then((snapshot) =>
        redis.publish(
          SYSTEM_HEALTH_CHANNEL,
          JSON.stringify({ event: SYSTEM_HEALTH_UPDATED_EVENT, data: snapshot })
        )
      )
      .catch((error: unknown) => {
        logger.warn("system-health realtime tick failed", error);
      });
  }, intervalMs);
}
