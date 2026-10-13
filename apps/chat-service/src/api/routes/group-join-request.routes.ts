import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import type { GroupJoinRequestController } from "../controllers/group-join-request.controller.js";

export function createGroupJoinRequestRoutes(
  ctrl: GroupJoinRequestController
): Router {
  const router = Router();
  router.get("/mine", authenticate, ctrl.listMine);
  router.get("/room/:roomId", authenticate, ctrl.listForRoom);
  router.post("/:requestId/approve", authenticate, ctrl.approve);
  router.post("/:requestId/reject", authenticate, ctrl.reject);
  router.post("/:requestId/cancel", authenticate, ctrl.cancel);
  return router;
}
