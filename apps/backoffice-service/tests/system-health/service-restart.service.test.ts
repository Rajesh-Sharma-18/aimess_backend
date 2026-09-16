/**
 * Service restart orchestration (services/service-restart.service.ts) and the
 * restart policy (lib/service-restart.ts). Redis is an in-memory fake with real
 * SET NX / EX / PTTL semantics, the agent and System Health are mocked, and the
 * health deadline is shortened, so every path runs for real: success, agent
 * failure, health never recovering, dependency failures, duplicate and
 * concurrent requests, cooldown, interruption and the audit trail.
 */
jest.mock("../../src/config/redis.js", () => {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string) => {
    const entry = store.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    redis: {
      status: "ready",
      store,
      get: jest.fn(async (key: string) => live(key)?.value ?? null),
      set: jest.fn(async (key: string, value: string, ...args: (string | number)[]) => {
        let ttlSec: number | null = null;
        let nx = false;
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === "EX") ttlSec = Number(args[++i]);
          else if (args[i] === "NX") nx = true;
        }
        if (nx && live(key)) return null;
        store.set(key, {
          value,
          expiresAt: ttlSec === null ? null : Date.now() + ttlSec * 1000,
        });
        return "OK";
      }),
      del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
      pttl: jest.fn(async (key: string) => {
        const entry = live(key);
        if (!entry) return -2;
        return entry.expiresAt === null ? -1 : entry.expiresAt - Date.now();
      }),
    },
    connectBackofficeRedis: jest.fn(async () => undefined),
  };
});
jest.mock("../../src/lib/service-restart.js", () => ({
  ...jest.requireActual("../../src/lib/service-restart.js"),
  isRestartAgentConfigured: jest.fn(() => true),
  requestAgentRestart: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/system-health.service.js", () => ({
  systemHealthService: { getSystemHealth: jest.fn() },
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => ({ id: "audit-row" })) },
}));

import { redis } from "../../src/config/redis.js";
import {
  isRestartAgentConfigured,
  requestAgentRestart,
  restartAdvice,
} from "../../src/lib/service-restart.js";
import { auditService } from "../../src/services/audit.service.js";
import { serviceRestartService } from "../../src/services/service-restart.service.js";
import { systemHealthService } from "../../src/services/system-health.service.js";
import type {
  HealthCheck,
  ServiceHealth,
  SystemHealth,
} from "../../src/types/system-health.types.js";

const getSystemHealth = systemHealthService.getSystemHealth as jest.Mock;
const agentRestart = requestAgentRestart as jest.Mock;
const agentConfigured = isRestartAgentConfigured as jest.Mock;
const auditRecord = auditService.record as jest.Mock;
const store = (redis as unknown as { store: Map<string, unknown> }).store;

const ADMIN = "11111111-1111-4111-8111-111111111111";
const CTX = { ip: "203.0.113.7", userAgent: "jest", requestId: "req-123" };
const FAST = { pollIntervalMs: 5, timeoutMs: 80 };

const check = (
  key: string,
  name: string,
  status: HealthCheck["status"],
  critical = true
): HealthCheck => ({
  key,
  name,
  status,
  critical,
  responseTimeMs: status === "down" ? null : 10,
  ...(status === "healthy" ? {} : { reason: "Unreachable." }),
});

const media = (
  status: ServiceHealth["status"],
  own: HealthCheck["status"],
  minio: HealthCheck["status"] = "healthy"
): ServiceHealth => ({
  key: "media",
  name: "Media Service",
  status,
  monitored: true,
  uptimePercent: null,
  latencyMs: own === "down" ? null : 20,
  breaker: null,
  lastChecked: Date.now(),
  checks: [
    check("service", "Service endpoint", own),
    check("mongodb", "Document Database (MongoDB)", "healthy"),
    check("object_storage", "Object Storage (MinIO)", minio),
  ],
});

const snapshot = (...services: ServiceHealth[]): SystemHealth => ({
  schemaVersion: 2,
  overall: "degraded",
  servicesUp: { up: 0, total: 0, label: "" },
  lastUpdated: Date.now(),
  services: [
    ...services,
    {
      key: "calls",
      name: "Calling",
      status: "down",
      monitored: true,
      uptimePercent: null,
      latencyMs: null,
      breaker: null,
      lastChecked: Date.now(),
      checks: [check("service", "Service endpoint", "down")],
    },
  ],
  infrastructure: [],
});

const MEDIA_DOWN = snapshot(media("down", "down"));
const MEDIA_HEALTHY = snapshot(media("healthy", "healthy"));

/** Wait for the background run to leave the in-flight states. */
async function settled(key = "media") {
  for (let i = 0; i < 200; i += 1) {
    const { services } = await serviceRestartService.listRestarts();
    const op = services.find((s) => s.key === key)?.operation;
    if (op && (op.status === "succeeded" || op.status === "failed")) return op;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("restart did not settle");
}

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  agentConfigured.mockReturnValue(true);
  agentRestart.mockResolvedValue(undefined);
});

