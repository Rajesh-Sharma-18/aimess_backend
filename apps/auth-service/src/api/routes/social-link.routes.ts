import { Router, type IRouter } from "express";

import {
  linkApple,
  linkGoogle,
  unlinkSocial,
} from "../controllers/social-link.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  linkAppleSchema,
  linkGoogleSchema,
  unlinkSocialSchema,
} from "../validators/social-link.validator.js";

export const socialLinkRoutes: IRouter = Router();

socialLinkRoutes.post(
  "/social/google/link",
  authenticateAccessToken,
  validateBody(linkGoogleSchema),
  linkGoogle
);

socialLinkRoutes.post(
  "/social/apple/link",
  authenticateAccessToken,
  validateBody(linkAppleSchema),
  linkApple
);

socialLinkRoutes.post(
  "/social/unlink",
  authenticateAccessToken,
  validateBody(unlinkSocialSchema),
  unlinkSocial
);
