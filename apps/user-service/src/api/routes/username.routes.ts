import { Router, type IRouter } from "express";

import {
  generateUsername,
  validateUsername,
} from "../controllers/username.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  generateUsernameSchema,
  validateUsernameSchema,
} from "../validators/username.validator.js";

export const usernameRoutes: IRouter = Router();

usernameRoutes.post(
  "/generate",
  authenticateAccessToken,
  validateBody(generateUsernameSchema),
  generateUsername
);

usernameRoutes.post(
  "/validate",
  authenticateAccessToken,
  validateBody(validateUsernameSchema),
  validateUsername
);
