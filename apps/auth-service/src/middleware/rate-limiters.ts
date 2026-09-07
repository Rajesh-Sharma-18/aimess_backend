import type { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { rateLimitHandler } from "@aimess/utils";

import { env } from "../config/env.js";
import { resolveClientIp } from "../lib/session-context.js";

/**
 * Rate limiter for sensitive auth operations (register, login, password reset, etc.).
 * Limits to SENSITIVE_AUTH_RATE_LIMIT_MAX attempts per 15-minute window.
 */
export const sensitiveAuthRateLimiter = rateLimit({
  // The env var is in MINUTES; `windowMs` is milliseconds. Passing the raw
  // value made the window 15 MILLIseconds — effectively no limiter at all.
  windowMs: env.SENSITIVE_AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: env.SENSITIVE_AUTH_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: {
    trustProxy: env.TRUST_PROXY_HOPS > 0,
  },
  keyGenerator: (req: Request) => ipKeyGenerator(resolveClientIp(req)),
  handler: rateLimitHandler(),
});

/**
 * Refresh / access-token issue. Both were unthrottled at BOTH layers: the
 * gateway list omits them and its global backstop keys on the bearer token,
 * which a cookie-authenticated refresh does not send - so every anonymous
 * caller behind one NAT shared a single bucket. Per-IP, deliberately generous:
 * a legitimate browser refreshes on boot and once per access-token expiry.
 */
export const refreshRateLimiter = rateLimit({
  windowMs: env.REFRESH_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: env.REFRESH_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: (req: Request) => ipKeyGenerator(resolveClientIp(req)),
  handler: rateLimitHandler(),
});

/** QR login generation: configurable requests/minute/IP (unauthenticated endpoint). */
export const qrGenerationRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.QR_GENERATION_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: (req: Request) => ipKeyGenerator(resolveClientIp(req)),
  handler: rateLimitHandler(),
});

// NOTE: there is deliberately no `deleteAccountRateLimiter` here any more.
// DELETE /auth/account was unthrottled on request on 2026-08-12 — see the
// comment in `api/routes/account-deletion.routes.ts` for the rationale, the
// security trade, and how to re-add one correctly. Every other limiter in this
// file is unchanged.

/**
 * Change password: 5 attempts/hour/user by default. The handler verifies
 * `currentPassword` before accepting the new one, so without a limiter the
 * endpoint is an unthrottled password oracle — anyone holding a stolen access
 * token can guess the account password at request speed and then take the
 * account over outright (a successful change signs every other device out).
 * Keyed by user, mounted AFTER the auth middleware.
 */
export const changePasswordRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: env.CHANGE_PASSWORD_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: (req: Request) =>
    req.auth?.userId ?? ipKeyGenerator(resolveClientIp(req)),
  handler: rateLimitHandler(),
});

/**
 * QR result polling: the waiting browser pulling its own QR's outcome.
 *
 * Its own bucket, sized for what polling actually costs. This endpoint was
 * mounted on `qrGenerationRateLimiter` — 5/minute, written and named for
 * GENERATING a QR — while the browser polls it every 2 seconds. A single
 * 60-second QR needs 30 requests, so the limiter fired about ten seconds in and
 * the QR spent the rest of its life answering 429.
 *
 * Same reasoning the OTP endpoints already have at the gateway: a high-frequency
 * flow must not be metered out of a low-frequency flow's allowance.
 *
 * Generous on purpose, and safe to be: the handler reads one Redis key, the
 * endpoint is unauthenticated only because the 256-bit linkToken IS the
 * credential, and that is not guessable at any request rate. Volume is the only
 * thing this needs to bound.
 *
 * NOTE: `qrGenerationRateLimiter` above is now mounted on nothing — it only
 * ever guarded this endpoint, despite its name. `/devices/link/initiate` is
 * unthrottled at both layers. Left defined rather than deleted because that is
 * the limiter initiate would want if it is ever given one; giving it one now
 * would be a behaviour change nobody asked for.
 */
export const qrResultPollRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.QR_RESULT_POLL_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: (req: Request) => ipKeyGenerator(resolveClientIp(req)),
  handler: rateLimitHandler(),
});

/** QR login scan: configurable requests/minute/user (authenticated endpoint). */
export const qrScanRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.QR_SCAN_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: (req: Request) =>
    req.auth?.userId ?? ipKeyGenerator(resolveClientIp(req)),
  handler: rateLimitHandler(),
});
