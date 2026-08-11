import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),

  CHAT_SERVICE_PORT: z.coerce.number().positive(),
  CHAT_GRPC_PORT: z.coerce.number().positive().default(4004),

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
  // Optional so local dev against an unauthenticated Redis keeps working.
  // Required for any shared/remote Redis, which must not be left open.
  // Applies to cluster mode too — every node must share the password.
  REDIS_PASSWORD: z.string().optional(),
  // Comma-separated "host:port" pairs to enable Redis Cluster mode.
  // Example: 127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003
  // Leave unset to use a single Redis node (REDIS_HOST / REDIS_PORT).
  REDIS_CLUSTER_NODES: z.string().optional(),

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
  // Sibling buckets on the shared MinIO. chat-service does not upload to these
  // (media-service owns uploads) but must know their names to presign view URLs
  // for avatar / community-image object keys carried on chat snapshots.
  MINIO_BUCKET_AVATARS: z.string().min(1).default("aimess-avatars"),
  MINIO_BUCKET_COMMUNITY: z.string().min(1).default("aimess-community"),
  MINIO_REGION: z.string(),
  /** Presigned PUT lifetime for upload URLs (seconds). */
  MINIO_PRESIGN_EXPIRES_IN: z.coerce.number().positive().default(300),
  MINIO_VIEW_EXPIRES_IN: z.coerce.number().positive().default(3600),
  CHAT_UPLOAD_MAX_BYTES: z.coerce.number().positive().default(52_428_800), // 50 MB (generic cap — GIF/legacy CUSTOM only)
  CHAT_VIDEO_MAX_BYTES: z.coerce.number().positive().default(104_857_600), // 100 MB (video cap)
  // Same var name + default as media-service's env (config/env.ts) so the
  // message-send-time guard here and the presigned-upload-time guard there
  // can never silently drift apart — see @aimess/constants media/limits.ts.
  CHAT_IMAGE_MAX_BYTES: z.coerce.number().positive().default(26_214_400), // 25 MB (image cap)
  CHAT_AUDIO_MAX_BYTES: z.coerce.number().positive().default(26_214_400), // 25 MB (audio cap)
  CHAT_DOCUMENT_MAX_BYTES: z.coerce.number().positive().default(26_214_400), // 25 MB (document cap)
  CHAT_TEXT_MAX_CHARS: z.coerce.number().positive().default(4000),

  MESSAGE_PAGE_SIZE: z.coerce.number().positive().default(30),
  CONVERSATION_PAGE_SIZE: z.coerce.number().positive().default(20),
  PIN_LIMIT_PER_ROOM: z.coerce.number().positive().default(50),

  USER_SERVICE_GRPC_URL: z.string().default("0.0.0.0:4002"),
  AUTH_GRPC_URL: z.string().default("0.0.0.0:4001"),
  COMMUNITY_GRPC_URL: z.string().default("0.0.0.0:4003"),
  NOTIFICATION_GRPC_URL: z.string().default("0.0.0.0:4006"),
  STREAM_GRPC_URL: z.string().default("0.0.0.0:4007"),
  /** user-service REST URL — snapshot fetching fallback. */
  USER_SERVICE_URL: z.string().url().optional(),
  /** auth-service REST URL — fallback account-name resolution. */
  AUTH_SERVICE_URL: z.string().url().optional(),
  // Boot-time reconciliation of community chat rooms (pull from community-service
  // over gRPC). Disable to skip the reconciler entirely.
  COMMUNITY_ROOM_RECONCILE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  FRIENDSHIP_CACHE_TTL_SEC: z.coerce.number().positive().default(600), // 10 minutes

  // Same var as community-service's — the shared HTTPS host for both community
  // (`/+<code>`, `/<handle>`) and group (`/g/<token>`) invite links. Falls back
  // to the bare token/code when unset (local/dev).
  INVITE_LINK_BASE_URL: z.string().url().optional(),

  // LiveKit (self-hosted). See Docs/calls/CALLS-LIVEKIT.md.
  // LIVEKIT_URL is the WS URL clients connect to (ws://localhost:7880 dev,
  // wss://livekit.example.com in prod). API key/secret must match the
  // docker-compose LIVEKIT_KEYS pair.
  LIVEKIT_URL: z.string().default("ws://localhost:7880"),
  // Dev defaults match docker/livekit/config.yaml + docker-compose LIVEKIT_KEYS —
  // chat-service boots without any manual .env editing. Prod overrides these.
  LIVEKIT_API_KEY: z.string().min(1).default("devkey"),
  LIVEKIT_API_SECRET: z
    .string()
    .min(1)
    .default("devsecretchangeme_at_least_32_chars_long"),
  LIVEKIT_TOKEN_TTL: z.coerce.number().positive().default(3600),

  // Ringing timeout: a Call left in RINGING for longer than this flips to
  // MISSED via a periodic sweep. Multi-node safe (atomic updateMany).
  CALL_RINGING_TIMEOUT_SEC: z.coerce.number().positive().default(60),
  CALL_TIMEOUT_SWEEP_INTERVAL_SEC: z.coerce.number().positive().default(15),
  CALL_TIMEOUT_SWEEP_BATCH: z.coerce.number().positive().default(100),

  // Auto-unmute sweep for TIMED group moderation mutes. Enforcement itself is
  // lazy (a lapsed `moderationMutedUntil` stops blocking immediately), so this
  // sweep only delivers the realtime `group:member:unmuted` signal and clears
  // the stale flag. Multi-node safe (atomic per-row claim).
  GROUP_MUTE_SWEEP_INTERVAL_SEC: z.coerce.number().positive().default(60),
  GROUP_MUTE_SWEEP_BATCH: z.coerce.number().positive().default(200),

  // Auto-delete (disappearing messages) sweeper for private chats. UNLIKE the
  // mute sweep, correctness DOES depend on this one: it is what actually
  // deletes a due message, on the server, whether or not either client is
  // online (§5.2/§8.4). 30s keeps "After Viewing" feeling immediate without
  // polling hard. Multi-node safe (a lost race is a no-op).
  AUTO_DELETE_SWEEP_INTERVAL_SEC: z.coerce.number().positive().default(30),
  AUTO_DELETE_SWEEP_BATCH: z.coerce.number().positive().default(200),

  // "Login Detected" auto-approval. The alert stays actionable for this long;
  // once the deadline passes with no user action the sweep resolves it exactly
  // as "It's Me" does (the session is NEVER auto-terminated). Backend-owned:
  // the deadline is stamped on the row at create time, so closing the browser,
  // refreshing, or restarting the service does not reset or lose it.
  // Overridable (tests use ~1s) but the production default is 1 hour.
  LOGIN_DETECTION_TIMEOUT_MS: z.coerce
    .number()
    .positive()
    .default(60 * 60 * 1000),
  LOGIN_EXPIRY_SWEEP_INTERVAL_SEC: z.coerce.number().positive().default(60),
  LOGIN_EXPIRY_SWEEP_BATCH: z.coerce.number().positive().default(200),

  // Hard ceiling on an IN_PROGRESS call. Without it a client that dies before
  // sending `call:end` (crash, force-kill, dead network) leaves the row active
  // forever and BOTH participants are permanently "busy" — no future call can
  // be placed. Defaults to LIVEKIT_TOKEN_TTL: media cannot outlive its token.
  CALL_MAX_DURATION_SEC: z.coerce.number().positive().default(3600),
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
  const url = process.env.MONGO_DATABASE_URL;
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
