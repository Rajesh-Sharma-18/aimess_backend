import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateQuery } from "../middleware/validate-query.js";
import {
  callActionBodySchema,
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
  router.get("/:callId", authenticate, ctrl.getCallById);
  // Socket-free call control — see CallController for why these exist. Same
  // service methods as the `/chat` socket events, so state stays single-sourced.
  router.post(
    "/:callId/answer",
    authenticate,
    validateBody(callActionBodySchema),
    ctrl.answerCall
  );
  router.post(
    "/:callId/decline",
    authenticate,
    validateBody(callActionBodySchema),
    ctrl.declineCall
  );
  router.post(
    "/:callId/end",
    authenticate,
    validateBody(callActionBodySchema),
    ctrl.endCall
  );
  return router;
}
