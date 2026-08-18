import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import {
  callHistoryGroupedQuerySchema,
  callHistoryQuerySchema,
} from "../validators/call.validator.js";
import type { CallController } from "../controllers/call.controller.js";

export function createCallRoutes(ctrl: CallController): Router {
  const router = Router();
  router.get(
    "/",
    authenticate,
    validateQuery(callHistoryQuerySchema),
    ctrl.getCallHistory
  );
  // MUST stay above `/:callId`, which would otherwise capture "history".
  router.get(
    "/history",
    authenticate,
    validateQuery(callHistoryGroupedQuerySchema),
    ctrl.getGroupedCallHistory
  );
  router.get("/:callId", authenticate, ctrl.getCallById);
  return router;
}
