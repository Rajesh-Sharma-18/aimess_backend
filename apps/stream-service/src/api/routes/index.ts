import { Router, type IRouter } from "express";

import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import type { StreamController } from "../controllers/index.js";

/**
 * API v1 routes — mounted at `/api/v1`. Every route is behind
 * `authenticateAccessToken` (token issued by auth-service). The controller is
 * injected so it can be wired with its services in `server.ts`.
 */
export function createServiceRoutes(controller: StreamController): IRouter {
  const router = Router();

  router.post("/streams", authenticateAccessToken, controller.createStream);
  router.get("/streams", authenticateAccessToken, controller.listStreams);
  router.get("/streams/:id", authenticateAccessToken, controller.getStream);
  router.post(
    "/streams/:id/stop",
    authenticateAccessToken,
    controller.stopStream
  );
  router.get(
    "/streams/:id/comments",
    authenticateAccessToken,
    controller.getComments
  );

  return router;
}
