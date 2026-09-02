import type { AccessTokenSigningKey } from "@aimess/auth-jwt";
import dotenv from "dotenv";
import { z } from "zod";

import { assertNoPlaceholderCredentials, expandFileSecrets } from "@aimess/utils";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),

  AUTH_SERVICE_PORT: z.coerce.number(),
  AUTH_GRPC_PORT: z.coerce.number().positive().default(4001),

  AUTH_DATABASE_URL: z.string(),

  REDIS_HOST: z.string(),
  REDIS_PORT: z.coerce.number(),
  // Optional so local dev against an unauthenticated Redis keeps working.
  // Required for any shared/remote Redis, which must not be left open.
  REDIS_PASSWORD: z.string().optional(),
  /**
   * Wrap the Redis connection in TLS. Off by default so a loopback or
   * private-network Redis is unchanged; set true wherever the connection leaves
   * the host, because the AUTH password and — since Redis pub/sub is the
   * realtime fan-out — every message body otherwise travel in cleartext.
   */
  REDIS_TLS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // `.min(32)`: both were bare `z.string()`, so a truncated deploy variable or a
  // bad shell quote yielded "" or "x" and still booted the ISSUER of every token
  // on the platform. A single-character HS256 secret is recovered offline in
  // seconds from one captured token, after which an attacker mints access
  // tokens for arbitrary user ids that every service accepts.
  JWT_ACCESS_SECRET: z.preprocess(
    (v) => (v === "" ? undefined : v),
    // Optional so a deployment that has moved to the keypair can REMOVE
    // it entirely — which is the whole point of the migration. The boot
    // assertion below requires one of the two.
    z.string().min(32).optional()
  ),
  /**
   * RS256 public key that verifies access tokens (PEM).
   *
   * The platform-wide fix for one symmetric secret being copied into eight
   * services: with a keypair, auth-service alone holds the private half and is
   * the only process able to MINT a token, while every other service holds only
   * this public half, which is not a secret. A leak from any service other than
   * auth-service then discloses nothing that can forge a session.
   *
   * Optional during the migration — set it alongside JWT_ACCESS_SECRET and both
   * are accepted, so tokens signed before the switch keep verifying until they
   * expire. Supply it as JWT_ACCESS_PUBLIC_KEY_FILE to mount it as a file.
   */
  JWT_ACCESS_PUBLIC_KEY: z.string().optional(),
  /**
   * Reject access tokens that carry no `iss`/`aud`. Leave false until every
   * token minted before those claims existed has expired (one access-token
   * lifetime after deploying), then turn it on.
   */
  JWT_REQUIRE_ISSUER_AUDIENCE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * RS256 private key used to SIGN access tokens (PEM). auth-service only.
   *
   * When set, tokens are signed with it instead of the shared secret, so no
   * other service can mint one. Supply as JWT_ACCESS_PRIVATE_KEY_FILE to mount
   * it as a file rather than an environment variable.
   */
  JWT_ACCESS_PRIVATE_KEY: z.string().optional(),
  JWT_REFRESH_SECRET: z.string().min(32),
  /**
   * Leading zero bits required in a signup proof-of-work solution.
   *
   * The cost knob for account creation and handle-availability probing. 20 bits
   * is roughly a million hashes: a fraction of a second on a phone, and a
   * million times that for someone enumerating a million handles. Raise it if
   * the platform is under a signup flood — the cost is paid entirely by the
   * caller, so raising it hurts an attacker far more than a real user.
   *
   * Lowered in the test harness so suites do not spend their runtime hashing.
   */
  SIGNUP_CHALLENGE_DIFFICULTY_BITS: z.coerce.number().int().min(1).max(32).default(20),
  CORS_ALLOWED_ORIGINS: z.string().min(1),
  JWT_ACCESS_EXPIRES_IN: z.string(),
  JWT_REFRESH_EXPIRES_IN: z.string(),
  /**
   * Refresh-token lifetime (seconds) when the user opts into "remember me" at
   * login. Falls back to 30 days. The access-token lifetime is unaffected.
   */
  JWT_REFRESH_EXPIRES_IN_REMEMBER_ME: z.string().default("2592000"),

  RABBITMQ_URL: z.string().min(1),

  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SECONDS: z.coerce.number().positive().default(600),
  OTP_MAX_ATTEMPTS: z.coerce.number().positive().default(5),
  PASSWORD_RESET_TOKEN_TTL_SECONDS: z.coerce.number().positive().default(900),

  /** Failed-login attempts before the account is temporarily locked. */
  AUTH_MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(5),
  /** Lockout window (minutes) applied once the failed-login threshold is hit. */
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  /** Max OTP issuance requests per identifier within the window below. */
  OTP_REQUEST_MAX: z.coerce.number().int().positive().default(5),
  /** Sliding window (seconds) for the OTP issuance throttle. */
  OTP_REQUEST_WINDOW_SEC: z.coerce.number().int().positive().default(900),
  /** Dev only: fixed OTP (e.g. 123456). Logged in terminal until email is wired up. */
  OTP_DEV_FIXED_CODE: z.string().optional(),

  /** Max failed auth attempts (register, login, password reset, etc.) within 15-min window. */
  SENSITIVE_AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  SENSITIVE_AUTH_RATE_LIMIT_WINDOW_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(15),
  // DELETE_ACCOUNT_RATE_LIMIT_MAX removed 2026-08-12 — DELETE /auth/account is
  // no longer throttled. Leaving the variable set in a .env file is harmless;
  // nothing reads it.

  /** Max POST /auth/change-password attempts per hour per user. The endpoint
   *  verifies `currentPassword`, so an unthrottled one is an offline-speed
   *  password oracle for anyone holding a stolen access token. */
  CHANGE_PASSWORD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),

  /** Proxy hops to trust for rate limiting IP detection (0 = no proxy, 1+ = trust X-Forwarded-For). */
  /**
   * Account-purge sweeper. `DELETE /api/auth/account` records a 30-day
   * `scheduledDeletionAt` that nothing used to read, so no account was ever
   * actually erased — see jobs/account-purge-sweeper.ts.
   */
  ACCOUNT_PURGE_SWEEP_INTERVAL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
  ACCOUNT_PURGE_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),

  /** QR device-link session lifetime (seconds) — spec: 60s. */
  QR_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  /** Max QR generation requests per minute per IP (spec: 5). */
  QR_GENERATION_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  /** Max QR scan requests per minute per user/IP (spec: 10). */
  QR_SCAN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /**
   * Extra seconds the Redis key survives PAST `expiresAt` so the expiry
   * sweeper (which ticks every QR_LINK_SWEEPER_INTERVAL_MS) has a window to
   * observe + atomically mark a still-PENDING/SCANNED session EXPIRED before
   * Redis's own TTL garbage-collects the key out from under it.
   */
  QR_LINK_SWEEP_GRACE_SECONDS: z.coerce.number().int().positive().default(30),
  QR_LINK_SWEEPER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  QR_LINK_SWEEPER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000),

  /**
   * Google OAuth 2.0 client IDs (Google Cloud Console → Credentials), one per
   * mobile platform. Both are passed to `google-auth-library` as the accepted
   * `aud` array — the token is accepted if its `aud` claim matches either —
   * so the backend serves both apps without the client declaring its platform.
   *
   * Both optional; if BOTH are unset, Google login/link is disabled
   * (see lib/google-id-token.ts).
   */
  GOOGLE_OAUTH_APPLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_ANDROID_CLIENT_ID: z.string().min(1).optional(),

  /**
   * Comma-separated list of accepted Apple `aud` values — the Bundle ID(s)
   * (native Sign in with Apple) and/or Service ID(s) (web). Apple ID tokens
   * are verified against Apple's JWKS directly (see lib/apple-id-token.ts);
   * Firebase is not in the path.
   */
  APPLE_CLIENT_IDS: z.string().min(1).optional(),

  /**
   * Base URL of notifications-service. Used by the dev-only test push endpoint
   * to forward FCM token lists for delivery. Defaults to local dev.
   */
  NOTIFICATIONS_SERVICE_URL: z.string().url().default("http://localhost:3006"),

  /** chat-service gRPC address — used to update login-notification status on Terminate/Trust. */
  CHAT_SERVICE_GRPC_URL: z.string().min(1).default("localhost:4004"),

  /** backoffice-service gRPC address — used to reject emails already used by an admin account. */
  BACKOFFICE_GRPC_URL: z.string().min(1).default("localhost:4010"),
});

