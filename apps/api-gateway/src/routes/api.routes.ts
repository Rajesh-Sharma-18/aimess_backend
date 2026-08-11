import { Router, type IRouter } from "express";

import { API_VERSIONS, DEFAULT_API_VERSION } from "../versioning/types.js";
import { createV1Router } from "./v1/index.js";
import type { MessagingClient } from "../grpc/clients/messaging.client.js";

export function createApiRouter(messagingClient: MessagingClient): IRouter {
  const apiRouter: IRouter = Router();

  apiRouter.use("/v1", createV1Router(messagingClient));

  return apiRouter;
}

export function listMountedApiVersions(): string[] {
  return [...API_VERSIONS];
}

export { DEFAULT_API_VERSION };
