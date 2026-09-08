import { probeSrs } from "../lib/health-probes.js";
import type { InfraProbeDef } from "../lib/health-registry.js";

/** SRS media server — ingest/playback for livestreams. */
export const srsInfraProbe: InfraProbeDef = {
  key: "media_server",
  name: "Media Server (SRS)",
  probe: probeSrs,
};
