import { Router, type IRouter } from "express";

import { createServiceProxy } from "../../proxy/create-service-proxy.js";
import { getServicesForVersion } from "../../versioning/registry.js";

export const v1Router: IRouter = Router();

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
