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
  // Optional so local dev against an unauthenticated Redis keeps working.
  // Required for any shared/remote Redis, which must not be left open.
  REDIS_PASSWORD: z.string().optional(),
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
  /**
   * How long (ms) a LIVE stream may go without a heartbeat before the sweeper
   * auto-ends it. Client should call POST /streams/:id/heartbeat every 30 s.
   * Default: 5 minutes (300 000 ms).
   */
  STREAM_HEARTBEAT_TIMEOUT_MS: z.coerce.number().positive().default(300_000),
  /**
   * How long (ms) a RECONNECTING stream (publisher dropped — refresh, mobile
   * blip, network hiccup) may sit before the sweeper finalizes it ENDED. A
   * republish on the same streamKey within this window resumes LIVE instead.
   * Kept well under STREAM_HEARTBEAT_TIMEOUT_MS so a resume never immediately
   * re-trips the heartbeat-timeout sweep. Default: 45 seconds.
   */
  STREAM_RECONNECT_GRACE_MS: z.coerce.number().positive().default(45_000),
  /**
   * How long (ms) a PENDING stream (created but never went LIVE — abandoned
   * setup, crashed client, failed publish) may sit before the sweeper
   * auto-cancels it. Without this a stuck PENDING row permanently occupies the
   * creator's one-active-stream-per-community slot. Default: 10 minutes.
   */
  STREAM_PENDING_TIMEOUT_MS: z.coerce.number().positive().default(600_000),

  // ---- SRS (OSSRS) media server endpoints ----
  /** SRS HTTP API base (clients DELETE, GET /api/v1/streams, etc.). */
  SRS_API_URL: z.string().url().default("http://localhost:1985"),
  /**
   * HTTP API base for the SRS instance that receives the OBS/RTMP publisher
   * directly (distinct from SRS_API_URL, which on the hosted 3-instance setup
   * only sees a forwarded copy). Optional — falls back to SRS_API_URL when
   * unset (correct for local Docker SRS, a single all-in-one instance).
   * kickStream uses this for OBS_RTMP streams, SRS_API_URL for everything else.
   */
  SRS_INGEST_API_URL: z.string().url().optional(),
  /** SRS RTMP host (ffmpeg push target for URL mode). */
  SRS_RTMP_HOST: z.string().default("localhost"),
  /** Base for HLS/FLV playback URLs minted for viewers. */
  SRS_HLS_BASE: z.string().url().default("http://localhost:8080"),
  /** Base for WHIP (WebRTC) publish URLs minted for phone-camera ingest. */
  SRS_WHIP_BASE: z.string().url().default("http://localhost:1985"),
  /**
   * When true, viewer HLS URLs point at the ABR master playlist
   * (`<key>_master.m3u8`) so hls.js can auto-switch between the source and the
   * transcoded 480p/360p renditions. Only makes sense where an nginx template
   * (production) or another mechanism is producing that master file. Leave
   * false locally — Docker SRS alone doesn't emit `_master.m3u8`.
   */
  SRS_HLS_ABR_MASTER: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  /**
   * When true, viewers are offered manual FLV quality URLs (`<key>_480p.flv`,
   * `<key>_360p.flv`) alongside the source `<key>.flv`. Independent of
   * SRS_HLS_ABR_MASTER: FLV renditions need only the SRS `transcode` block +
   * `abr` vhost (which the local Docker SRS has), NOT an HLS master playlist.
   * Set true only where SRS is actually transcoding — otherwise the rendition
   * URLs 404. True on local Docker SRS; production depends on that host's conf.
   */
  SRS_FLV_ABR: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  /** Shared secret the SRS http_hooks endpoint validates (header, required). */
  SRS_HOOK_SECRET: z.string().min(1),
  /**
   * Basic Auth credentials for SRS's http_api (`auth {}` block in srs.conf).
   * Optional — omit both when the target SRS instance has no auth enabled
   * (e.g. local Docker SRS without an `auth {}` block).
   */
  SRS_API_USERNAME: z.string().optional(),
  SRS_API_PASSWORD: z.string().optional(),

  /** ffmpeg binary path for URL re-stream ingest (host prerequisite in dev). */
  FFMPEG_PATH: z.string().default("ffmpeg"),

  // ---- MinIO (resolve stored avatar object keys to full download URLs) ----
  MINIO_ENDPOINT: z.string().url(),
  MINIO_PUBLIC_ENDPOINT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional()
  ),
  MINIO_ACCESS_KEY: z.string(),
  MINIO_SECRET_KEY: z.string(),
  MINIO_BUCKET_AVATARS: z.string().min(1).default("aimess-avatars"),
  MINIO_REGION: z.string(),
  MINIO_VIEW_EXPIRES_IN: z.coerce.number().positive().default(3600),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  process.stderr.write("Invalid environment variables\n");
  process.stderr.write(JSON.stringify(parsed.error.format(), null, 2) + "\n");
  process.exit(1);
}

export const env = parsed.data;
