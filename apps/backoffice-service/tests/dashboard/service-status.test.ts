/**
 * System Health status rules (lib/service-status.ts). Pure — driven by hand-built
 * probe rows, so every scenario is deterministic. Covers:
 *   - service status from the service's OWN check only (infrastructure never
 *     marks a service down), with dependency issues listed as diagnostics;
 *   - the overall reason naming the failing services / infrastructure;
 *   - sanitized infra rows (no raw notes, hosts, bucket names);
 *   - the dashboard panel being a pure projection of the same snapshot, so
 *     Dashboard and System Health always agree, and unknown is never down.
 */
import {
  buildServiceStatus,
  describeOverall,
  evaluateService,
  sanitizeInfra,
  SLOW_INFRA_MS,
  SLOW_SERVICE_MS,
} from "../../src/lib/service-status.js";
import type {
  HealthStatus,
  InfraHealth,
  ServiceHealth,
  SystemHealth,
} from "../../src/types/system-health.types.js";

const NOW = 1_789_440_000_000;

const svc = (
  key: string,
  status: ServiceHealth["status"] = "healthy",
  extra: Partial<ServiceHealth> = {}
): ServiceHealth => ({
  key,
  name: key,
  status,
  monitored: status !== "unknown",
  uptimePercent: null,
  latencyMs: status === "down" ? null : 20,
  breaker: null,
  lastChecked: NOW,
  ...extra,
});

const INFRA_NAMES: Record<string, string> = {
  database: "Database (PostgreSQL)",
  redis: "Redis",
  message_queue: "Message Queue (RabbitMQ)",
  object_storage: "Object Storage (MinIO)",
  mongodb: "Document Database (MongoDB)",
  antivirus: "Antivirus (ClamAV)",
  media_server: "Media Server (SRS)",
  livekit: "Calls SFU (LiveKit)",
};

const inf = (
  key: string,
  status: InfraHealth["status"] = "healthy",
  extra: Partial<InfraHealth> = {}
): InfraHealth => ({
  key,
  name: INFRA_NAMES[key],
  status,
  metrics: { latencyMs: status === "down" ? null : 5 },
  latencyMs: status === "down" ? null : 5,
  lastChecked: NOW,
  ...extra,
});

/** Healthy infrastructure with per-key overrides (`null` = not registered). */
const infra = (overrides: Record<string, InfraHealth | null> = {}): InfraHealth[] =>
  Object.keys(INFRA_NAMES)
    .map((k) => (k in overrides ? overrides[k] : inf(k)))
    .filter((i): i is InfraHealth => i !== null);

const evaluate = (
  row: ServiceHealth,
  overrides: Record<string, InfraHealth | null> = {}
) => evaluateService(row, infra(overrides));

const check = (row: ServiceHealth, key: string) =>
  row.checks?.find((c) => c.key === key);

