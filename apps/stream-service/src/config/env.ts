import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),
  STREAM_SERVICE_PORT: z.coerce.number().positive().default(3007),
  STREAM_GRPC_PORT: z.coerce.number().positive().default(4007),

  STREAM_DATABASE_URL: z.string(),

  REDIS_HOST: z.string(),
  REDIS_PORT: z.coerce.number(),
  REDIS_CACHE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  /** Reserved for future stream events (publish/consume). Optional on boot. */
  RABBITMQ_URL: z.string().min(1).optional(),

  /** Same secret as auth-service — used to verify access tokens. */
  JWT_ACCESS_SECRET: z.string().min(1),

  /** user-service gRPC endpoint — comment author snapshots. */
  USER_GRPC_URL: z.string().default("0.0.0.0:4002"),
  /** community-service gRPC endpoint — go-live membership validation. */
  COMMUNITY_GRPC_URL: z.string().default("0.0.0.0:4003"),

  // ---- Livestream policy ----
  /** Comma-separated list of allowed ingest modes minted to a creator (whip|rtmp). */
  STREAM_INGEST_MODES: z.string().default("whip,rtmp"),
  /** Max simultaneous PENDING+LIVE streams a single community may have. */
  STREAM_MAX_CONCURRENT_PER_COMMUNITY: z.coerce.number().positive().default(5),
  /** When true, go-live requires the creator be an ACTIVE community member. */
  STREAM_REQUIRE_MEMBERSHIP: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  // ---- SRS (OSSRS) media server endpoints ----
  /** SRS HTTP API base (clients DELETE, GET /api/v1/streams, etc.). */
  SRS_API_URL: z.string().url().default("http://localhost:1985"),
  /** SRS RTMP host (ffmpeg push target for URL mode). */
  SRS_RTMP_HOST: z.string().default("localhost"),
  /** Base for HLS/FLV playback URLs minted for viewers. */
  SRS_HLS_BASE: z.string().url().default("http://localhost:8080"),
  /** Base for WHIP (WebRTC) publish URLs minted for phone-camera ingest. */
  SRS_WHIP_BASE: z.string().url().default("http://localhost:1985"),
  /** Shared secret the SRS http_hooks endpoint validates (query/header). */
  SRS_HOOK_SECRET: z.string().min(1).optional(),

  /** ffmpeg binary path for URL re-stream ingest (host prerequisite in dev). */
  FFMPEG_PATH: z.string().default("ffmpeg"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  process.stderr.write("Invalid environment variables\n");
  process.stderr.write(JSON.stringify(parsed.error.format(), null, 2) + "\n");
  process.exit(1);
}

export const env = parsed.data;
