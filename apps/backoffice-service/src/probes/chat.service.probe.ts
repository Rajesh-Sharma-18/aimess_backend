import { chatClient, getGroupCountBreaker } from "../grpc/chat.client.js";
import { probeService } from "../lib/health-probes.js";
import type { ServiceProbeDef } from "../lib/health-registry.js";

/** Chat Service — probed live via the same gRPC call the dashboard already issues. */
export const chatServiceProbe: ServiceProbeDef = {
  key: "chat",
  name: "Chat Service",
  probe: () =>
    probeService({
      key: "chat",
      name: "Chat Service",
      breakers: [getGroupCountBreaker],
      ping: () => chatClient.getGroupCount(),
    }),
};
