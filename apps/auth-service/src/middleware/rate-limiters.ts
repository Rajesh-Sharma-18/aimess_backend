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
