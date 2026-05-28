import { Router, type IRouter } from "express";

import {
  getMySettings,
  updateMySettings,
} from "../controllers/settings.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { updateSettingsSchema } from "../validators/settings.validator.js";

export const settingsRoutes: IRouter = Router();

settingsRoutes.get("/me", authenticateAccessToken, getMySettings);

settingsRoutes.patch(
  "/me",
  authenticateAccessToken,
  validateBody(updateSettingsSchema),
  updateMySettings
);
