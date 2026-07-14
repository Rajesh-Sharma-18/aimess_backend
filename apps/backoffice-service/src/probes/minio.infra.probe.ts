import { probeObjectStorage } from "../lib/health-probes.js";
import type { InfraProbeDef } from "../lib/health-registry.js";

/** Object storage (MinIO) reachability. */
export const minioInfraProbe: InfraProbeDef = {
  key: "object_storage",
  name: "Object Storage (MinIO)",
  probe: probeObjectStorage,
};
