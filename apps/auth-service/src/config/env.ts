import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),

  AUTH_SERVICE_PORT: z.coerce.number(),

  AUTH_DATABASE_URL: z.string(),

  REDIS_HOST: z.string(),
  REDIS_PORT: z.coerce.number(),

  JWT_ACCESS_SECRET: z.string(),
  JWT_REFRESH_SECRET: z.string(),

  JWT_ACCESS_EXPIRES_IN: z.string(),
  JWT_REFRESH_EXPIRES_IN: z.string(),

  RABBITMQ_URL: z.string().min(1),

  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SECONDS: z.coerce.number().positive().default(600),
  OTP_MAX_ATTEMPTS: z.coerce.number().positive().default(5),
  PASSWORD_RESET_TOKEN_TTL_SECONDS: z.coerce.number().positive().default(900),
  /** Dev only: fixed OTP (e.g. 123456). Logged in terminal until email is wired up. */
  OTP_DEV_FIXED_CODE: z.string().optional(),

  /** Comma-separated Google OAuth client IDs (Web / iOS / Android). */
  GOOGLE_CLIENT_IDS: z.string().default(""),
  /** Comma-separated Apple client IDs (bundle id / service id). */
  APPLE_CLIENT_IDS: z.string().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid Environment Variables");
  console.error(parsed.error.format());
  process.exit(1);
}

function parseCsvIds(value: string): string[] {
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

const raw = parsed.data;

export const env = {
  ...raw,
  GOOGLE_CLIENT_IDS: parseCsvIds(raw.GOOGLE_CLIENT_IDS),
  APPLE_CLIENT_IDS: parseCsvIds(raw.APPLE_CLIENT_IDS),
};
