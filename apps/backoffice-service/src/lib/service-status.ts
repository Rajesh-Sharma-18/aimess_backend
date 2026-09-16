import type {
  HealthCheck,
  HealthStatus,
  InfraHealth,
  ServiceHealth,
  ServiceHealthStatus,
  SystemHealth,
} from "../types/system-health.types.js";

/**
 * Status rules for System Health — the ONE place that decides a service's
 * status and the human-readable reasons shown to the Super Admin. Pure: it reads
 * the raw probe rows from health-probes.ts. The System Health page, its socket
 * push and the dashboard Service Status panel are all built from its output, so
 * they cannot disagree.
 *
 * SERVICE status comes from the service's OWN check only:
 *   down      its endpoint failed (unreachable, timed out, non-2xx, breaker open)
 *   degraded  it answers but slower than the threshold, or its breaker is half-open
 *   unknown   there is no probe for it
 *   healthy   its endpoint answered in time
 *
 * INFRASTRUCTURE is reported separately and never changes a service's status:
 * backoffice probes shared infrastructure from its own vantage point, which does
 * not prove a service cannot operate (a wrong probe address would otherwise mark
 * every service Down). Infrastructure failures affect the OVERALL status instead
 * (see computeOverall / describeOverall), and each service lists the dependencies
 * it uses as diagnostics.
 *
 * Reasons are built from the probe's classified outcome, never copied from the
 * raw error message: those carry hostnames, ports and connection details.
 */

/** Wall-clock ceiling for any single probe. Matches the gRPC breaker timeout. */
export const PROBE_TIMEOUT_MS = 2000;
/** Above this, a reachable service is reported `degraded` rather than `healthy`. */
export const SLOW_SERVICE_MS = 1000;
/** Above this, a reachable infrastructure dependency is reported `degraded`. */
export const SLOW_INFRA_MS = 500;

interface Dependency {
  /** `InfraHealth.key` of the infrastructure probe. */
  key: string;
  critical: boolean;
}

/**
 * The infrastructure each monitored service uses (keyed by `ServiceHealth.key`),
 * taken from the service's own code: Prisma datasource, @aimess/storage / redis /
 * messaging imports, SRS / LiveKit / ClamAV clients. Shown as the service's
 * dependency checks. `critical` is informational — the service cannot do its job
 * without it, per how its server.ts treats a failure:
 *   - MongoDB: primary datastore of every Mongo-backed service (startup fatal).
 *   - chat / calls: chat-service awaits connectChatRedis() unguarded (fatal).
 *   - calls: every call's media runs through the LiveKit SFU.
 *   - media: MinIO holds every upload ("media upload/download APIs will fail").
 *   - notification: RabbitMQ is the only way notification events arrive.
 *   - stream: SRS is the media server every stream runs through.
 */
export const SERVICE_DEPENDENCIES: Readonly<
  Record<string, readonly Dependency[]>
> = {
  auth: [
    { key: "redis", critical: false },
    { key: "message_queue", critical: false },
  ],
  community: [
    { key: "mongodb", critical: true },
    { key: "redis", critical: false },
    { key: "message_queue", critical: false },
    { key: "object_storage", critical: false },
  ],
  chat: [
    { key: "mongodb", critical: true },
    { key: "redis", critical: true },
    { key: "message_queue", critical: false },
    { key: "object_storage", critical: false },
    { key: "livekit", critical: false },
  ],
  calls: [
    { key: "mongodb", critical: true },
    { key: "redis", critical: true },
    { key: "livekit", critical: true },
  ],
  user: [
    { key: "redis", critical: false },
    { key: "message_queue", critical: false },
    { key: "object_storage", critical: false },
  ],
  media: [
    { key: "mongodb", critical: true },
    { key: "object_storage", critical: true },
    { key: "antivirus", critical: false },
    { key: "redis", critical: false },
    { key: "message_queue", critical: false },
  ],
  notification: [
    { key: "mongodb", critical: true },
    { key: "message_queue", critical: true },
    { key: "redis", critical: false },
  ],
  stream: [
    { key: "mongodb", critical: true },
    { key: "media_server", critical: true },
    { key: "redis", critical: false },
    { key: "message_queue", critical: false },
    { key: "object_storage", critical: false },
  ],
};

