import { probeLiveKit } from "../lib/health-probes.js";
import type { InfraProbeDef } from "../lib/health-registry.js";

/** LiveKit SFU — carries 1:1 and group calls. */
export const livekitInfraProbe: InfraProbeDef = {
  key: "livekit",
  name: "Calls SFU (LiveKit)",
  probe: probeLiveKit,
};
