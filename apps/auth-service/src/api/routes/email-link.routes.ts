import { Router, type IRouter } from "express";

import {
  requestLinkEmailOtp,
  verifyLinkEmailOtp,
} from "../controllers/email-link.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  requestLinkEmailOtpSchema,
  verifyLinkEmailOtpSchema,
} from "../validators/email-link.validator.js";

export const emailLinkRoutes: IRouter = Router();

emailLinkRoutes.post(
  "/link-email/request",
  authenticateAccessToken,
  validateBody(requestLinkEmailOtpSchema),
  requestLinkEmailOtp
);

emailLinkRoutes.post(
  "/link-email/verify",
  authenticateAccessToken,
  validateBody(verifyLinkEmailOtpSchema),
  verifyLinkEmailOtp
);
