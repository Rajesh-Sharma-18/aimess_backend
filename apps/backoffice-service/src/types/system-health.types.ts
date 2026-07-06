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
  lastChecked: string;
  note?: string;
}

/** One row of the Infrastructure Health panel. */
export interface InfraHealth {
  key: string;
  name: string;
  status: HealthStatus;
  /** Component-specific metrics (latency, connection state, bucket, …). */
  metrics: Record<string, number | string | null>;
  latencyMs: number | null;
  lastChecked: string;
  note?: string;
}

/** Aggregate services-up tally (monitored services only). */
export interface ServicesUp {
  up: number;
  total: number;
  label: string;
}

/** Full System Health payload. */
export interface SystemHealth {
  overall: HealthStatus;
  servicesUp: ServicesUp;
  lastUpdated: string;
  services: ServiceHealth[];
  infrastructure: InfraHealth[];
}
