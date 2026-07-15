import { probeRabbitMq } from "../lib/health-probes.js";
import type { InfraProbeDef } from "../lib/health-registry.js";

/** RabbitMQ reachability. */
export const rabbitmqInfraProbe: InfraProbeDef = {
  key: "message_queue",
  name: "Message Queue (RabbitMQ)",
  probe: probeRabbitMq,
};
