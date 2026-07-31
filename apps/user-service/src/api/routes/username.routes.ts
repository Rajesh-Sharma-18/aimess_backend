import { Router, type IRouter } from "express";

import {
  generateUsername,
  validateUsername,
  validateUsernameQuery,
} from "../controllers/username.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateQuery } from "../middleware/validate-query.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  generateUsernameSchema,
  validateUsernameQuerySchema,
  validateUsernameSchema,
} from "../validators/username.validator.js";

export const usernameRoutes: IRouter = Router();

usernameRoutes.post(
  "/generate",
  authenticateAccessToken,
  validateBody(generateUsernameSchema),
  generateUsername
);

// GET /api/v1/users/usernames/validate?username=… — FE availability check
// (register-detail + profile-edit screens). Kept alongside the POST route
// below, which existing callers/tests still use.
usernameRoutes.get(
  "/validate",
  authenticateAccessToken,
  validateQuery(validateUsernameQuerySchema),
  validateUsernameQuery
);

usernameRoutes.post(
  "/validate",
  authenticateAccessToken,
  validateBody(validateUsernameSchema),
  validateUsername
);
