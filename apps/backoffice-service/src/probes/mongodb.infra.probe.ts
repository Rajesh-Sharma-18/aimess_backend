import { probeMongo } from "../lib/health-probes.js";
import type { InfraProbeDef } from "../lib/health-registry.js";

/**
 * MongoDB reachability. One row covers the whole instance, which holds
 * aimess_chat, aimess_notifications, aimess_media and community_db — the
 * probe is a TCP connect, so it cannot tell those databases apart anyway.
 */
export const mongodbInfraProbe: InfraProbeDef = {
  key: "mongodb",
  name: "Document Database (MongoDB)",
  probe: probeMongo,
};
