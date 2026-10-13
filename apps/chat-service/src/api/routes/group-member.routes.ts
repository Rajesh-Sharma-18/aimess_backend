import { Router, type RequestHandler } from "express";
import { GoneError } from "@aimess/errors";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import { reportQuota } from "../../middleware/rate-limit.js";
import {
  addMemberSchema,
  leaveGroupSchema,
  kickMemberSchema,
  updateRoleSchema,
  muteGroupSchema,
  reportMemberSchema,
} from "../validators/group-member.validator.js";
import type { GroupMemberController } from "../controllers/group-member.controller.js";

// Groups are leader + members only: ban and member-mute were removed.
const removed: RequestHandler = (_req, _res, next) =>
  next(new GoneError("CHAT_GROUP_FEATURE_REMOVED"));

export function createGroupMemberRoutes(ctrl: GroupMemberController): Router {
  const router = Router();

  router.post(
    "/add",
    authenticate,
    validateBody(addMemberSchema),
    ctrl.addMember
  );
  router.post(
    "/:roomId/leave",
    authenticate,
    validateBody(leaveGroupSchema),
    ctrl.leave
  );
  router.post("/kick", authenticate, validateBody(kickMemberSchema), ctrl.kick);
  router.post("/ban", authenticate, removed);
  router.post("/unban", authenticate, removed);
  router.post(
    "/report",
    authenticate,
    validateBody(reportMemberSchema),
    reportQuota,
    ctrl.reportMember
  );
  router.post(
    "/role",
    authenticate,
    validateBody(updateRoleSchema),
    ctrl.updateRole
  );
  router.get("/:roomId/muted", authenticate, removed);
  router.get("/:roomId", authenticate, ctrl.getMembers);

  // Mute / unmute personal notifications for this group (parity with Private's
  // /private/rooms/:roomId/mute — Group had the storage field but no route).
  router.post(
    "/:roomId/mute",
    authenticate,
    validateBody(muteGroupSchema),
    ctrl.muteRoom
  );
  router.post("/:roomId/unmute", authenticate, ctrl.unmuteRoom);
  router.post("/mute-member", authenticate, removed);
  router.post("/unmute-member", authenticate, removed);

  return router;
}
