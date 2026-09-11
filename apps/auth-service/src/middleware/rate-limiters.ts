import type { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { rateLimitHandler } from "@aimess/utils";

import { env } from "../config/env.js";
import { resolveClientIp } from "../lib/session-context.js";

/**
 * The address to bucket a limiter on.
 *
 * `resolveClientIp` is `req.ip`, and behind the gateway that is the GATEWAY —
 * this service ships with TRUST_PROXY_HOPS=0 and the gateway does not add
 * itself to `X-Forwarded-For`. So every per-IP limiter in this file was in
 * practice one bucket shared by every user of the platform: "20 attempts per 15
 * minutes per address" was 20 for everybody, and a handful of people signing in
 * at the same time was indistinguishable from an attack.
 *
 * The gateway now stamps `x-client-ip` with the address IT resolved (see
 * `create-service-proxy.ts`), overwriting anything the caller sent, so the
 * header is only forgeable by something that can reach this service without
 * going through the gateway — which is nothing, on the compose network. Falls
 * back to `req.ip` for a direct call, which is the old behaviour.
 *
 * Only the LIMITER KEY reads this. Session and device identity keep using
 * `resolveClientIp` unchanged; changing what those record is a separate
 * decision with its own blast radius.
 */
function limiterIp(req: Request): string {
  const stamped = req.headers["x-client-ip"];
  const value = typeof stamped === "string" ? stamped.trim() : "";
  return ipKeyGenerator(value || resolveClientIp(req));
}

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
  keyGenerator: limiterIp,
  handler: rateLimitHandler(),
});

/**
 * Account-availability probe (`POST /accounts/validate`).
 *
 * Split out of `sensitiveAuthRateLimiter` above. That bucket is shared by
 * register, login, the signup challenge and the social sign-ins, so the probe a
 * signup form fires WHILE THE USER TYPES was spending the same 20-per-15-minute
 * allowance the user then needed to log in — and a 429 earned by typing locked
 * the whole auth surface for a quarter of an hour.
 *
 * Short window, higher ceiling: 30 probes a minute tolerates a debounced field,
 * a Continue press, a duplicate render and an idle retry, while still bounding
 * handle enumeration per address. The gateway carries the matching
 * `auth.account-validate` rule, which is the one that counts across replicas;
 * this is the in-process backstop for a direct call.
 */
export const accountValidateRateLimiter = rateLimit({
  windowMs: env.ACCOUNT_VALIDATE_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: env.ACCOUNT_VALIDATE_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: limiterIp,
  handler: rateLimitHandler(),
});

/**
 * Password login (`POST /login`), on its own counter rather than sharing one
 * with account-validate and registration.
 *
 * `skipSuccessfulRequests` is the "successful login resets the failure state"
 * half of the deal, and it matches what the account already does — a correct
 * password zeroes `failedLoginAttempts` and clears `lockedUntil` (see
 * `authRepository.recordSuccessfulLogin`). Without it, an office or CGNAT
 * address accumulated a shared ban out of people signing in SUCCESSFULLY, which
 * protects nothing: a brute-force run is made of failures, and those still
 * count in full.
 *
 * The window is 5 minutes rather than 15 so an honest mistype streak costs
 * minutes. Brute-force protection is unchanged in kind — the per-account
 * lockout (AUTH_MAX_FAILED_LOGINS attempts, then AUTH_LOCKOUT_MINUTES) is what
 * actually stops a distributed attempt, and this bounds a single address.
 */
export const loginRateLimiter = rateLimit({
  windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: env.LOGIN_RATE_LIMIT_MAX,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: limiterIp,
  handler: rateLimitHandler(),
});

/**
 * Refresh / access-token issue (`POST /refresh`, `POST /token`).
 *
 * Both were once unthrottled at BOTH layers: the gateway's list omitted them
 * and its global backstop keys on the bearer token, which a cookie-authenticated
 * refresh does not send. They then spent a while sharing `auth.sensitive` with
 * login and account-validate at the gateway, which was worse for a different
 * reason — background session upkeep was spending a credential-attempt budget.
 *
 * Now their own bucket at both layers, and deliberately generous: a legitimate
 * browser refreshes on boot and once per access-token expiry, per open tab, and
 * being wrong here signs people out of sessions that were fine.
 */
export const refreshRateLimiter = rateLimit({
  windowMs: env.REFRESH_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: env.REFRESH_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: limiterIp,
  handler: rateLimitHandler(),
});

/** QR login generation: configurable requests/minute/IP (unauthenticated endpoint). */
export const qrGenerationRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.QR_GENERATION_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: limiterIp,
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
  keyGenerator: (req: Request) => req.auth?.userId ?? limiterIp(req),
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
  keyGenerator: limiterIp,
  handler: rateLimitHandler(),
});

/** QR login scan: configurable requests/minute/user (authenticated endpoint). */
export const qrScanRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.QR_SCAN_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: (req: Request) => req.auth?.userId ?? limiterIp(req),
  handler: rateLimitHandler(),
});
