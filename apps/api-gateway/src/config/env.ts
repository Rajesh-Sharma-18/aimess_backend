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
  API_GATEWAY_PORT: z.coerce.number().positive(),
  AUTH_SERVICE_URL: z.string().url(),
  USER_SERVICE_URL: z.string().url().optional(),
  COMMUNITY_SERVICE_URL: z.string().url().optional(),
  CHAT_SERVICE_URL: z.string().url().optional(),
  AUTH_GRPC_URL: z.string().optional(),
  USER_GRPC_URL: z.string().optional(),
  /** gRPC URLs for socket-facing services (required — sockets cannot operate without them). */
  MESSAGING_GRPC_URL: z.string().min(1),
  COMMUNITY_GRPC_URL: z.string().min(1),
  NOTIFICATION_GRPC_URL: z.string().min(1),
  /** Same JWT secret as auth-service — used by socket auth middleware. */
  JWT_ACCESS_SECRET: z.string().min(1),
  REDIS_URL: z.string(),
  CORS_ALLOWED_ORIGINS: z.string(),
  API_PUBLIC_URL: z.string().url().optional(),
  /** Comma-separated Swagger server URLs (e.g. localhost + LAN IP). */
  SWAGGER_SERVER_URLS: z.string().optional(),

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

function normalizeGatewayBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api\/v\d+(\/[^/]+)?$/i, "");
}

/** Fixed gateway base URLs from env (host only, no `/api/v1` path). */
export function getConfiguredSwaggerServerUrls(): string[] {
  const port = String(env.API_GATEWAY_PORT);
  const urls: string[] = [`http://localhost:${port}`];

  if (env.API_PUBLIC_URL) {
    urls.push(normalizeGatewayBaseUrl(env.API_PUBLIC_URL));
  }

  if (env.SWAGGER_SERVER_URLS) {
    urls.push(
      ...env.SWAGGER_SERVER_URLS.split(",")
        .map((u) => normalizeGatewayBaseUrl(u))
        .filter(Boolean)
    );
  }

  return [...new Set(urls)];
}

/**
 * Swagger "Servers" list: current browser host first, then env-configured URLs.
 * Works for http://localhost:3000/docs and http://10.0.127.225:3000/docs alike.
 */
export function resolveSwaggerServerUrls(req: Request): string[] {
  const host = req.get("host");
  const currentBase =
    host != null && host.length > 0
      ? normalizeGatewayBaseUrl(`${req.protocol}://${host}`)
      : `http://localhost:${String(env.API_GATEWAY_PORT)}`;

  return [...new Set([currentBase, ...getConfiguredSwaggerServerUrls()])];
}
