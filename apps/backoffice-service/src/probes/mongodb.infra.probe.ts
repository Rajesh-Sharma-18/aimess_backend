import { probeMongo } from "../lib/health-probes.js";
import type { InfraProbeDef } from "../lib/health-registry.js";

/** MongoDB (chat-service's message store) reachability. */
export const mongodbInfraProbe: InfraProbeDef = {
  key: "mongodb",
  name: "Chat Database (MongoDB)",
  probe: probeMongo,
};
