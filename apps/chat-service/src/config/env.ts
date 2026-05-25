import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),

  CHAT_SERVICE_PORT: z.coerce.number().positive(),

  // MongoDB connection. Provide EITHER a complete MONGO_DATABASE_URL, OR the
  // MONGO_* parts below (the URL is then composed from them). The parts match
  // the docker-compose Mongo root vars so credentials live in one place.

  MONGO_ROOT_USERNAME: z.string().min(1).optional(),
  MONGO_ROOT_PASSWORD: z.string().min(1).optional(),
  MONGO_DATABASE: z.string().min(1).optional(), // auth source (where the root user lives, e.g. admin)
  MONGODB_PORT: z.coerce.number().positive().optional(),
  MONGO_HOST: z.string().default("localhost"),
  MONGO_DB_NAME: z.string().default("aimess_chat"), // database that holds chat data

  REDIS_HOST: z.string(),
  REDIS_PORT: z.coerce.number(),

  JWT_ACCESS_SECRET: z.string(),

  RABBITMQ_URL: z.string().min(1).optional(),

  MINIO_ENDPOINT: z.string().url(),
  MINIO_PUBLIC_ENDPOINT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional()
  ),
  MINIO_ACCESS_KEY: z.string(),
  MINIO_SECRET_KEY: z.string(),
  MINIO_BUCKET: z.string(),
  MINIO_REGION: z.string(),
  MINIO_PRESIGN_EXPIRES_IN: z.coerce.number().positive().default(300),
  MINIO_VIEW_EXPIRES_IN: z.coerce.number().positive().default(3600),
  CHAT_UPLOAD_MAX_BYTES: z.coerce.number().positive().default(52_428_800), // 50 MB

  MESSAGE_PAGE_SIZE: z.coerce.number().positive().default(30),
  CONVERSATION_PAGE_SIZE: z.coerce.number().positive().default(20),
  PIN_LIMIT_PER_ROOM: z.coerce.number().positive().default(50),

  USER_SERVICE_URL: z.string().url().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  process.stderr.write("Invalid Environment Variables\n");
  process.stderr.write(JSON.stringify(parsed.error.format(), null, 2) + "\n");
  process.exit(1);
}

const data = parsed.data;

/**
 * Resolve the MongoDB connection URL: prefer a complete MONGO_DATABASE_URL,
 * otherwise compose it from the MONGO_* parts. Exits with a clear message if
 * neither is usable.
 */
function resolveMongoUrl(): string {
  // Optional pre-built override (not part of the validated schema).
  const url = `mongodb://${data.MONGO_ROOT_USERNAME}:${data.MONGO_ROOT_PASSWORD}@${data.MONGO_HOST}:${data.MONGODB_PORT}/${data.MONGO_DB_NAME}?authSource=${data.MONGO_DATABASE}&directConnection=true`;
  // A usable URL must have a host after the optional credentials (e.g. not the
  // truncated "mongodb://user:pass@").
  const looksComplete =
    !!url &&
    /^mongodb(\+srv)?:\/\/([^@/]+@)?[^@/]+/.test(url) &&
    !/@\s*$/.test(url);
  if (looksComplete) return url as string;

  if (
    data.MONGO_ROOT_USERNAME &&
    data.MONGO_ROOT_PASSWORD &&
    data.MONGODB_PORT
  ) {
    const user = encodeURIComponent(data.MONGO_ROOT_USERNAME);
    const pass = encodeURIComponent(data.MONGO_ROOT_PASSWORD);
    const authSource = data.MONGO_DATABASE ?? "admin";
    return (
      `mongodb://${user}:${pass}@${data.MONGO_HOST}:${data.MONGODB_PORT}/` +
      `${data.MONGO_DB_NAME}?authSource=${authSource}&directConnection=true`
    );
  }

  process.stderr.write(
    "Invalid Mongo config: provide a complete MONGO_DATABASE_URL, or the " +
      "MONGO_ROOT_USERNAME / MONGO_ROOT_PASSWORD / MONGODB_PORT parts.\n"
  );
  process.exit(1);
}

export const env = {
  ...data,
  MONGO_DATABASE_URL: resolveMongoUrl(),
};
