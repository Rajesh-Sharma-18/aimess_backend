import dotenv from "dotenv";
import type { Request } from "express";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  API_GATEWAY_PORT: z.coerce.number().positive(),
  AUTH_SERVICE_URL: z.string().url(),
  USER_SERVICE_URL: z.string().url().optional(),
  AUTH_GRPC_URL: z.string().optional(),
  USER_GRPC_URL: z.string().optional(),
  REDIS_URL: z.string(),
  CORS_ALLOWED_ORIGINS: z.string(),
  API_PUBLIC_URL: z.string().url().optional(),
  /** Comma-separated Swagger server URLs (e.g. localhost + LAN IP). */
  SWAGGER_SERVER_URLS: z.string().optional(),
  /**
   * Number of reverse-proxy hops in front of the gateway (0 = direct clients).
   * Use 1 behind nginx/ALB. Do not use `true` — express-rate-limit rejects it.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

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
