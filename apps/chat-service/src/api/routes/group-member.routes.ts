import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import {
  addMemberSchema,
  leaveGroupSchema,
  kickMemberSchema,
  banMemberSchema,
  unbanMemberSchema,
  updateRoleSchema,
  muteGroupSchema,
  reportMemberSchema,
} from "../validators/group-member.validator.js";
import type { GroupMemberController } from "../controllers/group-member.controller.js";

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
  router.post("/ban", authenticate, validateBody(banMemberSchema), ctrl.ban);
  router.post(
    "/unban",
    authenticate,
    validateBody(unbanMemberSchema),
    ctrl.unban
  );
  router.post(
    "/report",
    authenticate,
    validateBody(reportMemberSchema),
    ctrl.reportMember
  );
  router.post(
    "/role",
    authenticate,
    validateBody(updateRoleSchema),
    ctrl.updateRole
  );
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

  return router;
}
