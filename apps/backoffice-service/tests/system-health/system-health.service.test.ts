/**
 * System Health aggregation unit tests. The live probes are mocked so we can
 * drive every roll-up scenario deterministically: healthy, degraded (slow),
 * down (core-infra / total outage), partial failures, probe timeouts, and
 * service-unavailable. Also covers the pure `computeOverall` / `computeServicesUp`
 * helpers and confirms unmonitored services never skew the roll-up.
 */
jest.mock("../../src/lib/health-probes.js", () => ({
  probeServices: jest.fn(),
  probeInfrastructure: jest.fn(),
}));
// Local redis mock with a real get/set surface so the short cache is a clean
// no-op (miss → always run probes) instead of throwing through the global stub.
jest.mock("../../src/config/redis.js", () => ({
  redis: {
    status: "ready",
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
  },
  connectBackofficeRedis: jest.fn(async () => undefined),
}));

import {
  probeInfrastructure,
  probeServices,
} from "../../src/lib/health-probes.js";
import {
  computeOverall,
  computeServicesUp,
  systemHealthService,
} from "../../src/services/system-health.service.js";
import type {
  InfraHealth,
  ServiceHealth,
} from "../../src/types/system-health.types.js";

const probeServicesMock = probeServices as jest.Mock;
const probeInfraMock = probeInfrastructure as jest.Mock;

const svc = (
  key: string,
  status: ServiceHealth["status"],
  extra: Partial<ServiceHealth> = {}
): ServiceHealth => ({
  key,
  name: key,
  status,
  monitored: status !== "unknown",
  uptimePercent: null,
  latencyMs: status === "down" ? null : 10,
  breaker: null,
  lastChecked: "2026-07-03T00:00:00.000Z",
  ...extra,
});

const inf = (
  key: string,
  status: InfraHealth["status"],
  extra: Partial<InfraHealth> = {}
): InfraHealth => ({
  key,
  name: key,
  status,
  metrics: { latencyMs: status === "down" ? null : 5 },
  latencyMs: status === "down" ? null : 5,
  lastChecked: "2026-07-03T00:00:00.000Z",
  ...extra,
});

const HEALTHY_SERVICES = [
  svc("auth", "healthy"),
  svc("community", "healthy"),
  svc("chat", "healthy"),
  svc("media", "unknown"),
];
const HEALTHY_INFRA = [
  inf("database", "healthy"),
  inf("redis", "healthy"),
  inf("message_queue", "healthy"),
  inf("object_storage", "healthy"),
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe("computeServicesUp", () => {
  it("counts monitored services, ignoring unmonitored (unknown) ones", () => {
    expect(computeServicesUp(HEALTHY_SERVICES)).toEqual({
      up: 3,
      total: 3,
      label: "3/3",
    });
  });

  it("a degraded service still counts as up; a down service does not", () => {
    const services = [
      svc("auth", "healthy"),
      svc("community", "degraded"),
      svc("chat", "down"),
      svc("media", "unknown"),
    ];
    expect(computeServicesUp(services)).toEqual({
      up: 2,
      total: 3,
      label: "2/3",
    });
  });
});

describe("computeOverall", () => {
  it("healthy when every monitored component is healthy", () => {
    expect(computeOverall(HEALTHY_SERVICES, HEALTHY_INFRA)).toBe("healthy");
  });

  it("degraded when a non-core component is degraded", () => {
    const infra = [
      inf("database", "healthy"),
      inf("redis", "healthy"),
      inf("message_queue", "healthy"),
      inf("object_storage", "degraded"),
    ];
    expect(computeOverall(HEALTHY_SERVICES, infra)).toBe("degraded");
  });

  it("degraded on a partial service failure while core infra is up", () => {
    const services = [
      svc("auth", "healthy"),
      svc("community", "down"),
      svc("chat", "healthy"),
    ];
    expect(computeOverall(services, HEALTHY_INFRA)).toBe("degraded");
  });

  it("down when the database (core) is down", () => {
    const infra = [
      inf("database", "down"),
      inf("redis", "healthy"),
      inf("message_queue", "healthy"),
      inf("object_storage", "healthy"),
    ];
    expect(computeOverall(HEALTHY_SERVICES, infra)).toBe("down");
  });

  it("down when redis (core) is down", () => {
    const infra = [
      inf("database", "healthy"),
      inf("redis", "down"),
      inf("message_queue", "healthy"),
      inf("object_storage", "healthy"),
    ];
    expect(computeOverall(HEALTHY_SERVICES, infra)).toBe("down");
  });

  it("down on a total outage (every monitored component down)", () => {
    const services = [
      svc("auth", "down"),
      svc("community", "down"),
      svc("chat", "down"),
    ];
    const infra = [
      inf("database", "down"),
      inf("redis", "down"),
      inf("message_queue", "down"),
      inf("object_storage", "down"),
    ];
    expect(computeOverall(services, infra)).toBe("down");
  });

  it("unmonitored (unknown) services never force degraded/down", () => {
    const services = [svc("auth", "healthy"), svc("media", "unknown")];
    expect(computeOverall(services, HEALTHY_INFRA)).toBe("healthy");
  });
});

describe("systemHealthService.getSystemHealth", () => {
  it("assembles a healthy payload from the probes", async () => {
    probeServicesMock.mockResolvedValue(HEALTHY_SERVICES);
    probeInfraMock.mockResolvedValue(HEALTHY_INFRA);

    const result = await systemHealthService.getSystemHealth();

    expect(result.overall).toBe("healthy");
    expect(result.servicesUp).toEqual({ up: 3, total: 3, label: "3/3" });
    expect(result.services).toHaveLength(4);
    expect(result.infrastructure).toHaveLength(4);
    expect(typeof result.lastUpdated).toBe("number");
  });

  it("reports degraded + 2/3 up on a partial service failure", async () => {
    probeServicesMock.mockResolvedValue([
      svc("auth", "healthy"),
      svc("community", "down", {
        note: "community.getCommunityCount unavailable",
      }),
      svc("chat", "healthy"),
      svc("media", "unknown"),
    ]);
    probeInfraMock.mockResolvedValue(HEALTHY_INFRA);

    const result = await systemHealthService.getSystemHealth();

    expect(result.overall).toBe("degraded");
    expect(result.servicesUp).toEqual({ up: 2, total: 3, label: "2/3" });
  });

  it("maps a probe timeout to a down component (service-unavailable)", async () => {
    probeServicesMock.mockResolvedValue([
      svc("auth", "down", { note: "probe timed out after 2000ms" }),
      svc("community", "healthy"),
      svc("chat", "healthy"),
    ]);
    probeInfraMock.mockResolvedValue(HEALTHY_INFRA);

    const result = await systemHealthService.getSystemHealth();

    expect(result.overall).toBe("degraded");
    expect(result.servicesUp.up).toBe(2);
    expect(result.services[0].status).toBe("down");
    expect(result.services[0].note).toContain("timed out");
  });

  it("reports down when a core datastore probe fails", async () => {
    probeServicesMock.mockResolvedValue(HEALTHY_SERVICES);
    probeInfraMock.mockResolvedValue([
      inf("database", "down", { note: "connect ECONNREFUSED" }),
      inf("redis", "healthy"),
      inf("message_queue", "healthy"),
      inf("object_storage", "healthy"),
    ]);

    const result = await systemHealthService.getSystemHealth();

    expect(result.overall).toBe("down");
  });
});