// `FOO_FILE=/run/secrets/foo` supplies `FOO`, so a secret can be a mounted
// file (Docker/Kubernetes secrets) instead of an environment variable that
// leaks through /proc, crash dumps, `docker inspect` and CI logs — and so
// rotation is replacing a file rather than editing .env on every host.
const expanded = expandFileSecrets(process.env);
const parsed = envSchema.safeParse(expanded);

if (!parsed.success) {
  console.error("Invalid Environment Variables");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

// Refuse to start a production deployment whose credentials are values
// published in this repository. The schema can see that a string is present and
// long enough; it cannot see that everyone already knows what it says. Matched
// by variable NAME shape, so a secret added tomorrow is covered without anyone
// remembering to extend a list.
try {
  assertNoPlaceholderCredentials(expanded, {
    nodeEnv: env.NODE_ENV,
    serviceName: "auth-service",
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}


/**
 * How this service verifies access tokens.
 *
 * One object rather than a bare secret, because verification now has three
 * inputs: the legacy shared secret, the RS256 public key that replaces it, and
 * whether `iss`/`aud` are mandatory yet. Every call site takes this, so they
 * cannot drift apart — and so moving to a keypair is a configuration change
 * rather than a code change in each service.
 */
/**
 * The key auth-service signs access tokens with.
 *
 * Prefers the RS256 private key. That is the whole point of the migration: with
 * a keypair, this process is the ONLY one that can mint a token, and every
 * other service holds a public key that forges nothing. While the private key
 * is unset, signing falls back to the shared secret and behaviour is unchanged.
 *
 * Resolved once, at import, so a misconfiguration surfaces at boot rather than
 * on a user's first login.
 */
export const accessTokenSigningKey: AccessTokenSigningKey =
  env.JWT_ACCESS_PRIVATE_KEY
    ? { alg: "RS256", privateKey: env.JWT_ACCESS_PRIVATE_KEY }
    : (() => {
        if (!env.JWT_ACCESS_SECRET) {
          console.error(
            "Refusing to start: auth-service must be able to SIGN access tokens — set JWT_ACCESS_PRIVATE_KEY (preferred) or JWT_ACCESS_SECRET."
          );
          process.exit(1);
        }
        return { alg: "HS256", secret: env.JWT_ACCESS_SECRET };
      })();

export const accessTokenVerifyConfig = {
  secret: env.JWT_ACCESS_SECRET,
  publicKey: env.JWT_ACCESS_PUBLIC_KEY,
  requireIssuerAudience: env.JWT_REQUIRE_ISSUER_AUDIENCE,
};

/**
 * Refuse to start with no way to verify a token at all.
 *
 * The schema cannot express "one of these two", and a service that boots
 * without either would reject every request — or, worse, a future refactor
 * could make it accept them unverified.
 */
if (!env.JWT_ACCESS_SECRET && !env.JWT_ACCESS_PUBLIC_KEY) {
  console.error(
    "Refusing to start: set JWT_ACCESS_PUBLIC_KEY (preferred) or JWT_ACCESS_SECRET — without one, no access token can be verified."
  );
  process.exit(1);
}
