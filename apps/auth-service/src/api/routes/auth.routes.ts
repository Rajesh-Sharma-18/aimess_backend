import { Router, type IRouter } from "express";

import {
  getSignupChallenge,
  login,
  register,
  validateAccount,
} from "../controllers/auth.controller.js";
import {
  logout,
  refreshTokens,
  issueAccessToken,
} from "../controllers/session.controller.js";
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
import { sensitiveAuthRateLimiter } from "../../middleware/rate-limiters.js";
import { requireSignupChallenge } from "../../middleware/require-signup-challenge.js";
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

// Issues the proof of work that /register and /accounts/validate require. It
// must come before them in a client's flow, and it is throttled like them so
// the issuer itself cannot be used as a free amplifier.
authRoutes.post("/challenge", sensitiveAuthRateLimiter, getSignupChallenge);
// Answered 409 for a taken handle and 200 for a free one, with no throttle and
// no cost, which enumerates the entire handle namespace — and enumerated
// handles are the input to targeted credential stuffing against /login. The
// oracle is genuinely needed (a signup form has to say "taken" while you type),
// so it is priced rather than removed: per-IP throttle plus a single-use proof
// of work, so each handle tested costs the caller CPU they cannot amortise.
authRoutes.post(
  "/accounts/validate",
  sensitiveAuthRateLimiter,
  validateBody(validateAccountSchema),
  requireSignupChallenge,
  validateAccount
);
// `sensitiveAuthRateLimiter` was declared with its own env knobs and then
// imported by NOTHING, so every credential-guessing surface below was
// unthrottled. It is per-IP, which is the only key available before a caller is
// authenticated; the per-account lockout (AUTH_MAX_FAILED_LOGINS) remains the
// defence against a distributed attempt.
// Registration needed no verified contact detail and no bot resistance of any
// kind, so ten thousand accounts cost ten thousand HTTP requests. The proof of
// work makes each one cost CPU on the creator's own hardware.
authRoutes.post(
  "/register",
  sensitiveAuthRateLimiter,
  validateBody(registerSchema),
  requireSignupChallenge,
  register
);
// The validator was commented out, so a missing `account` threw inside the
// service (500 instead of 400) and an object `account` / non-string `password`
// reached the repository and bcrypt.
authRoutes.post(
  "/login",
  sensitiveAuthRateLimiter,
  validateBody(loginSchema),
  login
);
authRoutes.post("/refresh", validateBody(refreshTokenSchema), refreshTokens);
authRoutes.post("/token", validateBody(refreshTokenSchema), issueAccessToken);
authRoutes.post("/logout", authenticateAccessToken, logout);
authRoutes.post(
  "/google",
  sensitiveAuthRateLimiter,
  validateBody(googleLoginSchema),
  loginWithGoogle
);
authRoutes.post(
  "/apple",
  sensitiveAuthRateLimiter,
  validateBody(appleLoginSchema),
  loginWithApple
);

authRoutes.post(
  "/forgot-password/request",
  sensitiveAuthRateLimiter,
  validateBody(requestPasswordResetOtpSchema),
  requestPasswordResetOtp
);
authRoutes.post(
  "/forgot-password/verify",
  sensitiveAuthRateLimiter,
  validateBody(verifyPasswordResetOtpSchema),
  verifyPasswordResetOtp
);
authRoutes.post(
  "/forgot-password/reset",
  sensitiveAuthRateLimiter,
  validateBody(resetPasswordSchema),
  resetPassword
);
