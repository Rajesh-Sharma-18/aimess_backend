import dotenv from "dotenv";
import type { Request } from "express";
import { z } from "zod";

import type { AppVersionConfig } from "../app-version/types.js";

dotenv.config();

const semverLike = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+){0,2}$/);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
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
  /** Same JWT secret as auth-service — used by socket auth middleware. */
  JWT_ACCESS_SECRET: z.string().min(1),
  /** Downstream backoffice (admin) service. */
  BACKOFFICE_SERVICE_URL: z.string().url().optional(),
  /** Admin JWT secret — edge signature/exp check on /admin/* (not jti blacklist). */
  JWT_ADMIN_SECRET: z.string().min(1).optional(),
  /** Comma-separated admin IP allowlist; empty = allow all (dev). */
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
  LINK_HOSTS: z.string().default("aimess.me"),
  /** App custom scheme used in deep links (`<scheme>://join?code=…`). */
  APP_SCHEME: z.string().default("aimess"),
  /** Web app origin for "Continue on web" + logged-out `returnTo` redirects. */
  WEB_APP_URL: z.string().url().default("https://aimess.com"),
  /** Android package name (assetlinks.json + intent:// fallback). */
  ANDROID_PACKAGE_NAME: z.string().default("com.aimess.app"),
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
  /** community-service internal base URL for unauthenticated public-card lookups. */
  COMMUNITY_INTERNAL_URL: z.string().url().optional(),
  /** Shared secret for gateway → service internal (unauthenticated) calls. */
  INTERNAL_SHARED_SECRET: z.string().optional(),

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
  LIVEKIT_API_KEY: z.string().min(1).default("devkey"),
  LIVEKIT_API_SECRET: z
    .string()
    .min(1)
    .default("devsecretchangeme_at_least_32_chars_long"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

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
 * CORS origin validator shared by the REST `cors` middleware and the
 * Socket.IO server. In development, any origin is allowed — dev tunnels
 * (VS Code Dev Tunnels, ngrok) mint a new hostname per session, so pinning
 * CORS to a static CORS_ALLOWED_ORIGINS list breaks every time the tunnel
 * rotates. Production still enforces the configured allowlist.
 */
export function isCorsOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // native apps, curl, server-to-server
  if (env.NODE_ENV === "development") return true;
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
  // Reverse proxies (VS Code Dev Tunnels, ngrok, etc.) forward the real
  // public host via X-Forwarded-Host while the raw Host header stays
  // "localhost:PORT" — req.get("host") ignores trust-proxy settings, so
  // read the forwarded header explicitly (trust proxy already gates this
  // via TRUST_PROXY_HOPS / app.set("trust proxy", ...) in app.ts, same as
  // req.protocol below).
  const host = req.get("x-forwarded-host") ?? req.get("host");
  const currentBase =
    host != null && host.length > 0
      ? normalizeGatewayBaseUrl(`${req.protocol}://${host}`)
      : `http://localhost:${String(env.API_GATEWAY_PORT)}`;

  const isHttpsLocalhost = /^https:\/\/localhost(:\d+)?$/.test(currentBase);
  const configured = getConfiguredSwaggerServerUrls();
  return isHttpsLocalhost
    ? configured
    : [...new Set([currentBase, ...configured])];
}
