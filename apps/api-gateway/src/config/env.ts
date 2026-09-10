import dotenv from "dotenv";
import type { Request } from "express";
import { z } from "zod";

import {
  adminIpWhitelistFailures,
  assertNoPlaceholderCredentials,
  expandFileSecrets,
} from "@aimess/utils";

import type { AppVersionConfig } from "../app-version/types.js";

dotenv.config();

const semverLike = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+){0,2}$/);

const envSchema = z.object({
  /**
   * Required, with no default. The gateway is the only public edge and several
   * controls key off this value (CORS origin enforcement, the rate-limit
   * production assertion below). A defaulted "development" meant a dropped or
   * misspelled variable silently downgraded the edge instead of failing the
   * boot, so it is now required — matching the other seven services.
   */
  NODE_ENV: z.enum(["development", "production", "test"]),
  API_GATEWAY_PORT: z.coerce.number().positive(),
  AUTH_SERVICE_URL: z.string().url(),
  USER_SERVICE_URL: z.string().url().optional(),
  COMMUNITY_SERVICE_URL: z.string().url().optional(),
  CHAT_SERVICE_URL: z.string().url().optional(),
  /** Notification service REST URL — used by /api/v1/devices for FCM/APNs token registration. */
  NOTIFICATION_SERVICE_URL: z.string().url().optional(),
  MEDIA_SERVICE_URL: z.string().url().optional(),
  MEDIA_GRPC_URL: z.string().min(1).default("0.0.0.0:4009"),
  /** Stream service REST URL — gated proxy for /api/v1/streams/*. */
  STREAM_SERVICE_URL: z.string().url().optional(),
  AUTH_GRPC_URL: z.string().optional(),
  USER_GRPC_URL: z.string().optional(),
  /** gRPC URLs for socket-facing services (required — sockets cannot operate without them). */
  CHAT_GRPC_URL: z.string().min(1),
  COMMUNITY_GRPC_URL: z.string().min(1),
  NOTIFICATION_GRPC_URL: z.string().min(1),
  /** stream-service gRPC URL (livestream comments) — used by the /stream socket namespace. */
  STREAM_GRPC_URL: z.string().min(1).default("0.0.0.0:4007"),
  /**
   * Same JWT secret as auth-service — used by socket auth middleware.
   *
   * `.min(32)`: an HS256 secret shorter than that is brute-forceable offline
   * from a single captured token, and this one value is shared by every service
   * that verifies user tokens, so one weak setting is a platform-wide forgery
   * primitive rather than one service's problem.
   */
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
  /** Downstream backoffice (admin) service. */
  BACKOFFICE_SERVICE_URL: z.string().url().optional(),
  /**
   * Admin JWT secret — edge signature/exp check on /admin/* (not jti blacklist).
   *
   * Optional only so a deployment that runs no admin surface can boot; when
   * BACKOFFICE_SERVICE_URL is set the assertion below makes it mandatory, so
   * the /admin proxy can never be mounted without its verifier.
   */
  // An empty value is treated as "not set" (same preprocessing media-service
  // uses), so `JWT_ADMIN_SECRET=` in a dotfile produces the clear "required
  // whenever BACKOFFICE_SERVICE_URL is set" failure below rather than an opaque
  // string-length complaint.
  JWT_ADMIN_SECRET: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(32).optional()
  ),
  /**
   * Comma-separated admin IP allowlist. Empty is allowed only outside
   * production; see the boot assertion below, which refuses to start a
   * production gateway whose admin surface is reachable from anywhere.
   */
  ADMIN_IP_WHITELIST: z.string().default(""),
  ADMIN_RATE_LIMIT_WINDOW_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(15),
  ADMIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  ADMIN_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string(),
  CORS_ALLOWED_ORIGINS: z.string(),
  /**
   * Comma-separated request headers reflected in the CORS preflight's
   * `Access-Control-Allow-Headers`. Must list every custom header the browser
   * sends (e.g. `x-lang`) — a header absent here makes the browser block the
   * request at preflight even when the origin is allowed. Defaults cover the
   * standard auth/content headers plus the `x-lang` locale header the web
   * client sends on every request.
   */
  CORS_ALLOWED_HEADERS: z.string().default("Content-Type,Authorization,x-lang"),
  /**
   * Escape hatch for dev tunnels (VS Code Dev Tunnels, ngrok), which mint a new
   * hostname per session so a static allowlist breaks on every rotation.
   *
   * This replaces the old `NODE_ENV === "development"` short-circuit in
   * {@link isCorsOriginAllowed}: that bundled the origin check onto a variable
   * that also gated unrelated behaviour, and any environment that was not
   * exactly "production" reflected the caller's own Origin back with
   * `Access-Control-Allow-Credentials: true`. The switch is now explicit,
   * visible in the deployment config, and asserted false in production below.
   */
  CORS_ALLOW_ANY_ORIGIN: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  API_PUBLIC_URL: z.string().url().optional(),
  /** Comma-separated Swagger server URLs (e.g. localhost + LAN IP). */
  SWAGGER_SERVER_URLS: z.string().optional(),

  /**
   * Master switch for HTTP rate limiting. Previously this was implied by
   * `NODE_ENV === "development"`, which also gates CORS origin checking and the
   * gRPC service-token check — three unrelated controls on one variable. Set it
   * to `false` in local dev and in the E2E harness; leave it true everywhere
   * else. Health and docs paths are skipped regardless.
   */
  RATE_LIMIT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * Where rate-limit counters live.
   *
   * `redis` shares them across replicas and survives a restart, which is what
   * the limits assume. `memory` is per-process and wiped on restart — correct
   * only for the test harness and a single-process local run, and refused in
   * production by the assertion below.
   *
   * Explicit rather than inferred from NODE_ENV: inferring it is how the
   * limiter ended up never being exercised before production in the first
   * place.
   */
  RATE_LIMIT_STORE: z.enum(["redis", "memory"]).default("redis"),
  GLOBAL_RATE_LIMIT_WINDOW_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1),
  GLOBAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  SENSITIVE_AUTH_RATE_LIMIT_WINDOW_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(15),
  SENSITIVE_AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  /** OTP verify/resend. Separate from login: legitimate retries are more frequent. */
  OTP_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  OTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(15),
  /** Per-session ceiling for read/poll endpoints. Generous by design. */
  READ_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  /** Per-session ceiling for free-text search (each call fans out downstream). */
  SEARCH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  /**
   * Per-session ceiling for the livestream REST surface (`/streams/*`).
   *
   * Sized generously: the bucket is shared across everything a client sends to
   * the segment — comment paging, viewer polling, moderation — and starving it
   * has real consequences. The publisher heartbeat and quality reports are
   * exempted from the limiter entirely rather than budgeted for; see
   * `streamRateLimiter`.
   */
  STREAM_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(200),
  /**
   * Number of reverse-proxy hops in front of the gateway (0 = direct clients).
   * Use 1 behind nginx/ALB. Do not use `true` — express-rate-limit rejects it.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  // --- Community link host (aimess.me deep-link domain) ---
  /**
   * Comma-separated hostnames that should be treated as the dedicated community
   * link domain (Telegram's `t.me` equivalent). On these hosts the gateway
   * serves `.well-known` App/Universal-Link proofs and the server-rendered
   * "open in app" preview/interstitial instead of the API. Other hosts pass
   * straight through to the normal API routing.
   */
  LINK_HOSTS: z.string().default("ai5dev.tech"),
  /** App custom scheme used in deep links (`<scheme>://join?code=…`). */
  APP_SCHEME: z.string().default("aimess"),
  /** Web app origin for "Continue on web" + logged-out `returnTo` redirects. */
  WEB_APP_URL: z.string().url().default("https://ai5dev.tech"),
  /** Android package name (assetlinks.json + intent:// fallback). */
  ANDROID_PACKAGE_NAME: z.string().default("com.aifivetech.aimess.app"),
  /**
   * Comma-separated SHA-256 signing-cert fingerprints for assetlinks.json.
   * MUST list BOTH the upload cert and Google's Play App Signing cert, or
   * Android App Links silently fall back to the browser. Empty in dev.
   */
  ANDROID_SHA256_CERT_FINGERPRINTS: z.string().default(""),
  /** Google Play store id (referrer-carrying store URL for deferred deep link). */
  ANDROID_STORE_APP_ID: z.string().optional(),
  /**
   * Comma-separated Apple app IDs (`<TEAMID>.com.aimess.app`) for the
   * apple-app-site-association file.
   */
  APPLE_APP_IDS: z.string().default(""),
  /** Apple App Store numeric id (App Store URL for deferred deep link). */
  APPLE_STORE_APP_ID: z.string().optional(),

  /** Optional JSON policy file (default: apps/api-gateway/config/app-versions.json). */
  APP_VERSION_CONFIG_PATH: z.string().min(1).optional(),
  APP_VERSION_ANDROID_MANDATORY: semverLike.default("1.0.0"),
  APP_VERSION_ANDROID_OPTIONAL: semverLike.default("1.0.0"),
  APP_VERSION_ANDROID_STORE_URL: z.string().url().optional(),
  APP_VERSION_IOS_MANDATORY: semverLike.default("1.0.0"),
  APP_VERSION_IOS_OPTIONAL: semverLike.default("1.0.0"),
  APP_VERSION_IOS_STORE_URL: z.string().url().optional(),

  // LiveKit webhook — the same api-key/secret pair configured in the LiveKit
  // server's config.yaml `keys:` block (docker/livekit/config.yaml).
  // WebhookReceiver uses both to verify the signed webhook payload.
  //
  // Required, with NO default. These previously defaulted to a key/secret pair
  // published in this repository, so a deployment that simply forgot to set
  // them booted happily and then accepted any webhook an attacker signed with
  // the public value — POST /livekit/webhook's only gate is that signature.
  // Same fail-fast posture as GRPC_SERVICE_TOKEN.
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(32),
  CALL_INITIATE_RATE_MAX: z.coerce.number().int().positive().default(7),
  CALL_INITIATE_RATE_WINDOW_SEC: z.coerce.number().int().positive().default(30),
});

