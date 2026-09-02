import { createHash } from "node:crypto";

import rateLimit, {
  ipKeyGenerator,
  type Options,
  type RateLimitInfo,
} from "express-rate-limit";
import type { Request, Response } from "express";

import { logger } from "@aimess/logger";
import { sendApiError, getRequestId } from "@aimess/utils";

import { env } from "../config/env.js";

/**
 * How a limiter buckets callers.
 *
 * `ip` — for genuinely anonymous endpoints (login, invite-link preview). The
 * caller has no identity yet, so the network address is the only handle. This
 * is the correct scope for credential-stuffing defence.
 *
 * `session` — for endpoints reached with a bearer token. Keying these by IP was
 * the single biggest source of spurious "Too many requests": one office, campus,
 * mobile carrier CGNAT or corporate VPN presents ONE address, so N legitimate
 * users shared one bucket and the Nth user was throttled for the first user's
 * traffic. Bucketing per credential removes that entirely without weakening
 * anything — an attacker cannot mint extra tokens without first passing the
 * IP-keyed auth limiters.
 *
 * Anonymous requests under `session` scope fall back to the IP bucket, so an
 * unauthenticated caller can never escape limiting by omitting the header.
 */
export type LimitScope = "ip" | "session";

/**
 * Bucket key for an authenticated caller: a truncated SHA-256 of the bearer
 * token. The raw token is never stored, logged or used as a Redis/Map key —
 * only this digest — so a memory dump or a log line cannot yield a usable
 * credential. Truncation to 32 hex chars (128 bits) is far beyond collision
 * range for the number of concurrent sessions.
 *
 * The token is used rather than the decoded `sub` claim deliberately: decoding
 * an UNVERIFIED JWT here would let a caller forge any subject and mint an
 * unlimited number of fresh buckets. The gateway does not verify JWTs on
 * proxied routes (downstream services do), so the opaque token string is the
 * only value available that an attacker cannot cheaply vary.
 */
