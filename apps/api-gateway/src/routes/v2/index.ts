import { Router, type IRouter } from "express";

import { createServiceProxy } from "../../proxy/create-service-proxy.js";
import { getServicesForVersion } from "../../versioning/registry.js";

/**
 * V2 API router — mounted at `/api/v2`. Intentionally minimal: V2 is a parallel,
 * additive surface, so it only proxies the services that expose a V2 endpoint
 * (see `v2Services` in the versioning registry). All the V1-only aliases
 * (webrtc, linked-devices, fcm-token, sensitive-auth throttles, …) stay on the
 * V1 router; V2 clients that need those keep calling `/api/v1/*`.
 */
export function createV2Router(): IRouter {
  const v2Router: IRouter = Router();

  for (const service of getServicesForVersion("v2")) {
    v2Router.use(
      `/${service.segment}`,
      createServiceProxy({
        target: service.target,
        downstreamPrefix: service.downstreamPrefix,
        serviceName: service.segment,
      })
    );
  }

  return v2Router;
}