/** Metrics that locate infrastructure (addresses, bucket names) — never sent to the browser. */
const LOCATION_METRICS = new Set(["host", "bucket"]);

const SERVICE_CHECK_NAME = "Service endpoint";

/** Human-readable reason for a failed probe, from its note — never the raw note. */
function failureReason(note: string | undefined): string {
  const text = note ?? "";
  if (/timed out|timeout|aborted/i.test(text)) {
    return `Health check timed out after ${String(PROBE_TIMEOUT_MS)}ms.`;
  }
  const http = /^HTTP (\d{3})$/.exec(text);
  if (http) return `Health check returned HTTP ${http[1]}.`;
  if (/unexpected/i.test(text)) {
    return "Health check returned an unexpected response.";
  }
  return "Unreachable.";
}

const slowReason = (latencyMs: number | null, thresholdMs: number): string =>
  `Response time ${String(Math.round(latencyMs ?? 0))}ms exceeded the ${String(thresholdMs)}ms threshold.`;

function endpointCheck(row: ServiceHealth): HealthCheck {
  const base = {
    key: "service",
    name: SERVICE_CHECK_NAME,
    critical: true,
    responseTimeMs: row.latencyMs,
  };
  if (row.status === "unknown") {
    return { ...base, status: "unknown", reason: "No health probe is configured." };
  }
  if (row.status === "down") {
    return {
      ...base,
      status: "down",
      reason:
        row.breaker === "open"
          ? "Circuit breaker is open after repeated failed calls."
          : failureReason(row.note),
    };
  }
  if (row.status === "degraded") {
    return { ...base, status: "degraded", reason: slowReason(row.latencyMs, SLOW_SERVICE_MS) };
  }
  if (row.breaker === "half-open") {
    return {
      ...base,
      status: "degraded",
      reason: "Circuit breaker is half-open while recovering from recent failures.",
    };
  }
  return { ...base, status: "healthy" };
}

function infraReason(row: InfraHealth): string | undefined {
  if (row.status === "down") return failureReason(row.note);
  if (row.status === "degraded") return slowReason(row.latencyMs, SLOW_INFRA_MS);
  return undefined;
}

/**
 * A raw service probe row → its status (from its own endpoint check), its
 * checks (endpoint first, then the monitored dependencies it uses) and a
 * sanitized reason. `infrastructure` is the RAW infra probe rows (their notes
 * classify reasons). The raw `note` is dropped.
 */
export function evaluateService(
  row: ServiceHealth,
  infrastructure: InfraHealth[]
): ServiceHealth {
  const infraByKey = new Map(infrastructure.map((i) => [i.key, i]));
  const own = endpointCheck(row);
  const checks = [own];
  for (const dep of SERVICE_DEPENDENCIES[row.key] ?? []) {
    const infra = infraByKey.get(dep.key);
    if (!infra) continue;
    checks.push({
      key: infra.key,
      name: infra.name,
      status: infra.status,
      critical: dep.critical,
      responseTimeMs: infra.latencyMs,
      reason: infraReason(infra),
    });
  }

  const failingDependencies = checks.slice(1).filter((c) => c.status !== "healthy");
  const reason =
    own.status === "healthy"
      ? undefined
      : [
          `${own.name}: ${own.reason ?? ""}`,
          failingDependencies.length > 0
            ? `Dependency issues: ${failingDependencies.map((c) => `${c.name} (${c.status})`).join(", ")}.`
            : "",
        ]
          .filter(Boolean)
          .join(" ");

  return {
    key: row.key,
    name: row.name,
    status: own.status,
    monitored: row.monitored,
    uptimePercent: row.uptimePercent,
    latencyMs: row.latencyMs,
    breaker: row.breaker,
    lastChecked: row.lastChecked,
    reason,
    checks,
  };
}

