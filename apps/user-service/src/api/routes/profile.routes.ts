import { Router, type IRouter } from "express";

import { createAvatarUploadUrl } from "../controllers/avatar.controller.js";
import {
  getMyProfile,
  updateProfile,
} from "../controllers/profile.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { avatarUploadUrlSchema } from "../validators/avatar.validator.js";
import { updateProfileSchema } from "../validators/profile.validator.js";

export const profileRoutes: IRouter = Router();

profileRoutes.post(
  "/me/avatar/upload-url",
  authenticateAccessToken,
  validateBody(avatarUploadUrlSchema),
  createAvatarUploadUrl
);

profileRoutes.get("/me", authenticateAccessToken, getMyProfile);

profileRoutes.patch(
  "/me",
  authenticateAccessToken,
  validateBody(updateProfileSchema),
  updateProfile
);
