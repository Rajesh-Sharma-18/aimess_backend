import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import {
  globalMessageSearchQuerySchema,
  messageContextQuerySchema,
} from "../validators/query.validator.js";
import type { MessageContextController } from "../controllers/message-context.controller.js";
import type { MessageSearchController } from "../controllers/message-search.controller.js";

/**
 * Single cross-conversation-type message navigation API. Mounted at
 * `/api/chat/messages` (see `routes/index.ts`), giving:
 *
 *   GET /api/chat/messages/:messageId/context?conversationType=PRIVATE|GROUP|COMMUNITY&roomId=<roomId>
 *
 * One endpoint for every navigate-to-a-message case (reply, pinned message,
 * search result, shared-message deep link, notification deep link) — plus the
 * whole-account message-body search that produces those search results.
 */
export function createMessageContextRoutes(
  ctrl: MessageContextController,
  searchCtrl: MessageSearchController
): Router {
  const router = Router();

  // GET /api/chat/messages/search?q=&limit=&cursor=
  // Registered before the `/:messageId/...` routes so the literal path wins.
  // The strict-cursor variant, mounted HERE only: the three per-room searches
  // predate this endpoint and still accept the looser cursor they shipped with.
  router.get(
    "/search",
    authenticate,
    validateQuery(globalMessageSearchQuerySchema),
    searchCtrl.search
  );

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
