import { chatClient, adminGetCallHealthBreaker } from "../grpc/chat.client.js";
import { probeService } from "../lib/health-probes.js";
import type { ServiceProbeDef } from "../lib/health-registry.js";

/**
 * Calling — probed via `AdminGetCallHealth`, a two-count RPC kept deliberately
 * cheap so it fits the 2s probe budget.
 *
 * Distinct from the generic "Chat Service" probe: that one pings `getGroupCount`
 * and only tells you chat-service is reachable at all. This one exercises the
 * call path specifically and has its OWN breaker, so calling can report degraded
 * while the rest of chat-service is fine.
 */
export const callServiceProbe: ServiceProbeDef = {
  key: "calls",
  name: "Calling",
  probe: () =>
    probeService({
      key: "calls",
      name: "Calling",
      breakers: [adminGetCallHealthBreaker],
      ping: () => chatClient.adminGetCallHealth(),
    }),
};
