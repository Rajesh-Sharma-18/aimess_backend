import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import {
  addMemberSchema,
  kickMemberSchema,
  updateRoleSchema,
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
  router.post("/:roomId/leave", authenticate, ctrl.leave);
  router.post("/kick", authenticate, validateBody(kickMemberSchema), ctrl.kick);
  router.post(
    "/role",
    authenticate,
    validateBody(updateRoleSchema),
    ctrl.updateRole
  );
  router.get("/:roomId", authenticate, ctrl.getMembers);

  return router;
}
