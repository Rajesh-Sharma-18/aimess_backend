import { env } from "../config/env.js";
import { probeHttpService } from "../lib/health-probes.js";
import type { ServiceProbeDef } from "../lib/health-registry.js";

/** Notification Service — probed via its HTTP `/health` endpoint. */
export const notificationServiceProbe: ServiceProbeDef = {
  key: "notification",
  name: "Notification Service",
  probe: () =>
    probeHttpService({
      key: "notification",
      name: "Notification Service",
      url: env.NOTIFICATIONS_HTTP_URL,
    }),
};
