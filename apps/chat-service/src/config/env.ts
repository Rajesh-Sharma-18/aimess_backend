import dotenv from "dotenv";
import { z } from "zod";

import { assertNoPlaceholderCredentials, expandFileSecrets } from "@aimess/utils";

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
  // Comma-separated "host:port" pairs to enable Redis Cluster mode.
  // Example: 127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003
  // Leave unset to use a single Redis node (REDIS_HOST / REDIS_PORT).
  REDIS_CLUSTER_NODES: z.string().optional(),

  // `.min(32)`: previously a bare `z.string()`, so "" or "x" passed boot
  // validation. A one-character HS256 secret is brute-forceable offline from a
  // single captured token, and this secret is shared by every service that
  // verifies user tokens — one weak value forges tokens platform-wide.
  JWT_ACCESS_SECRET: z.preprocess(
    (v) => (v === "" ? undefined : v),
    // Optional so a deployment that has moved to the keypair can REMOVE
    // it entirely — which is the whole point of the migration. The boot
    // assertion below requires one of the two.
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
  /** media-service gRPC — attachment scan-verdict verification at send time. */
  MEDIA_GRPC_URL: z.string().default("0.0.0.0:4009"),
  /**
   * Master switch for the send-time attachment verification gate.
   *
   * Default ON: an unverified attachment must not become a persisted, fanned-out
   * message reference. Set false ONLY for a controlled rollout window in an
   * environment whose existing clients do not yet call `/media/confirm`, and
   * watch the `media.attachment_unverified` log to size the gap before flipping
   * it back. See docs/MEDIA_SECURITY_AUDIT.md §Backward Compatibility.
   */
  CHAT_MEDIA_VERIFY_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
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
  // (`/+<code>`, `/<handle>`) and group (`/g/<token>`) invite links. MUST match
  // community-service's value or the two mint links on different domains; the
  // default mirrors community-service's so an unset env cannot split them.
  INVITE_LINK_BASE_URL: z.string().url().default("https://ai5dev.tech"),

  // LiveKit Cloud. See Docs/calls/CALLS-LIVEKIT.md.
  // LIVEKIT_URL is the wss:// project URL, and it is REQUIRED with no default.
  // It is not merely read here: it is stamped verbatim into every call payload
  // and every VoIP push as `livekitUrl`, and the clients connect to whatever it
  // says. The old default was ws://localhost:7880, so an environment that
  // forgot the variable booted happily and told every phone to dial ITSELF --
  // calls then fail at media with no server-side error to find. Failing the
  // boot is the only safe default, same posture as the key/secret below.
  LIVEKIT_URL: z.string().min(1),
  // Required, with NO default. These used to fall back to a key/secret pair
  // published in this repository, and chat-service mints EVERY 1-to-1 call join
  // token with them (roomJoin/canPublish/canSubscribe over a room named after
  // the callId). A deployment that forgot to set them therefore signed real
  // call grants with a public secret, letting anyone forge a token and join or
  // publish into any user's private call. Failing the boot is the only safe
  // default here — same posture as GRPC_SERVICE_TOKEN.
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(32),
  LIVEKIT_TOKEN_TTL: z.coerce.number().positive().default(10800),

  // Ringing timeout: a Call left in RINGING for longer than this flips to
  // MISSED via a periodic sweep. Multi-node safe (atomic updateMany).
  CALL_RINGING_TIMEOUT_SEC: z.coerce.number().positive().default(60),
  // Sweep granularity, NOT the ring window — a row is only eligible once
  // CALL_RINGING_TIMEOUT_SEC has already elapsed, so this is pure added latency
  // on top of it. It is the ONLY slack available when a callee's decline never
  // reaches the server (a backgrounded client whose socket write was lost): the
  // caller sits on "Calling…" for the ring window plus this. At 15 s that was a
  // 75 s worst case; at 5 s it is 65 s. The query behind it is one indexed
  // lookup bounded by CALL_TIMEOUT_SWEEP_BATCH, so running it 3× as often is
  // not a meaningful cost. Lowering the RING WINDOW instead would be wrong —
  // that is how long a phone is supposed to ring.
  CALL_TIMEOUT_SWEEP_INTERVAL_SEC: z.coerce.number().positive().default(5),
  CALL_TIMEOUT_SWEEP_BATCH: z.coerce.number().positive().default(100),

  // Presence liveness.
  //
  // A device session is believed live for PRESENCE_SESSION_TTL_SEC without a
  // refresh; the api-gateway refreshes every live socket well inside that
  // window (packet-driven keepalive in chat.ns.ts, plus the client's own
  // `presence:heartbeat`). The TTL therefore only has to survive a couple of
  // missed refreshes — it is the backstop for the case where NO `disconnect`
  // event ever arrives (killed process, dead TCP path, crashed gateway node).
  //
  // The sweep is what turns that silent expiry into an actual OFFLINE event:
  // without it a stale session just rots and every watcher keeps a green dot.
  // Worst-case detection latency is roughly TTL + sweep interval.
  PRESENCE_SESSION_TTL_SEC: z.coerce.number().positive().default(150),
  PRESENCE_SWEEP_INTERVAL_SEC: z.coerce.number().positive().default(30),
  PRESENCE_SWEEP_BATCH: z.coerce.number().positive().default(500),
  // Status key retention. Must comfortably outlive any live session: if it
  // expired under a still-online user, their eventual disconnect would compute
  // offline→offline, publish nothing, and strand every watcher on "Online".
  PRESENCE_STATUS_TTL_SEC: z.coerce
    .number()
    .positive()
    .default(60 * 60 * 24),

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
  CALL_MAX_DURATION_SEC: z.coerce.number().positive().default(10800),
});

// `FOO_FILE=/run/secrets/foo` supplies `FOO`, so a secret can be a mounted
// file (Docker/Kubernetes secrets) instead of an environment variable that
// leaks through /proc, crash dumps, `docker inspect` and CI logs — and so
// rotation is replacing a file rather than editing .env on every host.
const expanded = expandFileSecrets(process.env);
const parsed = envSchema.safeParse(expanded);

if (!parsed.success) {
  process.stderr.write("Invalid Environment Variables\n");
  process.stderr.write(JSON.stringify(parsed.error.format(), null, 2) + "\n");
  process.exit(1);
}

const data = parsed.data;

// Refuse to start a production deployment whose credentials are values
// published in this repository. The schema can see that a string is present and
// long enough; it cannot see that everyone already knows what it says. Matched
// by variable NAME shape, so a secret added tomorrow is covered without anyone
// remembering to extend a list.
try {
  assertNoPlaceholderCredentials(expanded, {
    nodeEnv: data.NODE_ENV,
    serviceName: "chat-service",
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}


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

/**
 * Production invariants that no single-field schema rule can express.
 *
 * CHAT_MEDIA_VERIFY_ENABLED=false disables all three checks the attachment
 * guard performs — scan-verified, registry owner == sender, registry resource
 * == this room — for every send path in the service. With it off, a user can
 * attach any object key they can name to any room, and because chat-service
 * presigns object storage directly on read, media-service's own authorization
 * never runs either. It is a deliberate rollout escape hatch, so it stays, but
 * only outside production. Mirrors the fail-fast in `withServiceAuth`.
 */
if (env.NODE_ENV === "production" && !env.CHAT_MEDIA_VERIFY_ENABLED) {
  process.stderr.write(
    "Refusing to start: CHAT_MEDIA_VERIFY_ENABLED=false is not permitted in " +
      "production — it disables attachment ownership, scope and scan " +
      "verification on every send path.\n"
  );
  process.exit(1);
}
