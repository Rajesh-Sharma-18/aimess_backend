import rateLimit from "express-rate-limit";
import type { Request } from "express";

import { env } from "../config/env.js";

/** Liveness/readiness and docs should not consume the global API budget. */
function skipRateLimit(req: Request): boolean {
  const path = req.path ?? "";
  return (
    path.startsWith("/health") ||
    path.startsWith("/docs") ||
    path.includes("/app-version/check")
  );
}

/**
 * Global HTTP rate limit (in-memory store).
 *
 * Limits:
 * - One counter per Node process — not shared across replicas (use Redis store for that).
 * - Client IP: direct socket IP when `TRUST_PROXY_HOPS=0`; uses `X-Forwarded-For` when hops ≥ 1.
 */
export const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: skipRateLimit,
  validate: {
    trustProxy: env.TRUST_PROXY_HOPS > 0,
  },
  message: {
    success: false,
    message: "Too many requests, please try again later.",
  },
});

/**
 * Stricter per-IP limiter for sensitive auth endpoints (login, password reset,
 * social sign-in). Defense-in-depth on top of the account-level lockout in
 * auth-service: caps credential-stuffing / OTP-abuse from a single IP before it
 * reaches the service. Applied in addition to the global limiter above.
 *
 * NOTE: in-memory store — per process, not shared across replicas. Move to a
 * Redis store (rate-limit-redis) when the gateway is horizontally scaled.
 */
export const sensitiveAuthRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
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