function credentialKey(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;

  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token.length === 0) return undefined;

  return `s:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}

function makeKeyGenerator(scope: LimitScope) {
  return (req: Request): string => {
    if (scope === "session") {
      const key = credentialKey(req);
      if (key) return key;
    }
    // `ipKeyGenerator` normalizes IPv6 to a /56 so a single client cannot walk
    // its own prefix to get a fresh bucket per request.
    return ipKeyGenerator(req.ip ?? "unknown");
  };
}

/**
 * Structured 429 handler shared by every limiter.
 *
 * Replaces express-rate-limit's `message` option. The default writes a bare
 * `{ success, message }` body with no machine-readable code, so a client could
 * not tell a throttle apart from any other 4xx and had nothing to wait on
 * except a header it was not reading. This emits the documented envelope
 * (`error.code = RATE_LIMITED`, `error.retryAfter`, `error.retryable`) and logs
 * one structured line per rejection.
 *
 * `Retry-After` itself is already set by express-rate-limit before the handler
 * runs (it calls `setRetryAfterHeader` whenever `standardHeaders` is truthy);
 * `sendApiError` sets it again from the same value, which is idempotent.
 */
function makeHandler(rule: string, scope: LimitScope) {
  return (req: Request, res: Response): void => {
    const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit;
    const retryAfterSec =
      info?.resetTime instanceof Date
        ? Math.max(0, Math.ceil((info.resetTime.getTime() - Date.now()) / 1000))
        : undefined;

    // Deliberately excluded: the Authorization header, the raw token, the
    // request body, and any OTP/password field. `scopeKey` is the truncated
    // digest, which identifies the bucket without being a usable credential.
    logger.warn("rate_limit_exceeded", {
      rule,
      scope,
      scopeKey: scope === "session" ? credentialKey(req) : undefined,
      ip: req.ip,
      method: req.method,
      endpoint: req.originalUrl.split("?")[0],
      platform: req.headers["x-platform"],
      requestId: getRequestId(req),
      current: info?.used,
      limit: info?.limit,
      retryAfter: retryAfterSec,
      service: "api-gateway",
    });

    sendApiError(req, res, {
      statusCode: 429,
      messageKey: "RATE_LIMITED",
      retryAfterSec,
    });
  };
}

type LimiterSpec = {
  /** Stable identifier used in logs and metrics. */
  rule: string;
  windowMs: number;
  max: number;
  scope: LimitScope;
  skip?: Options["skip"];
};

/**
 * NOTE: every limiter here uses express-rate-limit's default in-memory store —
 * one counter per Node process, not shared across replicas, wiped on restart.
 * That is unchanged by this refactor. Swapping in `rate-limit-redis` requires
 * `passOnStoreError: true` as well, or a Redis blip turns every request into a
 * 500 instead of failing open.
 */
function createLimiter({ rule, windowMs, max, scope, skip }: LimiterSpec) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip,
    validate: {
      trustProxy: env.TRUST_PROXY_HOPS > 0,
      // The custom generator returns a token digest for authenticated callers,
      // which this validator would otherwise flag as a non-IP key.
      keyGeneratorIpFallback: false,
    },
    keyGenerator: makeKeyGenerator(scope),
    handler: makeHandler(rule, scope),
  });
}

/** Liveness/readiness and docs never count against any quota. */
function skipRateLimit(req: Request): boolean {
  // Previously `NODE_ENV === "development"` disabled the global limiter
  // outright. That bundled three unrelated switches into one variable (CORS
  // origin checking and the gRPC service-token check read the same flag), and
  // it meant the limiter was never exercised before production — the one
  // environment where it bites. `RATE_LIMIT_ENABLED` unbundles it: dev sets it
  // false explicitly, and the value is visible in the deployment config
  // instead of being implied by NODE_ENV.
  if (!env.RATE_LIMIT_ENABLED) return true;
  const path = req.path ?? "";
  return (
    path.startsWith("/health") ||
    path.startsWith("/docs") ||
    path.includes("/app-version/check") ||
    // SRS callbacks are metered by `srsHookRateLimiter` instead, not exempted.
    // They cannot share the global bucket: every hook for every stream arrives
    // from the one SRS server address with no Authorization header, so they
    // collapse into a single IP bucket, and `on_play` fires once per VIEWER —
    // a busy stream would exhaust the 100/window global cap in seconds and get
    // its on_publish denied.
    path.startsWith("/internal/srs")
  );
}

/**
 * Global HTTP rate limit — the outermost backstop, not the operation limit.
 *
 * Session-scoped, so a shared egress IP no longer collapses every user in an
 * office into one bucket. Anonymous traffic still falls back to per-IP.
 */
export const rateLimiter = createLimiter({
  rule: "global",
  windowMs: env.GLOBAL_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: env.GLOBAL_RATE_LIMIT_MAX,
  scope: "session",
  skip: skipRateLimit,
});

/**
 * Sensitive auth endpoints (login, password reset, social sign-in).
 * Deliberately IP-scoped: the caller has no credential yet, and per-IP is
 * exactly the axis a credential-stuffing run varies least. Defence-in-depth on
 * top of the account-level lockout in auth-service.
 */
export const sensitiveAuthRateLimiter = createLimiter({
  rule: "auth.sensitive",
  windowMs: env.SENSITIVE_AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: env.SENSITIVE_AUTH_RATE_LIMIT_MAX,
  scope: "ip",
});

/**
 * OTP verification and resend. Split out from `auth.sensitive` because the
 * traffic shape is different — a user legitimately retries an OTP two or three
 * times in a minute, where a login retry that often is already suspicious.
 * IP-scoped for the same reason as above: pre-authentication.
 */
export const otpRateLimiter = createLimiter({
  rule: "auth.otp",
  windowMs: env.OTP_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: env.OTP_RATE_LIMIT_MAX,
  scope: "ip",
});

/** Whole admin surface — low volume, high privilege, isolated from user traffic. */
export const adminRateLimiter = createLimiter({
  rule: "admin.global",
  windowMs: env.ADMIN_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: env.ADMIN_RATE_LIMIT_MAX,
  scope: "session",
});

/** Admin login/refresh. IP-scoped — credential-stuffing guard, pre-authentication. */
export const adminLoginRateLimiter = createLimiter({
  rule: "admin.login",
  windowMs: env.ADMIN_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: env.ADMIN_LOGIN_RATE_LIMIT_MAX,
  scope: "ip",
});

/**
 * SRS media-server callbacks (POST /internal/srs/hooks).
 *
 * This route is unauthenticated at the edge by necessity — SRS cannot attach a
 * JWT — and it accepts a 1 MB body which the gateway relays upstream, so
 * unmetered it is an amplifier pointed at stream-service. It cannot use the
 * global limiter (see `skipRateLimit`), so it gets its own bucket sized for
 * real hook volume: every hook for every stream comes from the one SRS address,
 * and `on_play`/`on_stop` fire once per viewer per stream. The cap is
 * deliberately generous — the goal is a ceiling on a flood, not a quota a busy
 * broadcast could hit.
 *
 * Note the ceiling is per gateway process (in-memory store, like every limiter
 * here), and stream-service still rejects every hook that fails
 * SRS_HOOK_SECRET.
 */
export const srsHookRateLimiter = createLimiter({
  rule: "srs.hooks",
  windowMs: 60 * 1000,
  max: 3000,
  scope: "ip",
});

/**
 * Public invite-link preview (GET /communities/invite-links/:code). No auth →
 * enumeration risk, so IP-scoped by design.
 */
export const inviteLinkPreviewRateLimiter = createLimiter({
  rule: "community.invite-preview",
  windowMs: 15 * 60 * 1000,
  max: 30,
  scope: "ip",
});

/**
 * Forgot-password OTP endpoints. Looser than `auth.sensitive` because users
 * legitimately retry during a reset flow, tighter than the global backstop.
 */
export const forgotPasswordRateLimiter = createLimiter({
  rule: "auth.forgot-password",
  windowMs: 15 * 60 * 1000,
  max: 10,
  scope: "ip",
});

/**
 * FCM/APNs device-token registration. Session-scoped: registration happens once
 * per login or token rotation, and the caller is always authenticated, so the
 * previous IP scope throttled the tenth user behind a NAT for the first nine
 * users' logins.
 */
export const deviceTokenRateLimiter = createLimiter({
  rule: "device.token-register",
  windowMs: 60 * 1000,
  max: 10,
  scope: "session",
});

/**
 * Read-heavy, client-polled endpoints (search, sync, listing). Generous — the
 * point is to bound a runaway client loop, not to shape normal browsing. A read
 * limit set anywhere near a write limit is what makes an application feel
 * broken to a legitimate user.
 */
export const readRateLimiter = createLimiter({
  rule: "read.generous",
  windowMs: 60 * 1000,
  max: env.READ_RATE_LIMIT_MAX,
  scope: "session",
});

/** Free-text search. Tighter than plain reads — each call fans out downstream. */
export const searchRateLimiter = createLimiter({
  rule: "search",
  windowMs: 60 * 1000,
  max: env.SEARCH_RATE_LIMIT_MAX,
  scope: "session",
});
