import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import { messageContextQuerySchema } from "../validators/query.validator.js";
import type { MessageContextController } from "../controllers/message-context.controller.js";

/**
 * Single cross-conversation-type message navigation API. Mounted at
 * `/api/chat/messages` (see `routes/index.ts`), giving:
 *
 *   GET /api/chat/messages/:messageId/context?conversationType=PRIVATE|GROUP|COMMUNITY&roomId=<roomId>
 *
 * One endpoint for every navigate-to-a-message case (reply, pinned message,
 * search result, shared-message deep link, notification deep link).
 */
export function createMessageContextRoutes(
  ctrl: MessageContextController
): Router {
  const router = Router();

  router.get(
    "/:messageId/context",
    authenticate,
    validateQuery(messageContextQuerySchema),
    ctrl.getContext
  );

  // GET /api/chat/messages/:messageId/read-receipts?conversationType=…&roomId=…
  // Per-message "Viewed by" sheet. Same (conversationType, roomId) query
  // contract as /context, so it reuses the same validator.
  router.get(
    "/:messageId/read-receipts",
    authenticate,
    validateQuery(messageContextQuerySchema),
    ctrl.getReadReceipts
  );

  return router;
}
