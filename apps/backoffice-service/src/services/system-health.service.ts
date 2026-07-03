import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";
import { probeInfrastructure, probeServices } from "../lib/health-probes.js";
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

const CACHE_KEY = "backoffice:system-health";
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

/** Services-up tally over monitored services (a degraded service still counts as up). */
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

    const [services, infrastructure] = await Promise.all([
      probeServices(),
      probeInfrastructure(),
    ]);

    const result: SystemHealth = {
      overall: computeOverall(services, infrastructure),
      servicesUp: computeServicesUp(services),
      lastUpdated: new Date().toISOString(),
      services,
      infrastructure,
    };

    await writeCache(result);
    return result;
  },
};
