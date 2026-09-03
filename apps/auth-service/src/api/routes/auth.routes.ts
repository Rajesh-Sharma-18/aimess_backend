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
import { hydrateRefreshTokenFromCookie } from "../../lib/auth-cookie.js";
import {  authenticateAccessTokenOptional } from "../../middleware/authenticate-access-token.js";
import { validateBody } from "../middleware/validate-body.js";
import {
  loginSchema,
  registerSchema,
  validateAccountSchema,
} from "../validators/auth.validator.js";
import {
  refreshRateLimiter,
  sensitiveAuthRateLimiter,
} from "../../middleware/rate-limiters.js";
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
// This is an enumeration oracle by design: it answers 409 for a taken handle
// and 200 for a free one, and enumerated handles are the input to targeted
// credential stuffing against /login (AIM-31).
//
// It was priced with a single-use proof of work as well as the per-IP throttle.
// That is deliberately GONE: a signup form has to answer "is this name free?"
// while the user is still typing, and making every keystroke fetch and solve a
// challenge — then fail with a validation error when it had not — cost more in
// usability than the control bought. What remains is `sensitiveAuthRateLimiter`
// alone, which bounds one address and does nothing about a proxy pool or a
// botnet, where the per-source rate stays low. Raise the limiter, or put the
// proof of work back, if enumeration shows up in the logs.
authRoutes.post(
  "/accounts/validate",
  sensitiveAuthRateLimiter,
  validateBody(validateAccountSchema),
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
// `hydrateRefreshTokenFromCookie` folds the httpOnly cookie into the body before
// validation, so a browser posts an empty body and a native client - which
// still sends `refreshToken` explicitly - is untouched. The body wins on conflict.
authRoutes.post(
  "/refresh",
  refreshRateLimiter,
  hydrateRefreshTokenFromCookie,
  validateBody(refreshTokenSchema),
  refreshTokens
);
authRoutes.post(
  "/token",
  refreshRateLimiter,
  hydrateRefreshTokenFromCookie,
  validateBody(refreshTokenSchema),
  issueAccessToken
);
// Optional auth: an expired access token must not trap a live refresh cookie
// in the browser, so logout falls back to the cookie to find the session.
authRoutes.post("/logout", authenticateAccessTokenOptional, logout);
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
