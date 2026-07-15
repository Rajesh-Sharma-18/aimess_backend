import {
  communityClient,
  getCommunityCountBreaker,
} from "../grpc/community.client.js";
import { probeService } from "../lib/health-probes.js";
import type { ServiceProbeDef } from "../lib/health-registry.js";

/** Community Service — probed live via the same gRPC call the dashboard already issues. */
export const communityServiceProbe: ServiceProbeDef = {
  key: "community",
  name: "Community Service",
  probe: () =>
    probeService({
      key: "community",
      name: "Community Service",
      breakers: [getCommunityCountBreaker],
      ping: () => communityClient.getCommunityCount(),
    }),
};
