/**
 * Bootstrap wiring: every existing service/infrastructure probe is registered
 * exactly once, and calling the bootstrap again (e.g. a second `createApp()`)
 * is a safe no-op rather than a duplicate-registration crash.
 */
import {
  healthInfrastructureRegistry,
  healthServiceRegistry,
} from "../../src/lib/health-registry.js";
import { bootstrapHealthChecks } from "../../src/lib/health.bootstrap.js";

describe("bootstrapHealthChecks", () => {
  it("registers every existing service and infrastructure dependency", () => {
    bootstrapHealthChecks();

    expect(
      healthServiceRegistry
        .getServices()
        .map((s) => s.key)
        .sort()
    ).toEqual(
      [
        "auth",
        "calls",
        "chat",
        "community",
        "media",
        "notification",
        "stream",
        "user",
      ].sort()
    );
    expect(
      healthInfrastructureRegistry
        .getInfrastructure()
        .map((i) => i.key)
        .sort()
    ).toEqual(
      [
        "antivirus",
        "database",
        "livekit",
        "media_server",
        "message_queue",
        "mongodb",
        "object_storage",
        "redis",
      ].sort()
    );
  });

  it("is idempotent — calling it again does not throw or duplicate entries", () => {
    bootstrapHealthChecks();
    bootstrapHealthChecks();

    expect(healthServiceRegistry.getServices()).toHaveLength(8);
    expect(healthInfrastructureRegistry.getInfrastructure()).toHaveLength(8);
  });
});
