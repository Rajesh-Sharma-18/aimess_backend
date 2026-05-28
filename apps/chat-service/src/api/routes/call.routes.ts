import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { validateQuery } from "../middleware/validate-query.js";
import { callHistoryQuerySchema } from "../validators/call.validator.js";
import type { CallController } from "../controllers/call.controller.js";

export function createCallRoutes(ctrl: CallController): Router {
  const router = Router();
  router.get(
    "/",
    authenticate,
    validateQuery(callHistoryQuerySchema),
    ctrl.getCallHistory
  );
  router.get("/:callId", authenticate, ctrl.getCallById);
  return router;
}
