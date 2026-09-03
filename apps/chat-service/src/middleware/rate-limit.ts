import type { Request, Response, NextFunction } from "express";

import { logger } from "@aimess/logger";
import { TooManyRequestsError } from "@aimess/errors";
import {
  buildApiError,
  getRequestId,
  resolveLocaleFromRequest,
} from "@aimess/utils";

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
  /** See {@link ConsumeRateLimitParams.onCacheError}. Writes pass "fallback". */
  onCacheError?: "open" | "fallback";
}

/** Log once per fail-open so a silent Redis outage is visible in the logs. */
function logFailOpen(
  keyPrefix: string,
  reason: string,
  detail?: unknown
): void {
  logger.warn("rate_limit_fail_open", {
    service: "chat-service",
    rule: keyPrefix,
    reason,
    ...(detail !== undefined ? { detail: String(detail) } : {}),
  });
}

/**
 * Per-process fallback counters, used only when Redis cannot answer.
 *
 * A write limiter that fails fully open is a limiter that disappears at exactly
 * the moment the platform is least able to absorb a flood — and it did so
 * silently. Reads may still fail open (a stale listing is harmless), but a send
 * falls back to this fixed-window counter: not cluster-wide, and reset by a
 * restart, but a real ceiling rather than none. Keyed identically to the Redis
 * bucket so the two cannot disagree about who is being limited.
 */
const fallbackCounters = new Map<string, { count: number; resetAt: number }>();

function consumeFallback(
  key: string,
  windowMs: number,
  maxRequests: number,
  tokens: number
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const existing = fallbackCounters.get(key);
  const window =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + windowMs };

  window.count += tokens;
  fallbackCounters.set(key, window);

  // Opportunistic sweep: without it a long-lived process accumulates one entry
  // per distinct user forever, which is the memory leak this map would
  // otherwise be.
  if (fallbackCounters.size > 10_000) {
    for (const [k, v] of fallbackCounters) {
      if (v.resetAt <= now) fallbackCounters.delete(k);
    }
  }

  return {
    allowed: window.count <= maxRequests,
    retryAfterSec: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
  };
}

export type ConsumeRateLimitParams = {
  keyPrefix: string;
  /** User id where the caller is authenticated; an address otherwise. */
  identifier: string;
  windowMs: number;
  maxRequests: number;
  /** Tokens this call consumes (bulk endpoints charge per item). */
  tokens?: number;
  /**
   * What to do when Redis cannot answer. `"open"` allows the call (reads),
   * `"fallback"` switches to the per-process counter above (writes).
   */
  onCacheError?: "open" | "fallback";
};

/**
 * Consume from a sliding-window bucket. The single implementation behind BOTH
 * the Express middleware below and the gRPC send paths.
 *
 * That sharing is the point. Every send limit in this service used to be
 * Express middleware on the REST router, while the socket path called the gRPC
 * `sendMessage` directly — so none of it ran there. One socket frame is cheaper
 * than one HTTP request, so the unthrottled path had the higher ceiling: an
 * authenticated client could emit `message:send` in a loop for unlimited
 * private, group and community messages, each one a database write, a Redis
 * fan-out and a push notification, and a community send fans out to every
 * member. Both entry points now consume the SAME key, so the quota is a
 * property of the user, not of the transport they chose.
 */
