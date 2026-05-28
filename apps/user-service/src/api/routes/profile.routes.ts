import { Router, type IRouter } from "express";

import {
  getMyProfile,
  updateProfile,
} from "../controllers/profile.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { updateProfileSchema } from "../validators/profile.validator.js";

export const profileRoutes: IRouter = Router();

profileRoutes.get("/me", authenticateAccessToken, getMyProfile);

profileRoutes.patch(
  "/me",
  authenticateAccessToken,
  validateBody(updateProfileSchema),
  updateProfile
);
