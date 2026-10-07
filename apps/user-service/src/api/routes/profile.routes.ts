import { Router, type IRouter } from "express";

import {
  clearCustomStatus,
  getMyProfile,
  setCustomStatus,
  updateProfile,
} from "../controllers/profile.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  setCustomStatusSchema,
  updateProfileSchema,
} from "../validators/profile.validator.js";

export const profileRoutes: IRouter = Router();

profileRoutes.get("/me", authenticateAccessToken, getMyProfile);

profileRoutes.patch(
  "/me",
  authenticateAccessToken,
  validateBody(updateProfileSchema),
  updateProfile
);

profileRoutes.put(
  "/me/custom-status",
  authenticateAccessToken,
  validateBody(setCustomStatusSchema),
  setCustomStatus
);

profileRoutes.delete("/me/custom-status", authenticateAccessToken, clearCustomStatus);
