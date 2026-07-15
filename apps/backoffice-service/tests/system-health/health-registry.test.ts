/**
 * Registry unit tests: registration is one-time, listed in registration
 * order, and a service registered without a probe is a valid (unknown) entry.
 */
import {
  HealthInfrastructureRegistry,
  HealthServiceRegistry,
} from "../../src/lib/health-registry.js";

describe("HealthServiceRegistry", () => {
  it("lists every registered service", () => {
    const registry = new HealthServiceRegistry();
    registry.registerService({ key: "auth", name: "Auth Service" });
    registry.registerService({
      key: "chat",
      name: "Chat Service",
      probe: async () => ({
        key: "chat",
        name: "Chat Service",
        status: "healthy",
        monitored: true,
        uptimePercent: 100,
        latencyMs: 5,
        breaker: null,
        lastChecked: Date.now(),
      }),
    });

    const entries = registry.getServices();
    expect(entries.map((e) => e.key)).toEqual(["auth", "chat"]);
    expect(entries[0].probe).toBeUndefined();
    expect(entries[1].probe).toBeInstanceOf(Function);
  });

  it("rejects registering the same key twice", () => {
    const registry = new HealthServiceRegistry();
    registry.registerService({ key: "auth", name: "Auth Service" });
    expect(() =>
      registry.registerService({ key: "auth", name: "Auth Service (dup)" })
    ).toThrow(/already registered/);
  });
});

describe("HealthInfrastructureRegistry", () => {
  it("lists every registered infrastructure dependency", () => {
    const registry = new HealthInfrastructureRegistry();
    registry.registerInfrastructure({
      key: "redis",
      name: "Redis",
      probe: async () => ({
        key: "redis",
        name: "Redis",
        status: "healthy",
        metrics: {},
        latencyMs: 1,
        lastChecked: Date.now(),
      }),
    });

    expect(registry.getInfrastructure().map((e) => e.key)).toEqual(["redis"]);
  });

  it("rejects registering the same key twice", () => {
    const registry = new HealthInfrastructureRegistry();
    const probe = async () => ({
      key: "redis",
      name: "Redis",
      status: "healthy" as const,
      metrics: {},
      latencyMs: 1,
      lastChecked: Date.now(),
    });
    registry.registerInfrastructure({ key: "redis", name: "Redis", probe });
    expect(() =>
      registry.registerInfrastructure({ key: "redis", name: "Redis 2", probe })
    ).toThrow(/already registered/);
  });
});
