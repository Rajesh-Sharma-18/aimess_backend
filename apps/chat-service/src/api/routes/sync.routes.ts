import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import { syncQuerySchema } from "../validators/query.validator.js";
import type { SyncController } from "../controllers/sync.controller.js";

// Sync fans out a per-room catch-up; carries a per-user read limiter like inbox.
const syncLimit = createRateLimit({
  windowMs: 60_000,
  maxRequests: 120,
  keyPrefix: "sync:events",
});

export function createSyncRoutes(ctrl: SyncController): Router {
  const router = Router();

  router.get(
    "/",
    authenticate,
    syncLimit,
    validateQuery(syncQuerySchema),
    ctrl.getSync
  );

  return router;
}
