import { Router, type IRouter } from "express";

import { changePassword } from "../controllers/change-password.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { changePasswordSchema } from "../validators/change-password.validator.js";
import { changePasswordRateLimiter } from "../../middleware/rate-limiters.js";

export const changePasswordRoutes: IRouter = Router();

changePasswordRoutes.post(
  "/change-password",
  authenticateAccessToken,
  // After auth so the limiter keys on userId, not a shared NAT IP — same
  // ordering as DELETE /auth/account.
  changePasswordRateLimiter,
  validateBody(changePasswordSchema),
  changePassword
);
