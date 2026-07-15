import { env } from "../config/env.js";
import { probeHttpService } from "../lib/health-probes.js";
import type { ServiceProbeDef } from "../lib/health-registry.js";

/** Livestream Service — probed via its HTTP `/health` endpoint. */
export const streamServiceProbe: ServiceProbeDef = {
  key: "stream",
  name: "Livestream Service",
  probe: () =>
    probeHttpService({
      key: "stream",
      name: "Livestream Service",
      url: env.STREAM_HTTP_URL,
    }),
};
