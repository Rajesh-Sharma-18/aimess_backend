import { Router, type IRouter } from "express";

import {
  login,
  register,
  validateAccount,
} from "../controllers/auth.controller.js";
import { logout, refreshTokens } from "../controllers/session.controller.js";
import {
  requestPasswordResetOtp,
  resetPassword,
  verifyPasswordResetOtp,
} from "../controllers/password-reset.controller.js";
import {
  loginWithApple,
  loginWithGoogle,
} from "../controllers/social-auth.controller.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { validateBody } from "../middleware/validate-body.js";
import {
  loginSchema,
  registerSchema,
  validateAccountSchema,
} from "../validators/auth.validator.js";
import {
  requestPasswordResetOtpSchema,
  resetPasswordSchema,
  verifyPasswordResetOtpSchema,
} from "../validators/password-reset.validator.js";
import {
  appleLoginSchema,
  googleLoginSchema,
} from "../validators/social-auth.validator.js";
import { refreshTokenSchema } from "../validators/session.validator.js";

export const authRoutes: IRouter = Router();

authRoutes.post(
  "/accounts/validate",
  validateBody(validateAccountSchema),
  validateAccount
);
authRoutes.post("/register", validateBody(registerSchema), register);
authRoutes.post("/login", validateBody(loginSchema), login);
authRoutes.post("/refresh", validateBody(refreshTokenSchema), refreshTokens);
authRoutes.post("/logout", authenticateAccessToken, logout);
authRoutes.post("/google", validateBody(googleLoginSchema), loginWithGoogle);
authRoutes.post("/apple", validateBody(appleLoginSchema), loginWithApple);

authRoutes.post(
  "/forgot-password/request",
  validateBody(requestPasswordResetOtpSchema),
  requestPasswordResetOtp
);
authRoutes.post(
  "/forgot-password/verify",
  validateBody(verifyPasswordResetOtpSchema),
  verifyPasswordResetOtp
);
authRoutes.post(
  "/forgot-password/reset",
  validateBody(resetPasswordSchema),
  resetPassword
);
