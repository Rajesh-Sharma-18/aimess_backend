import { probeRedis } from "../lib/health-probes.js";
import type { InfraProbeDef } from "../lib/health-registry.js";

/** Redis reachability. */
export const redisInfraProbe: InfraProbeDef = {
  key: "redis",
  name: "Redis",
  probe: probeRedis,
};
