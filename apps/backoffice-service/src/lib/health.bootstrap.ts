import {
  healthInfrastructureRegistry,
  healthServiceRegistry,
} from "./health-registry.js";
import { env } from "../config/env.js";
import { authServiceProbe } from "../probes/auth.service.probe.js";
import { communityServiceProbe } from "../probes/community.service.probe.js";
import { chatServiceProbe } from "../probes/chat.service.probe.js";
import { callServiceProbe } from "../probes/call.service.probe.js";
import { userServiceProbe } from "../probes/user.service.probe.js";
import { mediaServiceProbe } from "../probes/media.service.probe.js";
import { notificationServiceProbe } from "../probes/notification.service.probe.js";
import { streamServiceProbe } from "../probes/stream.service.probe.js";
import { postgresInfraProbe } from "../probes/postgres.infra.probe.js";
import { redisInfraProbe } from "../probes/redis.infra.probe.js";
import { rabbitmqInfraProbe } from "../probes/rabbitmq.infra.probe.js";
import { minioInfraProbe } from "../probes/minio.infra.probe.js";
import { mongodbInfraProbe } from "../probes/mongodb.infra.probe.js";
import { clamavInfraProbe } from "../probes/clamav.infra.probe.js";
import { srsInfraProbe } from "../probes/srs.infra.probe.js";
import { livekitInfraProbe } from "../probes/livekit.infra.probe.js";

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
  // Calling has its own probe/breaker so it can report degraded independently
  // of the rest of chat-service.
  healthServiceRegistry.registerService(callServiceProbe);
  healthServiceRegistry.registerService(userServiceProbe);
  healthServiceRegistry.registerService(mediaServiceProbe);
  healthServiceRegistry.registerService(notificationServiceProbe);
  healthServiceRegistry.registerService(streamServiceProbe);

  healthInfrastructureRegistry.registerInfrastructure(postgresInfraProbe);
  healthInfrastructureRegistry.registerInfrastructure(redisInfraProbe);
  healthInfrastructureRegistry.registerInfrastructure(rabbitmqInfraProbe);
  healthInfrastructureRegistry.registerInfrastructure(minioInfraProbe);
  healthInfrastructureRegistry.registerInfrastructure(mongodbInfraProbe);
  // ClamAV is optional infrastructure: it is off in environments that do not
  // scan uploads. Registering it there would report a component nobody runs as
  // Down forever, so skip the probe rather than emit a permanently red row.
  if (env.CLAMAV_ENABLED) {
    healthInfrastructureRegistry.registerInfrastructure(clamavInfraProbe);
  }
  healthInfrastructureRegistry.registerInfrastructure(srsInfraProbe);
  healthInfrastructureRegistry.registerInfrastructure(livekitInfraProbe);
}
