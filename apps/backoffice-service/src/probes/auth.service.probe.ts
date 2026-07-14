import {
  authClient,
  getUserCountsBreaker,
  getActiveUserCountsBreaker,
} from "../grpc/auth.client.js";
import { probeService } from "../lib/health-probes.js";
import type { ServiceProbeDef } from "../lib/health-registry.js";

/** Auth Service — probed live via the same gRPC call the dashboard already issues. */
export const authServiceProbe: ServiceProbeDef = {
  key: "auth",
  name: "Auth Service",
  probe: () =>
    probeService({
      key: "auth",
      name: "Auth Service",
      breakers: [getUserCountsBreaker, getActiveUserCountsBreaker],
      ping: () => authClient.getUserCounts(),
    }),
};
