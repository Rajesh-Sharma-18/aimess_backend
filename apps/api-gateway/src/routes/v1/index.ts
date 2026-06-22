import { Router, type IRouter } from "express";

import { createServiceProxy } from "../../proxy/create-service-proxy.js";
import {
  sensitiveAuthRateLimiter,
  inviteLinkPreviewRateLimiter,
} from "../../middleware/rate-limit.js";
import { getServicesForVersion } from "../../versioning/registry.js";
import { env } from "../../config/env.js";
import { appVersionRouter } from "./app-version.routes.js";
import { createWebRtcRouter } from "./webrtc.routes.js";
import { createLegacyUploadsRouter } from "./legacy-uploads.routes.js";
import type { MessagingClient } from "../../grpc/clients/messaging.client.js";

export function createV1Router(messagingClient: MessagingClient): IRouter {
  const v1Router: IRouter = Router();

  v1Router.use("/app-version", appVersionRouter);
  v1Router.use("/webrtc", createWebRtcRouter(messagingClient));

  // Stable alias: POST /api/v1/users/uploads/url is forwarded to media-service's
  // POST /api/v1/media/upload-url. Registered BEFORE the generic `/users` proxy
  // below so it intercepts that one path. Only mounted when media-service is
  // configured (mirrors its proxy mount).
  if (env.MEDIA_SERVICE_URL) {
    v1Router.use(createLegacyUploadsRouter(env.MEDIA_SERVICE_URL));
  }

  // Dedicated limiter for the public invite-link preview endpoint (unauthenticated,
  // enumeration risk). Must be registered before the generic service proxy.
  v1Router.use("/communities/invite-links", inviteLinkPreviewRateLimiter);

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