export async function consumeRateLimit({
  keyPrefix,
  identifier,
  windowMs,
  maxRequests,
  tokens = 1,
  onCacheError = "open",
}: ConsumeRateLimitParams): Promise<{
  allowed: boolean;
  retryAfterSec: number;
}> {
  const key = `rl:${keyPrefix}:${identifier}`;
  const now = Date.now();
  const windowStart = now - windowMs;
  const count = Math.max(1, tokens);

  // One member per token so a bulk call genuinely occupies `tokens` slots in
  // the window. The suffix keeps members unique within the same millisecond.
  const members: string[] = [];
  for (let i = 0; i < count; i += 1) {
    members.push(`${now}:${i}:${Math.random().toString(36).slice(2, 8)}`);
  }

  const degrade = (reason: string, detail?: unknown) => {
    logFailOpen(keyPrefix, reason, detail);
    return onCacheError === "fallback"
      ? consumeFallback(key, windowMs, maxRequests, count)
      : { allowed: true, retryAfterSec: 0 };
  };

  try {
    const multi = redis.multi();
    multi.zremrangebyscore(key, 0, windowStart);
    for (const member of members) multi.zadd(key, now, member);
    multi.zcard(key);
    multi.pexpire(key, windowMs);

    const results = await multi.exec();
    if (!results) return degrade("multi_exec_null");

    // ZCARD sits after ZREMRANGEBYSCORE and the N ZADDs.
    const zcardResult = results[1 + members.length];
    const commandError = zcardResult?.[0];
    const used = zcardResult?.[1];

    // The count used to be read as `results[2]?.[1] as number` with no check on
    // the per-command error slot. A single failed command made it undefined,
    // and `undefined > maxRequests` is false — so the limiter passed every
    // request through while looking healthy.
    if (commandError || typeof used !== "number") {
      return degrade("zcard_unavailable", commandError);
    }

    if (used <= maxRequests) return { allowed: true, retryAfterSec: 0 };

    // Remove the tokens THIS call just added before rejecting it.
    //
    // Without this the limiter records the very request it is refusing, so a
    // client retrying faster than `windowMs` keeps injecting members and
    // `zcard` never falls back under the limit — the user is locked out
    // indefinitely rather than for one window, and the reported retry is longer
    // than the real wait.
    await redis.zrem(key, ...members).catch((err: unknown) => {
      logFailOpen(keyPrefix, "zrem_failed", err);
    });

    const oldestInWindow = await redis.zrange(key, 0, 0, "WITHSCORES");
    const oldestTimestamp =
      oldestInWindow.length >= 2 ? Number(oldestInWindow[1]) : now;
    const retryAfterSec = Math.max(
      1,
      Math.ceil((oldestTimestamp + windowMs - now) / 1000)
    );

    return { allowed: false, retryAfterSec };
  } catch (err) {
    return degrade("redis_error", err);
  }
}

/**
 * Sliding-window rate limiter backed by a Redis sorted set.
 * Returns Express middleware that enforces the given limits.
 *
 * Read paths fail OPEN on a Redis problem: a cache outage must not take
 * messaging down. Write paths degrade to the in-process counter instead — see
 * `consumeRateLimit`. Every degraded path is logged (it used to be a bare
 * `catch { next(); }`, so an unreachable Redis silently disabled every limiter
 * in the service with no signal at all).
 */
export function createRateLimit({
  windowMs,
  maxRequests,
  keyPrefix,
  cost,
  onCacheError = "open",
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
    const tokens = Math.max(1, cost ? cost(req) : 1);

    const { allowed, retryAfterSec } = await consumeRateLimit({
      keyPrefix,
      identifier,
      windowMs,
      maxRequests,
      tokens,
      onCacheError,
    });

    if (allowed) {
      next();
      return;
    }

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
      limit: maxRequests,
      cost: tokens,
      retryAfter: retryAfterSec,
    });

    // `Retry-After` was missing entirely: the body carried a non-standard
    // `retryAfterSec` field that no client read, so every throttled client fell
    // back to guessing when to retry.
    res.setHeader("Retry-After", String(retryAfterSec));
    // Built through the shared envelope rather than written out here, so a
    // Vietnamese or Thai user is throttled in their own language. The top-level
    // `retryAfterSec` is a legacy mirror of `error.retryAfter`, kept for any
    // client already reading it.
    res.status(429).json({
      ...buildApiError({
        statusCode: 429,
        locale: req.locale ?? resolveLocaleFromRequest(req),
        messageKey: "RATE_LIMITED",
        retryAfterSec,
        requestId: getRequestId(req),
      }),
      retryAfterSec,
    });
  };
}

