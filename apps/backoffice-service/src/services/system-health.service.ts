import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";
import { probeInfrastructure, probeServices } from "../lib/health-probes.js";
import {
  healthInfrastructureRegistry,
  healthServiceRegistry,
} from "../lib/health-registry.js";
import { RESTARTABLE_SERVICES, restartLockKey } from "../lib/service-restart.js";
import { SYSTEM_HEALTH_SCHEMA_VERSION } from "../types/system-health.types.js";
import {
  describeOverall,
  evaluateService,
  sanitizeInfra,
} from "../lib/service-status.js";
import type {
  HealthStatus,
  InfraHealth,
  ServiceHealth,
  ServicesUp,
  SystemHealth,
} from "../types/system-health.types.js";

/**
 * System Health aggregation for the backoffice dashboard. Fans out the live
 * probes (services + infrastructure) concurrently, then rolls them up into an
 * overall status, a services-up tally, and a last-updated stamp. A short Redis
 * cache (parity with the dashboard sections) keeps a polling dashboard from
 * re-connecting to RabbitMQ / re-pinging every dependency on each request.
 *
 * Resilience contract: the probes never throw, so this can never 500 on a down
 * dependency — a failed component is reported `down`, not surfaced as an error.
 */

// Versioned: an instance on different code must never read this snapshot as its
// own. Unversioned, an older instance sharing the Redis filled the cache every
// tick and this one served that stale-contract snapshot instead of its own.
const CACHE_KEY = `backoffice:system-health:v${String(SYSTEM_HEALTH_SCHEMA_VERSION)}`;
const CACHE_TTL_SECONDS = 5;

async function readCache(): Promise<SystemHealth | null> {
  try {
    const raw = await redis.get(CACHE_KEY);
    return raw ? (JSON.parse(raw) as SystemHealth) : null;
  } catch (err) {
    logger.warn("system-health cache read failed");
    logger.warn(err);
    return null;
  }
}

async function writeCache(value: SystemHealth): Promise<void> {
  try {
    await redis.set(CACHE_KEY, JSON.stringify(value), "EX", CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn("system-health cache write failed");
    logger.warn(err);
  }
}

/**
 * Roll monitored services + all infrastructure into a single status.
 *   - `down`     — a CORE datastore (database/redis) is down, or every
 *                  monitored component is down (total outage).
 *   - `degraded` — some component is down or degraded, but core infra is up.
 *   - `healthy`  — every monitored component is healthy.
 * Unmonitored services (`monitored:false`, status `unknown`) are ignored.
 */
export function computeOverall(
  services: ServiceHealth[],
  infrastructure: InfraHealth[]
): HealthStatus {
  const monitored = services.filter((s) => s.monitored);
  const componentStatuses: HealthStatus[] = [
    ...monitored.map((s) => s.status as HealthStatus),
    ...infrastructure.map((i) => i.status),
  ];

  const coreDown = infrastructure.some(
    (i) => (i.key === "database" || i.key === "redis") && i.status === "down"
  );
  const allDown =
    componentStatuses.length > 0 &&
    componentStatuses.every((s) => s === "down");

  if (coreDown || allDown) return "down";
  if (componentStatuses.some((s) => s === "down" || s === "degraded")) {
    return "degraded";
  }
  return "healthy";
}

/**
 * Services with a Super Admin restart in flight — the restart run holds this
 * lock from request to verified outcome. Part of the snapshot so every screen
 * shows "Restarting" together. Best-effort: a Redis hiccup just omits the flag.
 */
async function restartingServices(keys: string[]): Promise<Set<string>> {
  const restartable = keys.filter((k) => RESTARTABLE_SERVICES.has(k));
  if (restartable.length === 0) return new Set();
  try {
    const locks = await redis.mget(restartable.map(restartLockKey));
    return new Set(restartable.filter((_, i) => locks[i] !== null));
  } catch {
    return new Set();
  }
}

/**
 * Services-up tally over monitored APPLICATION services only — infrastructure is
 * never counted (a degraded service still counts as up).
 */
export function computeServicesUp(services: ServiceHealth[]): ServicesUp {
  const monitored = services.filter((s) => s.monitored);
  const up = monitored.filter((s) => s.status !== "down").length;
  const total = monitored.length;
  return { up, total, label: `${String(up)}/${String(total)}` };
}

export const systemHealthService = {
  async getSystemHealth(): Promise<SystemHealth> {
    const cached = await readCache();
    if (cached) return cached;

    const [rawServices, rawInfrastructure] = await Promise.all([
      probeServices(healthServiceRegistry.getServices()),
      probeInfrastructure(healthInfrastructureRegistry.getInfrastructure()),
    ]);
    // Status rules + sanitized reasons (lib/service-status.ts). Raw probe notes
    // and location metrics never leave this service.
    const restarting = await restartingServices(rawServices.map((s) => s.key));
    const services = rawServices.map((s) => {
      const evaluated = evaluateService(s, rawInfrastructure);
      return restarting.has(s.key) ? { ...evaluated, restarting: true } : evaluated;
    });
    const infrastructure = rawInfrastructure.map(sanitizeInfra);

    const result: SystemHealth = {
      schemaVersion: SYSTEM_HEALTH_SCHEMA_VERSION,
      overall: computeOverall(services, infrastructure),
      overallReason: describeOverall(services, infrastructure),
      servicesUp: computeServicesUp(services),
      lastUpdated: Date.now(),
      services,
      infrastructure,
    };

    await writeCache(result);
    return result;
  },
};
