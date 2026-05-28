import { Router, type IRouter } from "express";

import { createServiceProxy } from "../../proxy/create-service-proxy.js";
import { sensitiveAuthRateLimiter } from "../../middleware/rate-limit.js";
import { getServicesForVersion } from "../../versioning/registry.js";
import { appVersionRouter } from "./app-version.routes.js";
import { createWebRtcRouter } from "./webrtc.routes.js";
import type { MessagingClient } from "../../grpc/clients/messaging.client.js";

export function createV1Router(messagingClient: MessagingClient): IRouter {
  const v1Router: IRouter = Router();

  v1Router.use("/app-version", appVersionRouter);
  v1Router.use("/webrtc", createWebRtcRouter(messagingClient));

  // Stricter throttle on sensitive auth endpoints, applied before the generic
  // service proxy below. Must be registered ahead of the proxy mount so it runs
  // first on these paths.
  for (const sensitivePath of [
    "/auth/login",
    "/auth/forgot-password",
    "/auth/google",
    "/auth/apple",
  ]) {
    v1Router.use(sensitivePath, sensitiveAuthRateLimiter);
  }

  for (const service of getServicesForVersion("v1")) {
    v1Router.use(
      `/${service.segment}`,
      createServiceProxy({
        target: service.target,
        downstreamPrefix: service.downstreamPrefix,
        serviceName: service.segment,
      })
    );
  }

  return v1Router;
}
