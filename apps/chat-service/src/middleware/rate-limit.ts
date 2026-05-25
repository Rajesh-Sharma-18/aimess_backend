import type { Request, Response, NextFunction } from "express";

import { redis } from "../config/redis.js";

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
}

/**
 * Sliding-window rate limiter backed by Redis.
 * Returns Express middleware that enforces the given limits.
 */
export function createRateLimit({
  windowMs,
  maxRequests,
  keyPrefix,
}: RateLimitOptions) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const authData = (req as unknown as Record<string, unknown>).auth as
      | { userId: string }
      | undefined;
    const identifier = authData?.userId || req.ip || "unknown";

    const key = `rl:${keyPrefix}:${identifier}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    try {
      const multi = redis.multi();
      // Remove entries outside the window
      multi.zremrangebyscore(key, 0, windowStart);
      // Add current request
      multi.zadd(key, now, `${now}:${Math.random().toString(36).slice(2, 8)}`);
      // Count entries in window
      multi.zcard(key);
      // Set expiry on the key
      multi.pexpire(key, windowMs);

      const results = await multi.exec();
      if (!results) {
        next();
        return;
      }

      const count = results[2]?.[1] as number;

      if (count > maxRequests) {
        const oldestInWindow = await redis.zrange(key, 0, 0, "WITHSCORES");
        const oldestTimestamp =
          oldestInWindow.length >= 2 ? Number(oldestInWindow[1]) : now;
        const retryAfterMs = oldestTimestamp + windowMs - now;
        const retryAfterSec = Math.ceil(retryAfterMs / 1000);

        res.status(429).json({
          success: false,
          message: "Too many requests",
          retryAfterSec,
        });
        return;
      }

      next();
    } catch {
      // If Redis is unavailable, allow the request through
      next();
    }
  };
}
