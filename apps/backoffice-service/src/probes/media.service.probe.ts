import { env } from "../config/env.js";
import { probeHttpService } from "../lib/health-probes.js";
import type { ServiceProbeDef } from "../lib/health-registry.js";

/** Media Service — probed via its HTTP `/health` endpoint. */
export const mediaServiceProbe: ServiceProbeDef = {
  key: "media",
  name: "Media Service",
  probe: () =>
    probeHttpService({
      key: "media",
      name: "Media Service",
      url: env.MEDIA_HTTP_URL,
    }),
};