describe("restartAdvice", () => {
  it("operational service → nothing to do", () => {
    expect(restartAdvice(media("healthy", "healthy")).action).toBe("none");
  });

  it("the service's own endpoint down with healthy dependencies → restart", () => {
    expect(restartAdvice(media("down", "down"))).toEqual({
      action: "restart",
      affectedComponents: ["Media Service"],
    });
  });

  it("slow service with healthy dependencies (degraded) → restart", () => {
    expect(restartAdvice(media("degraded", "degraded")).action).toBe("restart");
  });

  it("degraded or down because of a dependency → investigate that dependency", () => {
    expect(restartAdvice(media("down", "healthy", "down"))).toEqual({
      action: "investigate_dependency",
      affectedComponents: ["Object Storage (MinIO)"],
    });
    // Even with the endpoint failing too, the dependency is the thing to fix.
    expect(restartAdvice(media("down", "down", "down")).action).toBe("investigate_dependency");
  });

  it("no probe → investigate", () => {
    expect(
      restartAdvice({ ...media("unknown", "unknown"), checks: [check("service", "Service endpoint", "unknown")] })
        .action
    ).toBe("investigate");
  });
});

describe("serviceRestartService", () => {
  it("restart → verified healthy → succeeded, with both audit rows", async () => {
    getSystemHealth.mockResolvedValueOnce(MEDIA_DOWN).mockResolvedValue(MEDIA_HEALTHY);

    const accepted = await serviceRestartService.startRestart("media", ADMIN, CTX, FAST);
    expect(accepted).toMatchObject({ status: "requested", previousStatus: "down", serviceName: "Media Service" });

    const op = await settled();
    expect(op).toMatchObject({ status: "succeeded", finalStatus: "healthy", reason: null });
    expect(op.restartedAt).not.toBeNull();
    expect(op.completedAt).not.toBeNull();
    // Only the allowlisted compose service name reaches the agent.
    expect(agentRestart).toHaveBeenCalledTimes(1);
    expect(agentRestart).toHaveBeenCalledWith("media-service");

    expect(auditRecord).toHaveBeenCalledTimes(2);
    const [requested, completed] = auditRecord.mock.calls.map((c) => c[0]);
    expect(requested).toMatchObject({
      actorId: ADMIN,
      action: "system.service_restart_requested",
      targetType: "service",
      targetId: "media-service",
      ip: CTX.ip,
      after: { service: "media-service", previousStatus: "down", requestId: "req-123", result: "requested" },
    });
    expect(completed).toMatchObject({
      actorId: ADMIN,
      action: "system.service_restart_completed",
      after: { result: "succeeded", finalStatus: "healthy", requestId: "req-123" },
    });
    expect(completed.after.completedAt).toEqual(expect.any(String));
  });

  it("restart completes but health never recovers → failed, not a false success", async () => {
    getSystemHealth.mockResolvedValue(MEDIA_DOWN);
    await serviceRestartService.startRestart("media", ADMIN, CTX, FAST);
    const op = await settled();
    expect(op.status).toBe("failed");
    expect(op.restartedAt).not.toBeNull();
    expect(op.finalStatus).toBe("down");
    expect(op.reason).toMatch(/restart was triggered, but the service did not become healthy/);
  });

  it("restart completes but the service stays degraded → failed", async () => {
    getSystemHealth
      .mockResolvedValueOnce(MEDIA_DOWN)
      .mockResolvedValue(snapshot(media("degraded", "healthy", "down")));
    await serviceRestartService.startRestart("media", ADMIN, CTX, FAST);
    const op = await settled();
    expect(op).toMatchObject({ status: "failed", finalStatus: "degraded" });
  });

  it("agent cannot restart → failed with a safe reason, no health polling", async () => {
    agentRestart.mockRejectedValue(new Error("connect EACCES /var/run/docker.sock"));
    getSystemHealth.mockResolvedValue(MEDIA_DOWN);
    await serviceRestartService.startRestart("media", ADMIN, CTX, FAST);
    const op = await settled();
    expect(op).toMatchObject({
      status: "failed",
      restartedAt: null,
      reason: "The service manager could not restart the service.",
    });
    expect(JSON.stringify(op)).not.toContain("docker.sock");
    expect(getSystemHealth).toHaveBeenCalledTimes(3); // start + the two settle() reads
  });

  it("duplicate / concurrent requests → exactly one restart", async () => {
    getSystemHealth.mockResolvedValue(MEDIA_DOWN);
    agentRestart.mockImplementation(() => new Promise((r) => setTimeout(r, 30)));

    const results = await Promise.allSettled([
      serviceRestartService.startRestart("media", ADMIN, CTX, FAST),
      serviceRestartService.startRestart("media", "22222222-2222-4222-8222-222222222222", CTX, FAST),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { statusCode: 409, messageKey: "ADMIN_SERVICE_RESTART_IN_PROGRESS" },
    });

    // And again while the first is still running.
    await expect(serviceRestartService.startRestart("media", ADMIN, CTX, FAST)).rejects.toMatchObject({
      statusCode: 409,
    });
    await settled();
    expect(agentRestart).toHaveBeenCalledTimes(1);
  });

  it("cooldown after a restart → 429 with Retry-After", async () => {
    getSystemHealth.mockResolvedValueOnce(MEDIA_DOWN).mockResolvedValue(MEDIA_HEALTHY);
    await serviceRestartService.startRestart("media", ADMIN, CTX, FAST);
    await settled();

    getSystemHealth.mockResolvedValue(MEDIA_DOWN);
    const error = await serviceRestartService.startRestart("media", ADMIN, CTX, FAST).catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 429, messageKey: "ADMIN_SERVICE_RESTART_COOLDOWN" });
    expect((error as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(290);

    const { services } = await serviceRestartService.listRestarts();
    expect(services.find((s) => s.key === "media")?.cooldownUntil).toEqual(expect.any(Number));
  });

  it("operational service or dependency failure → refused, lock released", async () => {
    getSystemHealth.mockResolvedValue(MEDIA_HEALTHY);
    await expect(serviceRestartService.startRestart("media", ADMIN, CTX, FAST)).rejects.toMatchObject({
      statusCode: 409,
      messageKey: "ADMIN_SERVICE_RESTART_NOT_RECOMMENDED",
    });
    getSystemHealth.mockResolvedValue(snapshot(media("degraded", "healthy", "down")));
    await expect(serviceRestartService.startRestart("media", ADMIN, CTX, FAST)).rejects.toMatchObject({
      messageKey: "ADMIN_SERVICE_RESTART_NOT_RECOMMENDED",
    });
    expect(agentRestart).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();

    // The refusals left no lock behind.
    getSystemHealth.mockResolvedValueOnce(MEDIA_DOWN).mockResolvedValue(MEDIA_HEALTHY);
    await expect(serviceRestartService.startRestart("media", ADMIN, CTX, FAST)).resolves.toMatchObject({
      status: "requested",
    });
    await settled();
  });

  it("unknown or non-allowlisted service → 404, nothing touched", async () => {
    getSystemHealth.mockResolvedValue(MEDIA_DOWN);
    for (const key of ["backoffice", "api-gateway", "calls", "constructor", "__proto__", "aimess-media-service"]) {
      await expect(serviceRestartService.startRestart(key, ADMIN, CTX, FAST)).rejects.toMatchObject({
        statusCode: 404,
      });
    }
    expect(agentRestart).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("no restart agent in this environment → 503 and restartable:false", async () => {
    agentConfigured.mockReturnValue(false);
    getSystemHealth.mockResolvedValue(MEDIA_DOWN);
    await expect(serviceRestartService.startRestart("media", ADMIN, CTX, FAST)).rejects.toMatchObject({
      statusCode: 503,
      messageKey: "ADMIN_SERVICE_RESTART_UNSUPPORTED",
    });
    const { enabled, services } = await serviceRestartService.listRestarts();
    expect(enabled).toBe(false);
    expect(services.find((s) => s.key === "media")).toMatchObject({
      restartable: false,
      unavailableReason: "environment",
      advice: { action: "restart" },
    });
  });

  it("list: Calling needs a manual restart; operations never expose audit context", async () => {
    getSystemHealth.mockResolvedValueOnce(MEDIA_DOWN).mockResolvedValue(MEDIA_HEALTHY);
    await serviceRestartService.startRestart("media", ADMIN, CTX, FAST);
    await settled();

    const { services } = await serviceRestartService.listRestarts();
    expect(services.find((s) => s.key === "calls")).toMatchObject({
      restartable: false,
      unavailableReason: "manual",
      operation: null,
    });
    const json = JSON.stringify(services);
    for (const hidden of [ADMIN, "req-123", CTX.ip, "adminId", "userAgent"]) {
      expect(json).not.toContain(hidden);
    }
  });

  it("an in-flight operation whose runner died reads as interrupted (browser refresh safe)", async () => {
    getSystemHealth.mockResolvedValue(MEDIA_DOWN);
    store.set("backoffice:service-restart:op:media", {
      value: JSON.stringify({
        id: "op-1",
        serviceKey: "media",
        serviceName: "Media Service",
        status: "verifying",
        previousStatus: "down",
        requestedAt: Date.now() - 10_000,
        restartedAt: Date.now() - 5_000,
        completedAt: null,
        finalStatus: null,
        reason: null,
        adminId: ADMIN,
        requestId: null,
        ip: "x",
        userAgent: null,
      }),
      expiresAt: null,
    });
    const { services } = await serviceRestartService.listRestarts();
    expect(services.find((s) => s.key === "media")?.operation).toMatchObject({
      status: "failed",
      reason: "The restart was interrupted before it finished.",
    });
  });
});
