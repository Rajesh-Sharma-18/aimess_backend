import { env } from "../config/env.js";
import { probeHttpService } from "../lib/health-probes.js";
import type { ServiceProbeDef } from "../lib/health-registry.js";

/** User Service — probed via its HTTP `/health` endpoint. */
export const userServiceProbe: ServiceProbeDef = {
  key: "user",
  name: "User Service",
  probe: () =>
    probeHttpService({
      key: "user",
      name: "User Service",
      url: env.USER_HTTP_URL,
    }),
};
