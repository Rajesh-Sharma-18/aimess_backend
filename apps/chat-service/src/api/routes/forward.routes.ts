import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import {
  createRateLimit,
  MESSAGING_RATE_LIMITS,
  MESSAGING_RATE_WINDOW_MS,
} from "../../middleware/rate-limit.js";
import { forwardMessagesSchema } from "../validators/forward.validator.js";
import type { ForwardController } from "../controllers/forward.controller.js";

// ponytail: one token per target room (a forward is one action per chat), on the send budget.
const forwardLimit = createRateLimit({
  windowMs: MESSAGING_RATE_WINDOW_MS,
  maxRequests: MESSAGING_RATE_LIMITS.send,
  keyPrefix: "fwd:send",
  onCacheError: "fallback",
  cost: (req) =>
    Array.isArray(req.body?.targets) ? req.body.targets.length : 1,
});

export function createForwardRoutes(ctrl: ForwardController): Router {
  const router = Router();
  router.post(
    "/",
    authenticate,
    validateBody(forwardMessagesSchema),
    forwardLimit,
    ctrl.forward
  );
  return router;
}
