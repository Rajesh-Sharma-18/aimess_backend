import dotenv from "dotenv";
import { z } from "zod";

import { assertNoPlaceholderCredentials, expandFileSecrets } from "@aimess/utils";

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
  /**
   * Wrap the Redis connection in TLS. Off by default so a loopback or
   * private-network Redis is unchanged; set true wherever the connection leaves
   * the host, because the AUTH password and — since Redis pub/sub is the
   * realtime fan-out — every message body otherwise travel in cleartext.
   */
  REDIS_TLS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  REDIS_CACHE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  /** Reserved for future stream events (publish/consume). Optional on boot. */
  RABBITMQ_URL: z.string().min(1).optional(),

  /** Same secret as auth-service — used to verify access tokens. */
  JWT_ACCESS_SECRET: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(32).optional()
  ),
  /**
   * RS256 public key that verifies access tokens (PEM).
   *
   * The platform-wide fix for one symmetric secret being copied into eight
   * services: with a keypair, auth-service alone holds the private half and is
   * the only process able to MINT a token, while every other service holds only
   * this public half, which is not a secret. A leak from any service other than
   * auth-service then discloses nothing that can forge a session.
   *
   * Optional during the migration — set it alongside JWT_ACCESS_SECRET and both
   * are accepted, so tokens signed before the switch keep verifying until they
   * expire. Supply it as JWT_ACCESS_PUBLIC_KEY_FILE to mount it as a file.
   */
  JWT_ACCESS_PUBLIC_KEY: z.string().optional(),
  /**
   * Reject access tokens that carry no `iss`/`aud`. Leave false until every
   * token minted before those claims existed has expired (one access-token
   * lifetime after deploying), then turn it on.
   */
  JWT_REQUIRE_ISSUER_AUDIENCE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /** user-service gRPC endpoint — comment author snapshots. */
  USER_GRPC_URL: z.string().default("0.0.0.0:4002"),
  /** community-service gRPC endpoint — go-live membership validation. */
  COMMUNITY_GRPC_URL: z.string().default("0.0.0.0:4003"),

  // ---- Livestream policy ----
  /** Comma-separated list of allowed ingest modes minted to a creator (whip|rtmp). */
  STREAM_INGEST_MODES: z.string().default("whip,rtmp"),
  /** Max simultaneous PENDING+LIVE streams a single community may have. */
  /**
   * How many PENDING (created, never published) streams one creator may hold.
   *
   * The LIVE caps deliberately ignore PENDING, so without this nothing bounded
   * stream creation at all. Two leaves room for an abandoned setup plus a
   * retry; the stale-PENDING sweeper reclaims them either way.
   */
  STREAM_MAX_PENDING_PER_CREATOR: z.coerce.number().int().positive().default(2),
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
  /** Sliding window (seconds) for the per-creator stream-create rate limit. */
  STREAM_CREATE_RATE_WINDOW_SEC: z.coerce.number().positive().default(60),
  /** Max POST /streams per creator per STREAM_CREATE_RATE_WINDOW_SEC. */
  STREAM_CREATE_RATE_MAX: z.coerce.number().positive().default(5),

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

  // ---- yt-dlp source resolver (URL streams whose host has no embeddable player) ----
  /**
   * Off unless the host actually has the binary — an enabled resolver with no
   * `yt-dlp` on PATH fails every request instead of falling back to the
   * client's platform-embed path.
   */
  /**
   * Parsed strictly, and loudly. The previous `v === "true"` silently treated
   * YTDLP_ENABLED=1 / yes / On / a typo as OFF, so the feature could be
   * "configured" and simply never run with nothing in the logs to say why.
   * An unrecognised value now fails env validation at boot instead.
   */
  YTDLP_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.trim().toLowerCase())
    .refine(
      (v) => ["true", "1", "yes", "on", "false", "0", "no", "off", ""].includes(v),
      { message: "must be one of true/1/yes/on or false/0/no/off" }
    )
    .transform((v) => ["true", "1", "yes", "on"].includes(v)),
  YTDLP_PATH: z.string().default("yt-dlp"),
  /** Hard kill for one extraction. yt-dlp will otherwise wait on a dead host. */
  YTDLP_TIMEOUT_MS: z.coerce.number().positive().default(20_000),
  /**
   * How long a resolved media URL is reused. Must stay well under the shortest
   * lifetime hosts give their signed URLs (commonly ~6h, sometimes minutes),
   * because a cached URL that has already expired plays as a hard 403.
   */
  YTDLP_CACHE_TTL_SEC: z.coerce.number().positive().default(900),
  /** Skips renditions above this height so a 4K source cannot pick an unplayable ladder rung. */
  YTDLP_MAX_HEIGHT: z.coerce.number().positive().default(1080),
  /**
   * Ceiling on concurrent yt-dlp processes for the whole service. The gateway's
   * limiter is per-session, so without a global cap N sessions fork N
   * extractions and the container dies of memory, not of rate.
   */
  YTDLP_MAX_CONCURRENCY: z.coerce.number().positive().default(4),

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

// `FOO_FILE=/run/secrets/foo` supplies `FOO`, so a secret can be a mounted
// file (Docker/Kubernetes secrets) instead of an environment variable that
// leaks through /proc, crash dumps, `docker inspect` and CI logs — and so
// rotation is replacing a file rather than editing .env on every host.
const expanded = expandFileSecrets(process.env);
const parsed = envSchema.safeParse(expanded);

if (!parsed.success) {
  process.stderr.write("Invalid environment variables\n");
  process.stderr.write(JSON.stringify(parsed.error.format(), null, 2) + "\n");
  process.exit(1);
}

export const env = parsed.data;

// Refuse to start a production deployment whose credentials are values
// published in this repository. The schema can see that a string is present and
// long enough; it cannot see that everyone already knows what it says. Matched
// by variable NAME shape, so a secret added tomorrow is covered without anyone
// remembering to extend a list.
try {
  assertNoPlaceholderCredentials(expanded, {
    nodeEnv: env.NODE_ENV,
    serviceName: "stream-service",
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}


/**
 * How this service verifies access tokens.
 *
 * One object rather than a bare secret, because verification now has three
 * inputs: the legacy shared secret, the RS256 public key that replaces it, and
 * whether `iss`/`aud` are mandatory yet. Every call site takes this, so they
 * cannot drift apart — and so moving to a keypair is a configuration change
 * rather than a code change in each service.
 */
export const accessTokenVerifyConfig = {
  secret: env.JWT_ACCESS_SECRET,
  publicKey: env.JWT_ACCESS_PUBLIC_KEY,
  requireIssuerAudience: env.JWT_REQUIRE_ISSUER_AUDIENCE,
};

/**
 * Refuse to start with no way to verify a token at all.
 *
 * The schema cannot express "one of these two", and a service that boots
 * without either would reject every request — or, worse, a future refactor
 * could make it accept them unverified.
 */
if (!env.JWT_ACCESS_SECRET && !env.JWT_ACCESS_PUBLIC_KEY) {
  console.error(
    "Refusing to start: set JWT_ACCESS_PUBLIC_KEY (preferred) or JWT_ACCESS_SECRET — without one, no access token can be verified."
  );
  process.exit(1);
}
