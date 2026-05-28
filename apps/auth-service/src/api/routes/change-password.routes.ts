import { Router, type IRouter } from "express";

import { changePassword } from "../controllers/change-password.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { changePasswordSchema } from "../validators/change-password.validator.js";

export const changePasswordRoutes: IRouter = Router();

changePasswordRoutes.post(
  "/change-password",
  authenticateAccessToken,
  validateBody(changePasswordSchema),
  changePassword
);
