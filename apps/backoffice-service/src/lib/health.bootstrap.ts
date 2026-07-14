import {
  healthInfrastructureRegistry,
  healthServiceRegistry,
} from "./health-registry.js";
import { authServiceProbe } from "../probes/auth.service.probe.js";
import { communityServiceProbe } from "../probes/community.service.probe.js";
import { chatServiceProbe } from "../probes/chat.service.probe.js";
import { userServiceProbe } from "../probes/user.service.probe.js";
import { mediaServiceProbe } from "../probes/media.service.probe.js";
import { notificationServiceProbe } from "../probes/notification.service.probe.js";
import { streamServiceProbe } from "../probes/stream.service.probe.js";
import { postgresInfraProbe } from "../probes/postgres.infra.probe.js";
import { redisInfraProbe } from "../probes/redis.infra.probe.js";
import { rabbitmqInfraProbe } from "../probes/rabbitmq.infra.probe.js";
import { minioInfraProbe } from "../probes/minio.infra.probe.js";

/**
 * Single source of truth for "which components does System Health monitor".
 * Runs once at app startup, before routes are mounted. Adding a new
 * microservice or infrastructure dependency needs exactly two steps:
 *   1. Create its probe file under `src/probes/`.
 *   2. Register it here.
 * No other file (controller, service, response builder, registry) changes.
 */
let bootstrapped = false;

export function bootstrapHealthChecks(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  healthServiceRegistry.registerService(authServiceProbe);
  healthServiceRegistry.registerService(communityServiceProbe);
  healthServiceRegistry.registerService(chatServiceProbe);
  healthServiceRegistry.registerService(userServiceProbe);
  healthServiceRegistry.registerService(mediaServiceProbe);
  healthServiceRegistry.registerService(notificationServiceProbe);
  healthServiceRegistry.registerService(streamServiceProbe);

  healthInfrastructureRegistry.registerInfrastructure(postgresInfraProbe);
  healthInfrastructureRegistry.registerInfrastructure(redisInfraProbe);
  healthInfrastructureRegistry.registerInfrastructure(rabbitmqInfraProbe);
  healthInfrastructureRegistry.registerInfrastructure(minioInfraProbe);
}
