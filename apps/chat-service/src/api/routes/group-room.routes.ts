import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import {
  createGroupSchema,
  updateGroupSchema,
} from "../validators/group-room.validator.js";
// Same body shape as the private timer — one schema, one contract, so the two
// surfaces can never drift into accepting different modes or bounds.
import { autoDeleteSchema } from "../validators/private-message.validator.js";
import type { GroupRoomController } from "../controllers/group-room.controller.js";

const createLimit = createRateLimit({
  windowMs: 86_400_000,
  maxRequests: 10,
  keyPrefix: "gr:create",
});

/**
 * Changing the auto-delete policy — low-frequency and abuse-sensitive: each
 * accepted change posts a system line to every member, wakes every member's
 * devices, and re-stamps every enrolled message in the room. Same budget as
 * private's `pm:sensitive`, which this endpoint was missing entirely.
 */
const sensitiveLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 30,
  keyPrefix: "gr:sensitive",
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

  // Automatically Delete Messages (disappearing messages) — one timer per group.
  // Readable by any member; the PUT is admin/moderator-gated in the service.
  router.get("/rooms/:roomId/auto-delete", authenticate, ctrl.getAutoDelete);
  router.put(
    "/rooms/:roomId/auto-delete",
    authenticate,
    sensitiveLimit,
    validateBody(autoDeleteSchema),
    ctrl.setAutoDelete
  );

  return router;
}
