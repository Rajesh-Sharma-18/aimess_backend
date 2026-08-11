import type { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";
import { resolveClientIp } from "../lib/session-context.js";

/**
 * Rate limiter for sensitive auth operations (register, login, password reset, etc.).
 * Limits to SENSITIVE_AUTH_RATE_LIMIT_MAX attempts per 15-minute window.
 */
export const sensitiveAuthRateLimiter = rateLimit({
  // windowMs: 15 * 60 * 1000, // 15 minutes
  windowMs: env.SENSITIVE_AUTH_RATE_LIMIT_WINDOW_MINUTES, // 15 minutes
  max: env.SENSITIVE_AUTH_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: {
    trustProxy: env.TRUST_PROXY_HOPS > 0,
  },
  keyGenerator: (req: Request) => ipKeyGenerator(resolveClientIp(req)),
  message: {
    success: false,
    message: "Too many attempts, please try again later.",
  },
});

/** QR login generation: configurable requests/minute/IP (unauthenticated endpoint). */
export const qrGenerationRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.QR_GENERATION_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: (req: Request) => ipKeyGenerator(resolveClientIp(req)),
  message: {
    success: false,
    message: "Too many QR login sessions requested, please try again later.",
  },
});

/**
 * Account deletion: 5 attempts/hour/user. Password-confirmed and irreversible,
 * so the only traffic this can throttle is someone brute-forcing the password
 * of a session they already stole. Keyed by user (falls back to IP pre-auth).
 */
export const deleteAccountRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: env.DELETE_ACCOUNT_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: (req: Request) =>
    req.auth?.userId ?? ipKeyGenerator(resolveClientIp(req)),
  message: {
    success: false,
    message: "Too many attempts, please try again later.",
  },
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
  message: {
    success: false,
    message: "Too many QR scan attempts, please try again later.",
  },
});
