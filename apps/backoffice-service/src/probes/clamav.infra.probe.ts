import { probeClamAv } from "../lib/health-probes.js";
import type { InfraProbeDef } from "../lib/health-registry.js";

/** ClamAV antivirus daemon — media uploads are scanned through it. */
export const clamavInfraProbe: InfraProbeDef = {
  key: "antivirus",
  name: "Antivirus (ClamAV)",
  probe: probeClamAv,
};