/**
 * The four buckets every conversation kind needs, built from one place so
 * private, group and community are throttled by the same rules rather than by
 * three independently-drifted copies.
 *
 * The shape comes from the private router, which had already been split after
 * a single shared bucket kept exhausting the SEND budget through reads:
 * opening a handful of conversations and scrolling them spends the same quota
 * a message does, so the user is told "Too many requests" when they try to
 * type. Group and community were still on that original single-bucket design —
 * one 30/min allowance covering sends, `/read`, history, search, media,
 * reactions, pins, edits, deletes and forwards — which is why they tripped
 * first and hardest.
 *
 * Numbers are per user per minute, sliding window (see {@link createRateLimit}):
 *
 *  - `send`     300 — the abuse-relevant number, and the only one a normal
 *                     typist can approach. Being a sliding window rather than a
 *                     fixed bucket, a burst of 300 is allowed immediately; it is
 *                     the sustained rate (5/s averaged over the minute) that is
 *                     capped.
 *
 *                     It was 60, which is one message per second sustained and
 *                     therefore no burst headroom at all: a normal burst — a
 *                     thought sent as six quick lines, a paste split into rows,
 *                     a forward of a selection — spends a minute's allowance in
 *                     seconds and the next message is refused. Measured driving
 *                     the real composer at 100 messages / 10ms into a group and
 *                     a community: 28 sends refused, and because each refusal
 *                     also counted against the caller's circuit breaker (see
 *                     BUSINESS_GRPC_STATUS_CODES in @aimess/grpc-utils) the
 *                     refusals cascaded into 10-second windows where every send
 *                     failed. 300 clears a WhatsApp-shaped burst of ~10-20/s
 *                     lasting a few seconds while still refusing a sustained
 *                     flood — an unattended loop is capped at 5/s, and the 429
 *                     (with `Retry-After`) it gets is unchanged.
 *  - `read`     240 — read-position writes fire on every conversation open,
 *                     every scroll to bottom and every socket reconnect
 *                     catch-up, so this has to clear a reconnect burst across
 *                     many open rooms.
 *  - `interact` 120 — reactions, pins and edits: interactive, bursty, cheap.
 *  - `sensitive` 30 — reporting, policy changes, room creation. None of these
 *                     is a normal repeated action.
 */
export function messagingRateLimits(prefix: string): {
  send: ReturnType<typeof createRateLimit>;
  read: ReturnType<typeof createRateLimit>;
  interact: ReturnType<typeof createRateLimit>;
  sensitive: ReturnType<typeof createRateLimit>;
} {
  const bucket = (
    name: keyof typeof MESSAGING_RATE_LIMITS,
    onCacheError: "open" | "fallback" = "open"
  ) =>
    createRateLimit({
      windowMs: MESSAGING_RATE_WINDOW_MS,
      maxRequests: MESSAGING_RATE_LIMITS[name],
      keyPrefix: `${prefix}:${name}`,
      onCacheError,
    });
  return {
    // Sends degrade to the in-process counter rather than failing fully open:
    // a Redis outage is exactly when an unlimited send path hurts most.
    send: bucket("send", "fallback"),
    read: bucket("read"),
    interact: bucket("interact"),
    sensitive: bucket("sensitive", "fallback"),
  };
}

/** Window every messaging bucket uses. */
export const MESSAGING_RATE_WINDOW_MS = 60_000;

/**
 * The per-user-per-minute ceilings, in one place so the REST middleware and the
 * gRPC send paths cannot drift apart. See {@link messagingRateLimits} for why
 * each number is what it is.
 */
export const MESSAGING_RATE_LIMITS = {
  send: 300,
  read: 240,
  interact: 120,
  sensitive: 30,
} as const;

/** Conversation kinds, matching the `pm` / `gm` / `cm` key prefixes. */
export type MessagingScope = "pm" | "gm" | "cm";

/**
 * Charge one send against the caller's bucket, or throw.
 *
 * Called from the gRPC handlers so the socket path is subject to the same limit
 * as the REST route — same key, same window, same ceiling — instead of being an
 * unmetered door to the identical write. `TooManyRequestsError` maps to gRPC
 * RESOURCE_EXHAUSTED, which the gateway already translates into a `RATE_LIMITED`
 * socket ack, so the client is told to back off rather than left hanging.
 */
export async function assertSendAllowed(
  scope: MessagingScope,
  userId: string
): Promise<void> {
  const { allowed, retryAfterSec } = await consumeRateLimit({
    keyPrefix: `${scope}:send`,
    identifier: userId,
    windowMs: MESSAGING_RATE_WINDOW_MS,
    maxRequests: MESSAGING_RATE_LIMITS.send,
    onCacheError: "fallback",
  });

  if (allowed) return;

  logger.warn("rate_limit_exceeded", {
    service: "chat-service",
    rule: `${scope}:send`,
    scope: "user",
    scopeKey: userId,
    transport: "grpc",
    limit: MESSAGING_RATE_LIMITS.send,
    retryAfter: retryAfterSec,
  });

  throw new TooManyRequestsError("RATE_LIMITED", retryAfterSec);
}
