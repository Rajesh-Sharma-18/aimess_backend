import { Router, type IRouter } from "express";

import {
  forgotPassword,
  login,
  logout,
  refresh,
  resendOtp,
  resetPassword,
  verifyOtp,
} from "../controllers/index.js";
import { adminAuth, validateBody } from "../middleware/index.js";
import {
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  resendOtpSchema,
  resetPasswordSchema,
  verifyOtpSchema,
} from "../validators/index.js";

export const authRoutes: IRouter = Router();

// Public (no admin bearer).
authRoutes.post("/login", validateBody(loginSchema), login);
authRoutes.post("/refresh", validateBody(refreshSchema), refresh);

// Public password-reset flow (no admin bearer).
authRoutes.post(
  "/forgot-password",
  validateBody(forgotPasswordSchema),
  forgotPassword
);
authRoutes.post("/verify-otp", validateBody(verifyOtpSchema), verifyOtp);
authRoutes.post("/resend-otp", validateBody(resendOtpSchema), resendOtp);
authRoutes.post(
  "/reset-password",
  validateBody(resetPasswordSchema),
  resetPassword
);

// Self (requires a valid admin bearer to revoke its own jti).
authRoutes.post("/logout", adminAuth, logout);