describe("evaluateService — service status comes from the service's own check", () => {
  it("all checks healthy → healthy, no reason, dependencies listed", () => {
    const media = evaluate(svc("media"));
    expect(media.status).toBe("healthy");
    expect(media.reason).toBeUndefined();
    expect(media.checks?.map((c) => [c.key, c.critical, c.status])).toEqual([
      ["service", true, "healthy"],
      ["mongodb", true, "healthy"],
      ["object_storage", true, "healthy"],
      ["antivirus", false, "healthy"],
      ["redis", false, "healthy"],
      ["message_queue", false, "healthy"],
    ]);
  });

  it("MongoDB down while the services answer → every service stays healthy", () => {
    const mongoDown = { mongodb: inf("mongodb", "down", { note: "probe timed out after 2000ms" }) };
    for (const key of ["chat", "community", "media", "notification", "stream", "calls"]) {
      const row = evaluate(svc(key), mongoDown);
      expect(row.status).toBe("healthy");
      expect(row.reason).toBeUndefined();
      expect(check(row, "mongodb")).toMatchObject({
        status: "down",
        reason: "Health check timed out after 2000ms.",
      });
    }
  });

  it("a slow or down dependency alone never degrades the service", () => {
    expect(
      evaluate(svc("media"), { object_storage: inf("object_storage", "degraded", { latencyMs: 812 }) })
        .status
    ).toBe("healthy");
    const media = evaluate(svc("media"), { antivirus: inf("antivirus", "down") });
    expect(media.status).toBe("healthy");
    expect(check(media, "antivirus")?.reason).toBe("Unreachable.");
    expect(
      evaluate(svc("media"), { object_storage: inf("object_storage", "degraded", { latencyMs: 812 }) })
        .checks?.find((c) => c.key === "object_storage")?.reason
    ).toBe(`Response time 812ms exceeded the ${String(SLOW_INFRA_MS)}ms threshold.`);
  });

  it("service down with a failing dependency → down, and the dependency is named as a likely cause", () => {
    const media = evaluate(svc("media", "down", { note: "fetch failed" }), {
      object_storage: inf("object_storage", "down"),
    });
    expect(media.status).toBe("down");
    expect(media.reason).toBe(
      "Service endpoint: Unreachable. Dependency issues: Object Storage (MinIO) (down)."
    );
  });

  it("service unreachable → down", () => {
    const media = evaluate(svc("media", "down", { note: "fetch failed" }));
    expect(media.status).toBe("down");
    expect(media.reason).toBe("Service endpoint: Unreachable.");
  });

  it("health request timeout → down with the configured timeout", () => {
    expect(evaluate(svc("media", "down", { note: "probe timed out after 2000ms" })).reason).toBe(
      "Service endpoint: Health check timed out after 2000ms."
    );
    expect(
      evaluate(svc("media", "down", { note: "The operation was aborted due to timeout" })).reason
    ).toBe("Service endpoint: Health check timed out after 2000ms.");
  });

  it("non-2xx health endpoint → down with the status code", () => {
    expect(evaluate(svc("media", "down", { note: "HTTP 503" })).reason).toBe(
      "Service endpoint: Health check returned HTTP 503."
    );
  });

  it("open breaker → down; half-open breaker → degraded", () => {
    const open = evaluate(svc("chat", "down", { breaker: "open", note: "chat.getGroupCount unavailable" }));
    expect(open.status).toBe("down");
    expect(open.reason).toContain("Circuit breaker is open");

    const halfOpen = evaluate(svc("chat", "healthy", { breaker: "half-open" }));
    expect(halfOpen.status).toBe("degraded");
    expect(halfOpen.reason).toContain("half-open");
  });

  it("slow service → degraded only above the threshold", () => {
    expect(evaluate(svc("media", "healthy", { latencyMs: 900 })).status).toBe("healthy");
    const slow = evaluate(svc("media", "degraded", { latencyMs: 1500 }));
    expect(slow.status).toBe("degraded");
    expect(slow.reason).toBe(
      `Service endpoint: Response time 1500ms exceeded the ${String(SLOW_SERVICE_MS)}ms threshold.`
    );
  });

  it("malformed dependency response → an unexpected response", () => {
    const stream = evaluate(svc("stream"), {
      media_server: inf("media_server", "down", { note: "Unexpected token < in JSON" }),
    });
    expect(check(stream, "media_server")?.reason).toBe("Health check returned an unexpected response.");
  });

  it("recovers to healthy once the endpoint answers again", () => {
    expect(evaluate(svc("media", "down", { note: "fetch failed" })).status).toBe("down");
    const recovered = evaluate(svc("media"));
    expect(recovered.status).toBe("healthy");
    expect(recovered.reason).toBeUndefined();
  });

  it("an optional dependency not registered here is simply not listed", () => {
    expect(check(evaluate(svc("media"), { antivirus: null }), "antivirus")).toBeUndefined();
  });

  it("no probe → unknown and still unmonitored", () => {
    const row = evaluate(svc("media", "unknown"));
    expect(row.status).toBe("unknown");
    expect(row.monitored).toBe(false);
  });

  it("drops the raw note", () => {
    const row = evaluate(svc("media", "down", { note: "connect ECONNREFUSED 10.0.127.227:3009" }));
    expect(row.note).toBeUndefined();
    expect(JSON.stringify(row)).not.toMatch(/10\.0\.127\.227|ECONNREFUSED/);
  });
});

