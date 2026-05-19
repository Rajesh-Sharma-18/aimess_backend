import { Router, type IRouter } from "express";

import {
  requestChangeEmailOtp,
  verifyChangeEmailOtp,
} from "../controllers/change-email.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  requestChangeEmailSchema,
  verifyChangeEmailSchema,
} from "../validators/change-email.validator.js";

export const changeEmailRoutes: IRouter = Router();

changeEmailRoutes.post(
  "/change-email/request",
  authenticateAccessToken,
  validateBody(requestChangeEmailSchema),
  requestChangeEmailOtp
);

changeEmailRoutes.post(
  "/change-email/verify",
  authenticateAccessToken,
  validateBody(verifyChangeEmailSchema),
  verifyChangeEmailOtp
);
