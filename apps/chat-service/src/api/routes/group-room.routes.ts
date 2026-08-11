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
  router.get("/rooms/:roomId", authenticate, ctrl.getRoom);
  router.patch(
    "/rooms/:roomId",
    authenticate,
    validateBody(updateGroupSchema),
    ctrl.update
  );
  router.post("/rooms/:roomId/disband", authenticate, ctrl.disband);
  router.post("/rooms/:roomId/clear", authenticate, ctrl.clearChat);
  // Delete Conversation: clears the caller's own history, stays a member —
  // distinct from group-member's POST /:roomId/leave.
  router.delete("/rooms/:roomId", authenticate, ctrl.clearConversation);
  router.patch("/rooms/:roomId/archive", authenticate, ctrl.archiveRoom);
  router.patch("/rooms/:roomId/unarchive", authenticate, ctrl.unarchiveRoom);

  return router;
}
