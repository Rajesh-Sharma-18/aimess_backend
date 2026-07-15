import type { Request } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";

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
  message: {
    success: false,
    message: "Too many attempts, please try again later.",
  },
});

/** QR login generation: 5 requests/minute/IP (unauthenticated endpoint). */
export const qrGenerationRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  message: {
    success: false,
    message: "Too many QR login sessions requested, please try again later.",
  },
});

/** QR login scan: 10 requests/minute/user (authenticated endpoint). */
export const qrScanRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: (req: Request) => req.auth?.userId ?? req.ip ?? "unknown",
  message: {
    success: false,
    message: "Too many QR scan attempts, please try again later.",
  },
});