describe("describeOverall", () => {
  it("healthy → no reason", () => {
    expect(describeOverall([svc("chat")], infra())).toBeUndefined();
  });

  it("explains Degraded with 8/8 services up: the infrastructure component, by name", () => {
    expect(describeOverall([svc("chat"), svc("media")], infra({ mongodb: inf("mongodb", "down") }))).toBe(
      "1 infrastructure component unavailable: Document Database (MongoDB)."
    );
  });

  it("lists failing services and infrastructure separately; ignores unmonitored services", () => {
    expect(
      describeOverall(
        [svc("Chat Service", "down"), svc("Media Service", "degraded"), svc("x", "unknown")],
        infra({ redis: inf("redis", "degraded"), livekit: inf("livekit", "down"), mongodb: inf("mongodb", "down") })
      )
    ).toBe(
      "1 service down: Chat Service. 1 service degraded: Media Service. 2 infrastructure components unavailable: Document Database (MongoDB), Calls SFU (LiveKit). 1 infrastructure component degraded: Redis."
    );
  });
});

describe("sanitizeInfra", () => {
  it("replaces the raw note with a reason and removes location metrics", () => {
    const row = sanitizeInfra(
      inf("mongodb", "down", {
        note: "getaddrinfo ENOTFOUND mongodb://admin:s3cret@10.0.127.227",
        metrics: { latencyMs: null, engine: "mongodb", host: "10.0.127.227:27017" },
      })
    );
    expect(row).toMatchObject({ status: "down", reason: "Unreachable." });
    expect(row.metrics).toEqual({ latencyMs: null, engine: "mongodb" });
    expect(row.note).toBeUndefined();
    expect(JSON.stringify(row)).not.toMatch(/10\.0\.127\.227|s3cret|ENOTFOUND/);

    const storage = sanitizeInfra(
      inf("object_storage", "healthy", { metrics: { latencyMs: 5, bucket: "aimess-avatars" } })
    );
    expect(storage.metrics).toEqual({ latencyMs: 5 });
    expect(storage.reason).toBeUndefined();
  });
});

