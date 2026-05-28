import { logger } from "@aimess/logger";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),
  NOTIFICATIONS_SERVICE_PORT: z.coerce.number().positive(),

  REDIS_HOST: z.string(),
  REDIS_PORT: z.coerce.number(),

  RABBITMQ_URL: z.string().min(1),

  FIREBASE_PROJECT_ID: z.string(),
  FIREBASE_CLIENT_EMAIL: z.string(),
  FIREBASE_PRIVATE_KEY: z.string(),

  SMTP_HOST: z.string(),
  SMTP_PORT: z.coerce.number(),
  SMTP_USER: z.string(),
  SMTP_PASS: z.string(),
  SMTP_FROM: z.string(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  logger.error("Invalid environment variables");
  logger.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
