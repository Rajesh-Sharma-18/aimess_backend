import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import {
  createInviteLinkSchema,
  revokeInviteLinkSchema,
  joinByInviteLinkSchema,
  bulkSendInviteLinkSchema,
} from "../validators/group-invite-link.validator.js";
import type { GroupInviteLinkController } from "../controllers/group-invite-link.controller.js";

export function createGroupInviteLinkRoutes(
  ctrl: GroupInviteLinkController
): Router {
  const router = Router();

  router.post(
    "/",
    authenticate,
    validateBody(createInviteLinkSchema),
    ctrl.create
  );
  router.post(
    "/revoke",
    authenticate,
    validateBody(revokeInviteLinkSchema),
    ctrl.revoke
  );
  router.get("/preview/:token", ctrl.preview);
  router.post(
    "/join",
    authenticate,
    validateBody(joinByInviteLinkSchema),
    ctrl.join
  );
  router.get("/room/:roomId", authenticate, ctrl.getActiveLinks);
  router.post(
    "/room/:roomId/bulk-send",
    authenticate,
    validateBody(bulkSendInviteLinkSchema),
    ctrl.bulkSend
  );

  return router;
}