// `FOO_FILE=/run/secrets/foo` supplies `FOO`, so a secret can be a mounted
// file (Docker/Kubernetes secrets) instead of an environment variable that
// leaks through /proc, crash dumps, `docker inspect` and CI logs — and so
// rotation is replacing a file rather than editing .env on every host.
const expanded = expandFileSecrets(process.env);
const parsed = envSchema.safeParse(expanded);

if (!parsed.success) {
  console.error("Invalid environment variables");
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
    serviceName: "api-gateway",
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

/**
 * Cross-field boot assertions.
 *
 * Zod validates each variable in isolation; these are the combinations that are
 * individually valid but jointly unsafe. Every one of them is a control that
 * was switched off by configuration rather than by code, which is exactly the
 * failure mode a schema alone cannot catch. They run once, at import, and
 * refuse the boot rather than logging a warning nobody reads.
 */
function assertProductionInvariants(): void {
  if (env.NODE_ENV !== "production") return;

  const failures: string[] = [];

  if (env.CORS_ALLOW_ANY_ORIGIN) {
    failures.push(
      "CORS_ALLOW_ANY_ORIGIN must be false in production — it reflects any caller's Origin with credentials:true, on REST and Socket.IO alike."
    );
  }

  if (!env.CORS_ALLOW_ANY_ORIGIN && getCorsAllowedOrigins().length === 0) {
    failures.push(
      "CORS_ALLOWED_ORIGINS is empty — every browser origin would be refused. Set the web origins this gateway serves."
    );
  }

  if (!env.RATE_LIMIT_ENABLED) {
    failures.push(
      "RATE_LIMIT_ENABLED must be true in production — false removes the global backstop from the entire API."
    );
  }

  if (env.RATE_LIMIT_STORE !== "redis") {
    failures.push(
      "RATE_LIMIT_STORE must be 'redis' in production — an in-process store is wiped by every restart and multiplies every limit by the replica count."
    );
  }

  if (env.BACKOFFICE_SERVICE_URL && !env.JWT_ADMIN_SECRET) {
    failures.push(
      "JWT_ADMIN_SECRET is required whenever BACKOFFICE_SERVICE_URL is set — without it the /admin edge cannot verify a single token."
    );
  }

  if (env.BACKOFFICE_SERVICE_URL) {
    failures.push(...adminIpWhitelistFailures(getAdminIpWhitelist()));
  }

  if (failures.length > 0) {
    console.error("Refusing to start: unsafe production configuration");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
}

assertProductionInvariants();

export function getDefaultAppVersionConfig(): AppVersionConfig {
  return {
    android: {
      mandatoryUpdate: env.APP_VERSION_ANDROID_MANDATORY,
      optionalUpdate: env.APP_VERSION_ANDROID_OPTIONAL,
      storeUrl: env.APP_VERSION_ANDROID_STORE_URL,
    },
    ios: {
      mandatoryUpdate: env.APP_VERSION_IOS_MANDATORY,
      optionalUpdate: env.APP_VERSION_IOS_OPTIONAL,
      storeUrl: env.APP_VERSION_IOS_STORE_URL,
    },
    updatedAt: new Date(0).toISOString(),
  };
}

/** Origins for `cors` — comma-separated list from env. */
export function getCorsAllowedOrigins(): string[] {
  return env.CORS_ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * CORS origin validator shared by the REST `cors` middleware and the Socket.IO
 * server — i.e. the origin authority for every REST route plus /chat,
 * /community, /notify, /stream, /auth and /admin, all of which run with
 * `credentials: true`.
 *
 * The allowlist is now the only thing that admits a browser origin. The
 * previous `NODE_ENV === "development"` short-circuit returned true for ANY
 * origin whenever the environment was not exactly "production" — including
 * "test", and including a deployment whose NODE_ENV was simply missing — which
 * let any page the victim visited read the whole authenticated API
 * cross-origin. Dev tunnels are served by the explicit
 * CORS_ALLOW_ANY_ORIGIN flag instead, which the boot assertion above forbids in
 * production.
 */
export function isCorsOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // native apps, curl, server-to-server
  if (env.CORS_ALLOW_ANY_ORIGIN) return true;
  return getCorsAllowedOrigins().includes(origin);
}

/** Request headers allowed in the CORS preflight — comma-separated list from env. */
export function getCorsAllowedHeaders(): string[] {
  return env.CORS_ALLOWED_HEADERS.split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

/** Admin IP allowlist — comma-separated list from env (empty = allow all). */
export function getAdminIpWhitelist(): string[] {
  return env.ADMIN_IP_WHITELIST.split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Hostnames treated as the dedicated community link domain (lowercased). */
export function getLinkHosts(): string[] {
  return splitCsv(env.LINK_HOSTS).map((h) => h.toLowerCase());
}

/** True when the request host is the dedicated community link domain. */
export function isLinkHost(hostname: string | undefined): boolean {
  if (!hostname) return false;
  return getLinkHosts().includes(hostname.toLowerCase());
}

/** Android signing-cert fingerprints for assetlinks.json. */
export function getAndroidCertFingerprints(): string[] {
  return splitCsv(env.ANDROID_SHA256_CERT_FINGERPRINTS);
}

/** Apple app IDs for apple-app-site-association. */
export function getAppleAppIds(): string[] {
  return splitCsv(env.APPLE_APP_IDS);
}

function normalizeGatewayBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api\/v\d+(\/[^/]+)?$/i, "");
}

/** Fixed gateway base URLs from env (host only, no `/api/v1` path). */
export function getConfiguredSwaggerServerUrls(): string[] {
  const port = String(env.API_GATEWAY_PORT);
  const urls: string[] = [];

  if (env.SWAGGER_SERVER_URLS) {
    urls.push(
      ...env.SWAGGER_SERVER_URLS.split(",")
        .map((u) => normalizeGatewayBaseUrl(u))
        .filter(Boolean)
    );
  }

  if (env.API_PUBLIC_URL) {
    urls.push(normalizeGatewayBaseUrl(env.API_PUBLIC_URL));
  }

  urls.push(`http://localhost:${port}`);

  return [...new Set(urls)];
}

/**
 * Swagger "Servers" list: the current browser host first (so it's the
 * default-selected, actually-reachable server — index 0 is labeled
 * "current host" downstream in openapi-document.ts), then env-configured
 * URLs (dev tunnel, etc.) as fallbacks. https://localhost is skipped — it
 * is a dev-proxy artifact and not a real reachable server.
 */
export function resolveSwaggerServerUrls(req: Request): string[] {
  // Reverse proxies (VS Code Dev Tunnels, ngrok, etc.) forward the real public
  // host via X-Forwarded-Host while the raw Host header stays "localhost:PORT".
  //
  // `req.get()` does NOT honour Express's trust-proxy setting — despite an
  // earlier comment here claiming TRUST_PROXY_HOPS gated it — so the header was
  // taken from any caller and became servers[0], the entry Swagger UI selects
  // by default. With `persistAuthorization: true` in the UI, a developer fed a
  // link carrying an injected X-Forwarded-Host would have sent every "Try it
  // out" request, Authorization header included, to the attacker's host.
  //
  // Two conditions now gate it: the deployment must actually sit behind a proxy
  // (TRUST_PROXY_HOPS > 0), and the resulting base must be one this gateway
  // already claims as its own. Anything else falls back to the configured list.
  const configured = getConfiguredSwaggerServerUrls();
  const forwardedHost =
    env.TRUST_PROXY_HOPS > 0 ? req.get("x-forwarded-host") : undefined;
  const host = forwardedHost ?? req.get("host");
  const currentBase =
    host != null && host.length > 0
      ? normalizeGatewayBaseUrl(`${req.protocol}://${host}`)
      : `http://localhost:${String(env.API_GATEWAY_PORT)}`;

  const isHttpsLocalhost = /^https:\/\/localhost(:\d+)?$/.test(currentBase);
  const isKnownBase = configured.includes(currentBase);
  return isHttpsLocalhost || !isKnownBase
    ? configured
    : [...new Set([currentBase, ...configured])];
}
