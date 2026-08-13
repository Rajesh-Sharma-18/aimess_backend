import type { Request, Response, NextFunction } from "express";

import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
  /**
   * Tokens this request consumes. Defaults to 1.
   *
   * Bulk endpoints take up to 50 room ids and fan out one mutation per id, so
   * charging them a single token let one caller drive 50x the work of a plain
   * write for the same quota. Returning `ids.length` makes the limiter
   * batch-aware: the cost tracks the work, and a legitimate one-item bulk call
   * is charged like the single-item endpoint it is equivalent to.
   *
   * Runs AFTER body validation (see the route mounts), so the body is parsed
   * and safe to read here.
   */
  cost?: (req: Request) => number;
}

/** Log once per fail-open so a silent Redis outage is visible in the logs. */
function logFailOpen(keyPrefix: string, reason: string, detail?: unknown): void {
  logger.warn("rate_limit_fail_open", {
    service: "chat-service",
    rule: keyPrefix,
    reason,
    ...(detail !== undefined ? { detail: String(detail) } : {}),
  });
}

/**
 * Sliding-window rate limiter backed by a Redis sorted set.
 * Returns Express middleware that enforces the given limits.
 *
 * Fails OPEN on any Redis problem: a cache outage must not take messaging down.
 * Every fail-open path is logged (it used to be a bare `catch { next(); }`, so
 * an unreachable Redis silently disabled every limiter in the service with no
 * signal at all).
 */
export function createRateLimit({
  windowMs,
  maxRequests,
  keyPrefix,
  cost,
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

    const tokens = Math.max(1, cost ? cost(req) : 1);
    // One member per token so a bulk call genuinely occupies `tokens` slots in
    // the window. The suffix keeps members unique within the same millisecond.
    const members: string[] = [];
    for (let i = 0; i < tokens; i += 1) {
      members.push(`${now}:${i}:${Math.random().toString(36).slice(2, 8)}`);
    }

    try {
      const multi = redis.multi();
      // Remove entries outside the window
      multi.zremrangebyscore(key, 0, windowStart);
      // Add this request's tokens
      for (const member of members) {
        multi.zadd(key, now, member);
      }
      // Count entries in window
      multi.zcard(key);
      // Set expiry on the key
      multi.pexpire(key, windowMs);

      const results = await multi.exec();
      if (!results) {
        logFailOpen(keyPrefix, "multi_exec_null");
        next();
        return;
      }

      // ZCARD sits after ZREMRANGEBYSCORE and the N ZADDs.
      const zcardResult = results[1 + members.length];
      const commandError = zcardResult?.[0];
      const count = zcardResult?.[1];

      // Previously the count was read as `results[2]?.[1] as number` with no
      // check on the per-command error slot. A single failed command made
      // `count` undefined, and `undefined > maxRequests` is false — so the
      // limiter silently passed every request through while looking healthy.
      if (commandError || typeof count !== "number") {
        logFailOpen(keyPrefix, "zcard_unavailable", commandError);
        next();
        return;
      }

      if (count > maxRequests) {
        // Remove the tokens THIS request just added before rejecting it.
        //
        // Without this the limiter records the very request it is refusing, so
        // a client retrying faster than `windowMs` keeps injecting members and
        // `zcard` never falls back under the limit — the user is locked out
        // indefinitely rather than for one window, and the `retryAfterSec` it
        // reports (computed from the oldest member, which now includes rejected
        // attempts) is longer than the real wait. Same class of bug as the
        // delete-account lockout fixed on 2026-08-12.
        await redis.zrem(key, ...members).catch((err: unknown) => {
          logFailOpen(keyPrefix, "zrem_failed", err);
        });

        const oldestInWindow = await redis.zrange(key, 0, 0, "WITHSCORES");
        const oldestTimestamp =
          oldestInWindow.length >= 2 ? Number(oldestInWindow[1]) : now;
        const retryAfterMs = oldestTimestamp + windowMs - now;
        const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));

        logger.warn("rate_limit_exceeded", {
          service: "chat-service",
          rule: keyPrefix,
          scope: authData?.userId ? "user" : "ip",
          // The user id is the app's own opaque identifier, not a credential.
          scopeKey: authData?.userId,
          method: req.method,
          endpoint: req.originalUrl.split("?")[0],
          platform: req.headers["x-platform"],
          requestId: req.headers["x-request-id"],
          current: count,
          limit: maxRequests,
          cost: tokens,
          retryAfter: retryAfterSec,
        });

        // `Retry-After` was missing entirely: the body carried a non-standard
        // `retryAfterSec` field that no client read, so every throttled client
        // fell back to guessing when to retry.
        res.setHeader("Retry-After", String(retryAfterSec));
        res.status(429).json({
          success: false,
          message: "Too many requests, please try again later.",
          // Retained for any client already reading it.
          retryAfterSec,
          error: {
            statusCode: 429,
            code: "RATE_LIMITED",
            message: "Too many requests, please try again later.",
            retryAfter: retryAfterSec,
            retryable: true,
          },
        });
        return;
      }

      next();
    } catch (err) {
      // If Redis is unavailable, allow the request through
      logFailOpen(keyPrefix, "redis_error", err);
      next();
    }
  };
}