/** A raw infra probe row with a sanitized reason in place of its note, minus location metrics. */
export function sanitizeInfra(row: InfraHealth): InfraHealth {
  return {
    key: row.key,
    name: row.name,
    status: row.status,
    metrics: Object.fromEntries(
      Object.entries(row.metrics).filter(([k]) => !LOCATION_METRICS.has(k))
    ),
    latencyMs: row.latencyMs,
    lastChecked: row.lastChecked,
    reason: infraReason(row),
  };
}

/**
 * Why the overall status is not healthy — which services and which
 * infrastructure components, by name. So "Degraded" with "Services Up 8/8" is
 * never left unexplained. Unmonitored services are ignored, as in the roll-up.
 */
export function describeOverall(
  services: ServiceHealth[],
  infrastructure: InfraHealth[]
): string | undefined {
  const monitored = services.filter((s) => s.monitored);
  const groups: { noun: string; state: string; names: string[] }[] = [
    { noun: "service", state: "down", names: monitored.filter((s) => s.status === "down").map((s) => s.name) },
    { noun: "service", state: "degraded", names: monitored.filter((s) => s.status === "degraded").map((s) => s.name) },
    { noun: "infrastructure component", state: "unavailable", names: infrastructure.filter((i) => i.status === "down").map((i) => i.name) },
    { noun: "infrastructure component", state: "degraded", names: infrastructure.filter((i) => i.status === "degraded").map((i) => i.name) },
  ];
  const parts = groups
    .filter((g) => g.names.length > 0)
    .map(
      (g) =>
        `${String(g.names.length)} ${g.noun}${g.names.length === 1 ? "" : "s"} ${g.state}: ${g.names.join(", ")}.`
    );
  return parts.length > 0 ? parts.join(" ") : undefined;
}

// ---------------------------------------------------------------------------
// Dashboard Service Status panel — a summary of the SAME snapshot
// ---------------------------------------------------------------------------

export type ServiceState = "operational" | "degraded" | "down" | "unknown";

export interface ServiceStatusEntry {
  key: string;
  label: string;
  status: ServiceState;
  /** A Super Admin restart of this service is in flight. */
  restarting: boolean;
  /** Epoch ms of the service probe; `null` when there is none. */
  checkedAt: number | null;
}

export interface ServiceStatus {
  overall: ServiceState;
  overallReason?: string;
  services: ServiceStatusEntry[];
  checkedAt: number;
}

const PANEL_SERVICES = [
  { key: "auth", label: "API / Auth Service", probeKey: "auth" },
  { key: "chat", label: "Chat Service", probeKey: "chat" },
  { key: "community", label: "Community Service", probeKey: "community" },
  { key: "media", label: "Media Service", probeKey: "media" },
  { key: "notification", label: "Notification Service", probeKey: "notification" },
  { key: "livestream", label: "Livestream Service", probeKey: "stream" },
] as const;

const toPanel = (s: ServiceHealthStatus | HealthStatus): ServiceState =>
  s === "healthy" ? "operational" : s;

/**
 * Project a System Health snapshot onto the dashboard panel: same statuses,
 * dashboard vocabulary, no status logic of its own. `null` (no snapshot could
 * be produced) reports everything `unknown` — never `down`.
 */
export function buildServiceStatus(health: SystemHealth | null): ServiceStatus {
  const services = new Map(health?.services.map((s) => [s.key, s]));
  return {
    overall: health ? toPanel(health.overall) : "unknown",
    overallReason: health
      ? health.overallReason
      : "Health information is temporarily unavailable.",
    services: PANEL_SERVICES.map((def): ServiceStatusEntry => {
      const row = services.get(def.probeKey);
      return {
        key: def.key,
        label: def.label,
        status: row ? toPanel(row.status) : "unknown",
        restarting: row?.restarting === true,
        checkedAt: row?.lastChecked ?? null,
      };
    }),
    checkedAt: health?.lastUpdated ?? Date.now(),
  };
}
