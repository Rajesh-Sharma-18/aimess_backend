import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import type { UnreadSummaryController } from "../controllers/unread-summary.controller.js";

export function createUnreadSummaryRoutes(
  ctrl: UnreadSummaryController
): Router {
  const router = Router();

  router.get("/", authenticate, ctrl.getUnreadSummary);

  return router;
}
