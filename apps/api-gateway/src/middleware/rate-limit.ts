import { createHash } from "node:crypto";

import rateLimit, {
  ipKeyGenerator,
  type Options,
  type RateLimitInfo,
} from "express-rate-limit";
import type { Request, Response } from "express";

import { logger } from "@aimess/logger";
import { verifyAccessToken } from "@aimess/auth-jwt";
import { sendApiError, getRequestId } from "@aimess/utils";

import { env, accessTokenVerifyConfig } from "../config/env.js";
import { RedisRateLimitStore } from "./redis-rate-limit-store.js";

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
 * Bucket key for an authenticated caller.
 *
 * Keyed on the VERIFIED `sub` claim where the token verifies, and
 * on a digest of the raw token otherwise.
 *
 * It used to be the token digest unconditionally, on the reasoning that
 * decoding an unverified JWT would let a caller forge any subject — correct as
 * far as it goes, but it made the bucket a property of the TOKEN rather than of
 * the user. One refresh call yields a brand-new access token and therefore a
 * brand-new quota, so the ceiling was worth ~100 requests per refresh rather
 * than 100 per window. Refresh itself carries no Authorization header and fell
 * to the IP bucket, so the whole loop cost one request.
 *
 * Verifying the signature here removes the forgery objection entirely: a
 * subject that survives `verifyAccessToken` was minted by auth-service, and a
 * caller cannot vary it without a valid token for that user. Verification is a
 * single HMAC over a short string — cheaper than the SHA-256 it replaces on the
 * same request path.
 *
 * A token that does not verify (expired, malformed, wrong secret) still gets a
 * bucket, keyed by digest: it must be limited, and it has no trustworthy
 * identity to key on. Downstream services remain the authority on whether the
 * request is authorized at all — this only decides which counter it lands in.
 */
function credentialKey(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;

  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token.length === 0) return undefined;

  try {
    const { userId } = verifyAccessToken(token, accessTokenVerifyConfig);
    return `u:${userId}`;
  } catch {
    // Not a valid user token — bucket it by digest rather than letting it
    // escape limiting or share the bucket of a real user.
    return `s:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
  }
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
    // request body, and any OTP/password field. `scopeKey` is either the user
    // id — the app's own opaque identifier, not a credential — or a truncated
    // digest of an unverifiable token. Neither is usable to authenticate.
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
 * Counters live in Redis, shared by every replica and surviving a restart.
 *
 * They used to be per-process and in-memory, so a redeploy handed an attacker a
 * fresh budget, and a second replica would have multiplied every limit by the
 * replica count — selectably, since the API's nginx config uses `ip_hash`.
 * See `redis-rate-limit-store.ts` for the fail-open policy on a Redis outage.
 *
 * One store instance per limiter: express-rate-limit calls `init()` on each
 * with that limiter's own window, and sharing one would give them all whichever
 * window initialised last.
 */
function createLimiter({ rule, windowMs, max, scope, skip }: LimiterSpec) {
  return rateLimit({
    windowMs,
    max,
    // `undefined` leaves express-rate-limit on its own in-process store, which
    // is what the test harness and a single-process local run want. Production
    // cannot select it — see the boot assertion in config/env.ts.
    store:
      env.RATE_LIMIT_STORE === "redis" ? new RedisRateLimitStore() : undefined,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip,
    validate: {
      trustProxy: env.TRUST_PROXY_HOPS > 0,
      // The custom generator returns a user id (or a token digest) for
      // authenticated callers, which this validator would otherwise flag as a
      // non-IP key.
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
  // `/docs` is no longer exempt. It used to be, while the OpenAPI document was
  // rebuilt from scratch on every request (~400 KB) — an unauthenticated,
  // unmetered CPU and bandwidth amplifier on the only public edge. The docs are
  // now non-production only, and metered even there.
  //
  // The version check is an EXACT suffix match, not `includes`: as a substring
  // test, any routed path that merely contained the string escaped the global
  // limiter, which is a bypass anyone could construct.
  return (
    path.startsWith("/health") ||
    path.endsWith("/app-version/check") ||
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

/**
 * Presigned upload-URL minting (`POST /api/v1/media/upload-url` and the
 * `/users/uploads/url` alias). Session-scoped and write-shaped: each call hands
 * out an object-store write grant, so it is sized like device-token
 * registration rather than like a read. It had no dedicated limiter at all,
 * which combined badly with the presigned PUT not binding a content length.
 */
export const mediaRateLimiter = createLimiter({
  rule: "media.upload-url",
  windowMs: 60 * 1000,
  max: 30,
  scope: "session",
});

/** Free-text search. Tighter than plain reads — each call fans out downstream. */
export const searchRateLimiter = createLimiter({
  rule: "search",
  windowMs: 60 * 1000,
  max: env.SEARCH_RATE_LIMIT_MAX,
  scope: "session",
});
