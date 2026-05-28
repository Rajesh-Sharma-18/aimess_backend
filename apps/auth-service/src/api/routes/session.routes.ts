import { Router, type IRouter } from "express";

import {
  listSessions,
  revokeAllSessions,
  revokeSession,
} from "../controllers/session.controller.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { validateParams } from "../../middleware/validate-params.js";
import { sessionIdParamsSchema } from "../validators/session.validator.js";

export const sessionRoutes: IRouter = Router();

sessionRoutes.get("/sessions", authenticateAccessToken, listSessions);
sessionRoutes.post(
  "/sessions/revoke-all",
  authenticateAccessToken,
  revokeAllSessions
);
sessionRoutes.delete(
  "/sessions/:sessionId",
  authenticateAccessToken,
  validateParams(sessionIdParamsSchema),
  revokeSession
);
