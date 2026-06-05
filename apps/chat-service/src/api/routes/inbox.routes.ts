import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import { inboxQuerySchema } from "../validators/query.validator.js";
import type { InboxController } from "../controllers/inbox.controller.js";

// Inbox is the heaviest read in the service (two collection scans + two counts
// + peer-snapshot fan-out per call), so it carries a per-user read limiter.
const listLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 120,
  keyPrefix: "inbox:list",
});

export function createInboxRoutes(ctrl: InboxController): Router {
  const router = Router();

  // Unified private + group list ordered by lastMessageAt.
  router.get(
    "/",
    authenticate,
    listLimit,
    validateQuery(inboxQuerySchema),
    ctrl.getInbox
  );

  return router;
}
