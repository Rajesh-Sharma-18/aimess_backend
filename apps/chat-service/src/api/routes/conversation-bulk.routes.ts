import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import {
  bulkLeaveConversationsSchema,
  bulkMarkReadConversationsSchema,
  bulkMuteConversationsSchema,
} from "../validators/conversation-bulk.validator.js";
import type { ConversationBulkController } from "../controllers/conversation-bulk.controller.js";

// One request fans out to up to 50 rooms, each doing real writes + socket
// fan-out, so this is the heaviest write in the service per call. Keyed
// per-user by the shared limiter (see middleware/rate-limit.ts).
const bulkLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 30,
  keyPrefix: "conv:bulk",
});

export function createConversationBulkRoutes(
  ctrl: ConversationBulkController
): Router {
  const router = Router();

  router.post(
    "/leave/bulk",
    authenticate,
    bulkLimit,
    validateBody(bulkLeaveConversationsSchema),
    ctrl.bulkLeave
  );

  router.post(
    "/mute/bulk",
    authenticate,
    bulkLimit,
    validateBody(bulkMuteConversationsSchema),
    ctrl.bulkMute
  );

  router.post(
    "/read/bulk",
    authenticate,
    bulkLimit,
    validateBody(bulkMarkReadConversationsSchema),
    ctrl.bulkMarkRead
  );

  return router;
}
