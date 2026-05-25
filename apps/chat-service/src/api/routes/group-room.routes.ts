import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import {
  createGroupSchema,
  updateGroupSchema,
} from "../validators/group-room.validator.js";
import type { GroupRoomController } from "../controllers/group-room.controller.js";

const createLimit = createRateLimit({
  windowMs: 86_400_000,
  maxRequests: 10,
  keyPrefix: "gr:create",
});

export function createGroupRoomRoutes(ctrl: GroupRoomController): Router {
  const router = Router();

  router.post(
    "/",
    authenticate,
    createLimit,
    validateBody(createGroupSchema),
    ctrl.create
  );
  router.get("/my-groups", authenticate, ctrl.getUserGroups);
  router.get("/:roomId", authenticate, ctrl.getRoom);
  router.patch(
    "/:roomId",
    authenticate,
    validateBody(updateGroupSchema),
    ctrl.update
  );
  router.post("/:roomId/disband", authenticate, ctrl.disband);

  return router;
}
