import { probePostgres } from "../lib/health-probes.js";
import type { InfraProbeDef } from "../lib/health-registry.js";

/** admin_db (PostgreSQL) reachability. */
export const postgresInfraProbe: InfraProbeDef = {
  key: "database",
  name: "Database (PostgreSQL)",
  probe: probePostgres,
};
