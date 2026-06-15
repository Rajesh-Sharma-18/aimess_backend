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
  MESSAGING_GRPC_URL: z.string().min(1),
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
  /**
   * Number of reverse-proxy hops in front of the gateway (0 = direct clients).
   * Use 1 behind nginx/ALB. Do not use `true` — express-rate-limit rejects it.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  /** Optional JSON policy file (default: apps/api-gateway/config/app-versions.json). */
  APP_VERSION_CONFIG_PATH: z.string().min(1).optional(),
  APP_VERSION_ANDROID_MANDATORY: semverLike.default("1.0.0"),
  APP_VERSION_ANDROID_OPTIONAL: semverLike.default("1.0.0"),
  APP_VERSION_ANDROID_STORE_URL: z.string().url().optional(),
  APP_VERSION_IOS_MANDATORY: semverLike.default("1.0.0"),
  APP_VERSION_IOS_OPTIONAL: semverLike.default("1.0.0"),
  APP_VERSION_IOS_STORE_URL: z.string().url().optional(),
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
 * Swagger "Servers" list: env-configured URLs first (dev tunnel, etc.), then
 * the current browser host. https://localhost is skipped — it is a dev-proxy
 * artifact and not a real reachable server.
 */
export function resolveSwaggerServerUrls(req: Request): string[] {
  const host = req.get("host");
  const currentBase =
    host != null && host.length > 0
      ? normalizeGatewayBaseUrl(`${req.protocol}://${host}`)
      : `http://localhost:${String(env.API_GATEWAY_PORT)}`;

  const isHttpsLocalhost = /^https:\/\/localhost(:\d+)?$/.test(currentBase);
  const configured = getConfiguredSwaggerServerUrls();
  return isHttpsLocalhost
    ? configured
    : [...new Set([...configured, currentBase])];
}