describe("buildServiceStatus — Dashboard is a projection of the System Health snapshot", () => {
  const ALL_KEYS = ["auth", "community", "chat", "calls", "user", "media", "notification", "stream"];
  const PANEL_TO_PROBE: Record<string, string> = {
    auth: "auth",
    chat: "chat",
    community: "community",
    media: "media",
    notification: "notification",
    livestream: "stream",
  };

  /** Exactly what getSystemHealth builds from raw probe rows. */
  const snapshot = (
    rawServices: ServiceHealth[],
    rawInfra = infra(),
    overall: HealthStatus = "healthy"
  ): SystemHealth => {
    const services = rawServices.map((s) => evaluateService(s, rawInfra));
    const infrastructure = rawInfra.map(sanitizeInfra);
    return {
      schemaVersion: 2,
      overall,
      overallReason: describeOverall(services, infrastructure),
      servicesUp: { up: 0, total: 0, label: "0/0" },
      lastUpdated: NOW,
      services,
      infrastructure,
    };
  };

  const healthyServices = () => ALL_KEYS.map((k) => svc(k));
  const withService = (key: string, row: ServiceHealth) =>
    healthyServices().map((s) => (s.key === key ? row : s));

  /** Every dashboard row must carry the same status as its System Health row. */
  function expectSameStatuses(health: SystemHealth) {
    const panel = buildServiceStatus(health);
    for (const row of panel.services) {
      const shRow = health.services.find((s) => s.key === PANEL_TO_PROBE[row.key]);
      const expected = shRow?.status === "healthy" ? "operational" : (shRow?.status ?? "unknown");
      expect([row.key, row.status]).toEqual([row.key, expected]);
    }
    return panel;
  }

  it("lists the six panel services in order", () => {
    expect(buildServiceStatus(snapshot(healthyServices())).services.map((s) => s.key)).toEqual([
      "auth",
      "chat",
      "community",
      "media",
      "notification",
      "livestream",
    ]);
  });

  it("1. all healthy → both screens operational", () => {
    const panel = expectSameStatuses(snapshot(healthyServices()));
    expect(panel.services.every((s) => s.status === "operational")).toBe(true);
    expect(panel.overall).toBe("operational");
    expect(panel.overallReason).toBeUndefined();
  });

  it("2. Chat actually down → Down on both screens", () => {
    const panel = expectSameStatuses(
      snapshot(withService("chat", svc("chat", "down", { note: "fetch failed" })), infra(), "degraded")
    );
    expect(panel.services.find((s) => s.key === "chat")?.status).toBe("down");
    expect(panel.overallReason).toBe("1 service down: chat.");
  });

  it("3. MongoDB down, services healthy → services operational, overall degraded with reason", () => {
    const panel = expectSameStatuses(
      snapshot(healthyServices(), infra({ mongodb: inf("mongodb", "down") }), "degraded")
    );
    expect(panel.services.every((s) => s.status === "operational")).toBe(true);
    expect(panel.overall).toBe("degraded");
    expect(panel.overallReason).toBe("1 infrastructure component unavailable: Document Database (MongoDB).");
  });

  it("4. health aggregator unavailable → unknown everywhere, never down", () => {
    const panel = buildServiceStatus(null);
    expect(panel.overall).toBe("unknown");
    expect(panel.overallReason).toBe("Health information is temporarily unavailable.");
    expect(panel.services).toHaveLength(6);
    expect(panel.services.every((s) => s.status === "unknown" && s.checkedAt === null)).toBe(true);
  });

  it("5. service degraded → Degraded on both screens", () => {
    const panel = expectSameStatuses(
      snapshot(withService("media", svc("media", "degraded", { latencyMs: 1500 })), infra(), "degraded")
    );
    expect(panel.services.find((s) => s.key === "media")?.status).toBe("degraded");
  });

  it("6. recovery → both screens operational again", () => {
    expectSameStatuses(snapshot(withService("media", svc("media", "down", { note: "fetch failed" }))));
    const panel = expectSameStatuses(snapshot(healthyServices()));
    expect(panel.services.find((s) => s.key === "media")?.status).toBe("operational");
  });

  it("7. backend timeout on a service probe → Down (its own check failed), shown the same", () => {
    const panel = expectSameStatuses(
      snapshot(withService("stream", svc("stream", "down", { note: "probe timed out after 2000ms" })))
    );
    expect(panel.services.find((s) => s.key === "livestream")?.status).toBe("down");
  });

  it("a missing probe row → unknown, not down", () => {
    const panel = buildServiceStatus(snapshot([svc("auth")]));
    expect(panel.services.find((s) => s.key === "media")).toMatchObject({ status: "unknown", checkedAt: null });
  });

  it("carries the restarting flag from the snapshot", () => {
    const health = snapshot(healthyServices());
    health.services = health.services.map((s) => (s.key === "media" ? { ...s, restarting: true } : s));
    const panel = buildServiceStatus(health);
    expect(panel.services.find((s) => s.key === "media")?.restarting).toBe(true);
    expect(panel.services.find((s) => s.key === "chat")?.restarting).toBe(false);
  });

  it("the panel carries no diagnostics or infrastructure details", () => {
    const json = JSON.stringify(
      buildServiceStatus(snapshot(healthyServices(), infra({ mongodb: inf("mongodb", "down", { note: "x 10.0.127.227" }) })))
    );
    expect(json).not.toMatch(/10\.0\.127\.227|"checks"|"note"|"metrics"/);
  });
});
