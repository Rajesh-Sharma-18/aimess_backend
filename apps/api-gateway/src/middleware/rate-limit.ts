import rateLimit from "express-rate-limit";
import type { Request } from "express";

import { env } from "../config/env.js";

/** Liveness/readiness and docs should not consume the global API budget. */
function skipRateLimit(req: Request): boolean {
  const path = req.path ?? "";
  return path.startsWith("/health") || path.startsWith("/docs");
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
