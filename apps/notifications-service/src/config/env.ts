import { logger } from "@aimess/logger";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),
  NOTIFICATIONS_SERVICE_PORT: z.coerce.number().positive(),
  NOTIFICATIONS_GRPC_PORT: z.coerce.number().positive().default(4006),

  REDIS_HOST: z.string(),
  REDIS_PORT: z.coerce.number(),

  RABBITMQ_URL: z.string().min(1),

  // MongoDB — own device-token store. Provide a complete MONGO_DATABASE_URL OR
  // the MONGO_* parts (mirrors chat-service). Resolved below into a usable URL.
  MONGO_DATABASE_URL: z.string().optional(),
  MONGO_ROOT_USERNAME: z.string().min(1).optional(),
  MONGO_ROOT_PASSWORD: z.string().min(1).optional(),
  MONGO_DATABASE: z.string().min(1).optional(), // auth source (e.g. admin)
  MONGODB_PORT: z.coerce.number().positive().optional(),
  MONGO_HOST: z.string().default("localhost"),
  MONGO_DB_NAME: z.string().default("aimess_notifications"),

  // Outbound gRPC targets (host:port) for opossum-wrapped clients.
  USER_SERVICE_GRPC_URL: z.string().default("127.0.0.1:4002"),
  CHAT_SERVICE_GRPC_URL: z.string().default("127.0.0.1:4004"),

  // Cached notification-settings TTL (seconds).
  NOTIF_SETTINGS_CACHE_TTL_SEC: z.coerce.number().positive().default(300),

  // JWT access secret — verifies device-registration requests.
  JWT_ACCESS_SECRET: z.string(),

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

const data = parsed.data;

/**
 * Resolve the MongoDB connection URL: prefer a complete MONGO_DATABASE_URL,
 * otherwise compose it from the MONGO_* parts (mirrors chat-service).
 */
function resolveMongoUrl(): string {
  if (
    data.MONGO_DATABASE_URL &&
    /^mongodb(\+srv)?:\/\//.test(data.MONGO_DATABASE_URL)
  ) {
    return data.MONGO_DATABASE_URL;
  }

  if (
    data.MONGO_ROOT_USERNAME &&
    data.MONGO_ROOT_PASSWORD &&
    data.MONGODB_PORT
  ) {
    const user = encodeURIComponent(data.MONGO_ROOT_USERNAME);
    const pass = encodeURIComponent(data.MONGO_ROOT_PASSWORD);
    const authSource = data.MONGO_DATABASE ?? "admin";
    return (
      `mongodb://${user}:${pass}@${data.MONGO_HOST}:${String(data.MONGODB_PORT)}/` +
      `${data.MONGO_DB_NAME}?authSource=${authSource}&directConnection=true`
    );
  }

  logger.error(
    "Invalid Mongo config: provide a complete MONGO_DATABASE_URL, or the " +
      "MONGO_ROOT_USERNAME / MONGO_ROOT_PASSWORD / MONGODB_PORT parts."
  );
  process.exit(1);
}

export const env = {
  ...data,
  MONGO_DATABASE_URL: resolveMongoUrl(),
};
