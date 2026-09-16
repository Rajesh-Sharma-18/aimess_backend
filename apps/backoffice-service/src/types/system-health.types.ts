/**
 * System Health dashboard DTOs (GET /admin/v1/system-health).
 *
 * A three-valued health vocabulary shared by the overall roll-up and every
 * infrastructure component. Individual services may additionally be `unknown`
 * when backoffice has no live probe wired for them (they are listed for
 * visibility but excluded from the overall roll-up and the services-up count).
 */
export type HealthStatus = "healthy" | "degraded" | "down";
export type ServiceHealthStatus = HealthStatus | "unknown";

/** One check behind a service's status: its own endpoint, or a dependency it uses. */
export interface HealthCheck {
  key: string;
  name: string;
  status: ServiceHealthStatus;
  /** A critical check that is down takes the whole service down. */
  critical: boolean;
  responseTimeMs: number | null;
  /** Sanitized, human-readable reason — present when not healthy. */
  reason?: string;
}

/** One row of the Service Health panel. */
export interface ServiceHealth {
  key: string;
  name: string;
  status: ServiceHealthStatus;
  /**
   * `false` when there is no live probe for this service — its status is
   * `unknown` and it does NOT influence `overall` or `servicesUp`.
   */
  monitored: boolean;
  /**
   * Rolling availability (%) derived from the circuit-breaker window
   * (successes ÷ (successes+failures+timeouts)). `null` when no samples yet or
   * the service is unmonitored.
   */
  uptimePercent: number | null;
  /** Measured round-trip of the live probe in ms; `null` when not probed. */
  latencyMs: number | null;
  /** Circuit-breaker posture, when one backs this service. */
  breaker: "open" | "half-open" | null;
  lastChecked: number;
  /** Raw probe detail. Internal only — stripped before the API response. */
  note?: string;
  /** Why the service is not healthy, naming the check(s) responsible. */
  reason?: string;
  /** Endpoint check first, then each monitored dependency (see lib/service-status.ts). */
  checks?: HealthCheck[];
  /** A Super Admin restart of this service is in flight. */
  restarting?: boolean;
}

/** One row of the Infrastructure Health panel. */
export interface InfraHealth {
  key: string;
  name: string;
  status: HealthStatus;
  /** Component-specific metrics (latency, connection state, bucket, …). */
  metrics: Record<string, number | string | null>;
  latencyMs: number | null;
  lastChecked: number;
  /** Raw probe detail. Internal only — stripped before the API response. */
  note?: string;
  /** Sanitized, human-readable reason — present when not healthy. */
  reason?: string;
}

/** Aggregate services-up tally (monitored services only). */
export interface ServicesUp {
  up: number;
  total: number;
  label: string;
}

/**
 * Version of the System Health payload contract. Bump it whenever the shape or
 * the status rules change. It keys the shared Redis cache and stamps every
 * snapshot, so backoffice instances running different code — a rolling deploy,
 * or several dev machines on one Redis — never serve or push each other's
 * snapshots as if they were their own.
 */
export const SYSTEM_HEALTH_SCHEMA_VERSION = 2;

/** Full System Health payload. */
export interface SystemHealth {
  schemaVersion: number;
  overall: HealthStatus;
  /** Which services / infrastructure make `overall` non-healthy, by name. */
  overallReason?: string;
  servicesUp: ServicesUp;
  lastUpdated: number;
  services: ServiceHealth[];
  infrastructure: InfraHealth[];
}
