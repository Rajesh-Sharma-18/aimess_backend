import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { status as grpcStatus } from "@grpc/grpc-js";
import { logger } from "@aimess/logger";
import { env } from "../../config/env.js";
import { createGatewaySocketAuthMiddleware } from "../auth.middleware.js";
import { bindSocketAuditContext } from "../audit-context.js";
import { ackOk, ackError } from "../ack.js";
import type { StreamClient } from "../../grpc/clients/stream.client.js";
import { scopeSocketLocale } from "../locale-scope.js";
import type { MediaClient } from "../../grpc/clients/media.client.js";

// §3: bound free-text fields so a naive or abusive client cannot exceed the
// 1 MB socket frame, blow up storage, or fan an oversized payload out to a whole
// livestream room. These are coarse gateway guards; stream-service enforces the
// authoritative limits.
const MAX_MESSAGE_LEN = 500; // a single livestream comment
const MAX_EMOJI_LEN = 32; // one emoji grapheme incl. ZWJ/skin-tone sequences

// Recent-comment backfill returned on join.
const RECENT_COMMENTS_LIMIT = 20;

// Session-set TTL: auto-expires so a crashed gateway (unclean disconnect) cannot
// leave a livestream pinned at a phantom count.
const VIEWER_KEY_TTL_SEC = 7200; // 2h

// stream:comment sliding-window rate limit (per user, per stream).
const COMMENT_RATE_MAX = 10; // comments allowed…
const COMMENT_RATE_WINDOW_SEC = 5; // …per this window

// Debounce viewer_count broadcasts to ≤ 1 emit/sec per stream so a join/leave
// storm cannot fan a flood of identical counts out to a whole room.
const VIEWER_COUNT_DEBOUNCE_MS = 1000;

const roomKey = (streamId: string): string => `stream:${streamId}`;
// Presence hash: userId -> refcount of currently-open sockets for that user.
// HINCRBY +1 on every socket join, HINCRBY -1 on leave, HDEL when the count
// reaches 0. HLEN is the unique-viewer count. This shape (vs. a bare SET of
// userIds) is what makes multi-tab / phone+web work: closing one tab only
// drops the user from the count when it was the LAST tab.
const sessionKey = (streamId: string): string =>
  `stream:session:users:${streamId}`;
// Join-time hash: userId -> epoch ms of first join. HSETNX so a heartbeat/
// rejoin refresh never overwrites the original join time. Read by
// stream-service's getViewers() alongside the presence hash above.
const sessionJoinedKey = (streamId: string): string =>
  `stream:session:joined:${streamId}`;

// ─── Inbound payload schemas ────────────────────────────────────────────────
const StreamJoinSchema = z.object({ streamId: z.string().min(1) });
const StreamLeaveSchema = z.object({ streamId: z.string().min(1) });
const StreamCommentSchema = z.object({
  streamId: z.string().min(1),
  message: z.string().min(1).max(MAX_MESSAGE_LEN),
  clientCommentId: z.string().max(200).optional(),
});
const StreamReactSchema = z.object({
  streamId: z.string().min(1),
  emoji: z.string().min(1).max(MAX_EMOJI_LEN),
});
const StreamLoadMoreSchema = z.object({
  streamId: z.string().min(1),
  before: z.string().optional(), // history scroll: fetch comments older than this id
  after: z.string().optional(), // catch-up: fetch comments newer than this id (reconnect gap fill)
  limit: z.number().int().min(1).max(50).optional(),
});
const StreamCommentDeleteSchema = z.object({
  streamId: z.string().min(1),
  commentId: z.string().min(1),
});
const StreamHeartbeatSchema = z.object({ streamId: z.string().min(1) });

// ─── Redis pub/sub message shape published by stream-service ─────────────────
// stream-service publishes { event: "stream:comment:new"|"stream:status", data }
// to channel "stream:<streamId>"; we fan it out to the matching room verbatim.
interface RedisSocketEvent {
  event: string;
  data: unknown;
}

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);
// ponytail: in-process cache; presigned URLs expire in 1 h (X-Amz-Expires=3600), 50-min TTL = 10-min safety margin
const avatarUrlCache = new Map<string, { url: string; expiresAt: number }>();
const AVATAR_URL_CACHE_TTL_MS = 50 * 60 * 1000;

/** Presign a USER_AVATAR object key to a download URL; returns null on any error. */
async function presignAvatar(
  mediaClient: MediaClient,
  objectKey: string,
  requesterId: string
): Promise<string | null> {
  if (!objectKey) return null;
  // stream-service now resolves senderAvatar to a full URL itself — pass it
  // through unchanged instead of re-presigning (avoids a wasted media-service
  // round trip and treating a URL as an object key).
  if (isHttpUrl(objectKey)) return objectKey;
  const cached = avatarUrlCache.get(objectKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  try {
    const res = await mediaClient.generateDownloadUrl({
      objectKey,
      category: "USER_AVATAR",
      requesterId,
    });
    const url = res?.downloadUrl ?? null;
    if (url)
      avatarUrlCache.set(objectKey, {
        url,
        expiresAt: Date.now() + AVATAR_URL_CACHE_TTL_MS,
      });
    return url;
  } catch {
    // On media-service failure, serve stale cache rather than falling through to raw key.
    return cached?.url ?? null;
  }
}

/**
 * Enrich a raw comment payload by replacing the senderAvatar object key with a
 * presigned download URL. Returns the comment unchanged if the key is empty or
 * presigning fails.
 */
async function enrichCommentAvatar(
  mediaClient: MediaClient,
  comment: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const key =
    typeof comment.senderAvatar === "string" ? comment.senderAvatar : "";
  const senderId = typeof comment.senderId === "string" ? comment.senderId : "";
  if (!key) return comment;
  const url = await presignAvatar(mediaClient, key, senderId);
  // On presign failure fall back to the raw object key rather than "".
  // resolveStreamCommentAvatar() on the client prepends cdnUrl for non-http values,
  // so the key still resolves to an image instead of being silently dropped.
  return { ...comment, senderAvatar: url ?? key };
}

export function registerStreamNamespace(
  io: SocketIOServer,
  streamClient: StreamClient,
  redisSub: Redis,
  redisPub: Redis,
  mediaClient: MediaClient
): void {
  const streamNs: Namespace = io.of("/stream");
  streamNs.use(createGatewaySocketAuthMiddleware(redisPub));

  // `stream:viewer_count` is computed HERE from the Redis presence hash — it is
  // the one stream event stream-service never publishes, so the admin monitor
  // cannot pick it up off the `stream:*` channel like the others. Mirror it into
  // the identically-named /admin room (room registries are per-namespace).
  //
  // `io.of` is resolved lazily, at emit time rather than setup time, so this can
  // never create /admin before admin.ns.ts has attached its auth middleware; the
  // env guard is the same condition index.ts registers the namespace on, so when
  // /admin is absent nothing is created at all.
  const broadcastViewerCount = (streamId: string, count: number): void => {
    const payload = { streamId, viewerCount: Math.max(0, count) };
    streamNs.to(roomKey(streamId)).emit("stream:viewer_count", payload);
    if (!env.JWT_ADMIN_SECRET) return;
    io.of("/admin").to(roomKey(streamId)).emit("stream:viewer_count", payload);
  };

  // Handle a stream:banned event from stream-service: notify + remove the banned
  // user's live sockets from the room (channel === roomKey(streamId)). Their
  // rejoin is independently blocked by the CheckStreamAccess gate.
  const kickBannedUser = async (room: string, data: unknown): Promise<void> => {
    const { streamId, userId: bannedUserId } = (data ?? {}) as {
      streamId?: string;
      userId?: string;
    };
    if (!streamId || !bannedUserId) return;
    try {
      const sockets = await streamNs.in(room).fetchSockets();
      for (const s of sockets) {
        if (s.data.userId !== bannedUserId) continue;
        s.emit("stream:banned", { streamId });
        void s.leave(room);
        // Ensure the disconnect handler on the kicked socket doesn't
        // decrement again — the HDEL below nukes the whole refcount.
        const incremented = s.data.streamIncremented as Set<string> | undefined;
        incremented?.delete(streamId);
      }
      // Nuke the banned user's whole refcount (any/all tabs) so getViewers /
      // viewer_count reflect the kick immediately, regardless of how many
      // sockets they had open.
      try {
        await redisPub.hdel(sessionKey(streamId), bannedUserId);
        await redisPub.hdel(sessionJoinedKey(streamId), bannedUserId);
      } catch (err) {
        logger.warn(
          `/stream ban session hdel error for ${streamId}: ${String(err)}`
        );
      }
      // Close their durable viewer session too — best-effort.
      streamClient
        .recordViewerLeave({ streamId, userId: bannedUserId })
        .catch((err: unknown) =>
          logger.warn(
            `/stream ban recordViewerLeave failed for ${streamId}: ${String(err)}`
          )
        );
      // Broadcast the corrected viewer count (HLEN is unique-user count).
      try {
        broadcastViewerCount(
          streamId,
          await redisPub.hlen(sessionKey(streamId))
        );
      } catch (err) {
        logger.warn(
          `/stream ban viewer_count broadcast error for ${streamId}: ${String(err)}`
        );
      }
    } catch (err) {
      logger.warn(`/stream ban kick error for ${room}: ${String(err)}`);
    }
  };

  // Handle a stream:member_muted / stream:member_unmuted event from
  // stream-service: targeted push to the affected user's live socket(s) so
  // their UI can disable/re-enable the composer without a rejoin. Unlike a
  // ban, mute never removes the user from the room — they can keep watching.
  // The write-path checks in stream-service remain authoritative regardless of
  // whether this push arrives or is stale.
  const notifyMuteStatus = async (
    room: string,
    event: "stream:member_muted" | "stream:member_unmuted",
    data: unknown
  ): Promise<void> => {
    const { streamId, userId: targetUserId } = (data ?? {}) as {
      streamId?: string;
      userId?: string;
    };
    if (!streamId || !targetUserId) return;
    const canCommentNext = event === "stream:member_unmuted";
    try {
      const sockets = await streamNs.in(room).fetchSockets();
      for (const s of sockets) {
        if (s.data.userId !== targetUserId) continue;
        s.emit(event, data);
        // Update the per-socket canComment cache so the react-path gate
        // (which never round-trips to stream-service) can't be bypassed by a
        // muted user until they leave and rejoin. Local sockets only —
        // remote-socket mutations don't propagate, but each gateway instance
        // receives the same pmessage independently and updates its own
        // locals, so the invariant holds across the cluster.
        const perms = s.data.streamCommentPermissions as
          | Map<string, boolean>
          | undefined;
        if (perms && perms.has(streamId)) perms.set(streamId, canCommentNext);
      }
    } catch (err) {
      logger.warn(`/stream ${event} notify error for ${room}: ${String(err)}`);
    }
  };

  // Update every viewer's per-socket canComment cache when the broadcaster
  // toggles chat open/closed. Mirrors notifyMuteStatus's cache update — same
  // "stream-service is authoritative on writes, gateway cache is refreshed
  // in-flight so ephemeral react-path gates stay honest" pattern.
  const applyCommentStatus = async (
    room: string,
    data: unknown
  ): Promise<void> => {
    const { streamId, commentStatus } = (data ?? {}) as {
      streamId?: string;
      commentStatus?: boolean;
    };
    if (!streamId || typeof commentStatus !== "boolean") return;
    try {
      const sockets = await streamNs.in(room).fetchSockets();
      for (const s of sockets) {
        const perms = s.data.streamCommentPermissions as
          | Map<string, boolean>
          | undefined;
        // A viewer who was already blocked by mute stays blocked — chat
        // reopening doesn't unmute them. Only flip if the cache says true→false
        // (freeze applies to everyone) or if the cache is currently `true` and
        // status becomes `true` (no-op). For the reopen case (false→true) we
        // conservatively leave the cache alone: individual mute state is
        // authoritative there and only a per-user unmute event lifts it.
        if (!perms || !perms.has(streamId)) continue;
        if (!commentStatus) perms.set(streamId, false);
      }
    } catch (err) {
      logger.warn(
        `/stream comment_status cache update error for ${room}: ${String(err)}`
      );
    }
  };

  // Dedicated subscriber for livestream channels. stream-service is the sole
  // publisher of stream:comment:new and stream:status — the gateway NEVER emits
  // those itself; it only relays whatever lands on stream:<id>.
  void redisSub.psubscribe("stream:*");
  redisSub.on(
    "pmessage",
    (pattern: string, channel: string, message: string) => {
      if (pattern !== "stream:*") return;
      try {
        const parsed = JSON.parse(message) as RedisSocketEvent;
        // stream:banned is targeted, not a room broadcast — intercept it so we
        // only notify + kick the banned user instead of telling the whole room.
        if (parsed.event === "stream:banned") {
          void kickBannedUser(channel, parsed.data);
          return;
        }
        // stream:member_muted / stream:member_unmuted are likewise targeted —
        // only the affected user's socket(s) need it, not the whole room.
        if (
          parsed.event === "stream:member_muted" ||
          parsed.event === "stream:member_unmuted"
        ) {
          void notifyMuteStatus(channel, parsed.event, parsed.data);
          return;
        }
        // Chat freeze / unfreeze: fan out to the room AND update every local
        // socket's canComment cache so the stream:react gate stops accepting
        // reactions the instant the broadcaster freezes chat — without waiting
        // for the viewer to rejoin.
        if (parsed.event === "stream:comment_status") {
          void applyCommentStatus(channel, parsed.data);
          streamNs.to(channel).emit(parsed.event, parsed.data);
          return;
        }
        // Presign the senderAvatar object key before emitting live comments so
        // clients receive a ready-to-use image URL, not a raw S3 key. Plain room
        // broadcast (NOT emitPersonalizedSender): a livestream comment shows the
        // author's real @username to everyone, the sender included — rewriting it
        // to "You" per-socket made the sender's optimistic bubble flicker its name.
        if (parsed.event === "stream:comment:new") {
          void (async () => {
            try {
              const enriched = await enrichCommentAvatar(
                mediaClient,
                parsed.data as Record<string, unknown>
              );
              streamNs.to(channel).emit("stream:comment:new", enriched);
            } catch {
              streamNs.to(channel).emit("stream:comment:new", parsed.data);
            }
          })();
          return;
        }
        // stream:status carries internal broadcaster context when status === "LIVE"
        // (creatorId, hlsUrl, flvUrl, startedAt — set by publishStatus in stream-service).
        // Strip those fields from the room broadcast so clients only receive the
        // stable { streamId, status } shape, then send stream:broadcast:live
        // directly to the broadcaster's socket with the full ingest context.
        if (parsed.event === "stream:status") {
          const d = (parsed.data ?? {}) as {
            streamId?: string;
            status?: string;
            communityId?: string;
            creatorId?: string;
            hlsUrl?: string;
            flvUrl?: string;
            startedAt?: number;
          };
          // Broadcast the clean status event to all viewers in the room.
          // communityId is included so FE on the stream viewer screen can update
          // the community isLive badge without a separate /community room subscription.
          streamNs.to(channel).emit("stream:status", {
            streamId: d.streamId,
            status: d.status,
            communityId: d.communityId,
          });
          // If this is a LIVE transition, find the broadcaster's socket and send them
          // a targeted confirmation so their UI can switch to "You are live!".
          if (d.status === "LIVE" && d.creatorId) {
            void (async () => {
              try {
                const sockets = await streamNs.in(channel).fetchSockets();
                for (const s of sockets) {
                  if (s.data.userId !== d.creatorId) continue;
                  s.emit("stream:broadcast:live", {
                    streamId: d.streamId,
                    startedAt: d.startedAt,
                    hlsUrl: d.hlsUrl ?? "",
                    flvUrl: d.flvUrl ?? "",
                  });
                }
              } catch (err) {
                logger.warn(
                  `/stream broadcast:live targeted emit error on ${channel}: ${String(err)}`
                );
              }
            })();
          }
          // If this is an ENDED transition, also send stream:status directly to
          // the creator's socket across the whole namespace — they may have already
          // left the stream room (e.g. kicked out by a prior stream:banned event
          // during a community ban) and would otherwise miss this event, leaving
          // their broadcast running with no signal to stop.
          if (d.status === "ENDED" && d.creatorId) {
            void (async () => {
              try {
                const sockets = await streamNs.fetchSockets();
                for (const s of sockets) {
                  if (s.data.userId !== d.creatorId) continue;
                  if (s.rooms.has(channel)) continue; // already got it via room broadcast
                  s.emit("stream:status", {
                    streamId: d.streamId,
                    status: "ENDED",
                    communityId: d.communityId,
                  });
                }
              } catch (err) {
                logger.warn(
                  `/stream broadcast:ended targeted emit error on ${channel}: ${String(err)}`
                );
              }
            })();
          }
          return;
        }
        streamNs.to(channel).emit(parsed.event, parsed.data);
      } catch (err) {
        logger.warn(
          `/stream Redis message parse error on ${channel}: ${String(err)}`
        );
      }
    }
  );

  // PER-STREAM (not per-socket) debounce timers for viewer_count, keyed by
  // streamId. Namespace-scoped deliberately: when this map lived inside the
  // connection handler every socket had its OWN timer, so a join/leave burst in
  // a large room fired one room-wide broadcast per participating socket instead
  // of one per stream — N sockets reacting to the same burst produced N
  // broadcasts, each fanned out to all N viewers (O(N²) messages). Shared here,
  // a burst collapses to exactly one broadcast per stream per window no matter
  // how many sockets triggered it.
  //
  // ponytail: per-gateway-instance, not cluster-global. With the redis-adapter
  // each instance still emits its own coalesced broadcast, so the ceiling is
  // (instances) emits/sec/stream rather than 1 — bounded by deploy size, not by
  // audience size, which is what actually matters here. A cluster-wide lock
  // (Redis SET NX PX) would flatten it to exactly 1 if instance count ever grows
  // enough to matter.
  const viewerCountTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Read the live viewer count and broadcast it to the room, debounced to
  // ≤ 1 emit/sec per stream. The emit goes via the redis-adapter so every
  // gateway instance's sockets in the room receive it.
  const emitViewerCount = (streamId: string): void => {
    if (viewerCountTimers.has(streamId)) return;
    const timer = setTimeout(() => {
      viewerCountTimers.delete(streamId);
      redisPub
        .hlen(sessionKey(streamId))
        .then((count) => {
          broadcastViewerCount(streamId, count);
        })
        .catch((err: unknown) => {
          logger.warn(
            `/stream viewer_count read error for ${streamId}: ${String(err)}`
          );
        });
    }, VIEWER_COUNT_DEBOUNCE_MS);
    viewerCountTimers.set(streamId, timer);
  };

  streamNs.on("connection", (socket: Socket) => {
    const { userId, sessionId, locale } = socket.data;
    scopeSocketLocale(socket, redisPub);
    bindSocketAuditContext(socket);
    // Session room, as /chat, /community and /notify all do. This is what the
    // shared `session-revoke:*` listener targets, so without it a revoked
    // session (remote sign-out, or an admin ban that force-logs-the-user-out)
    // kicked every other namespace while the viewer kept watching the stream.
    void socket.join(`session:${sessionId}`);
    // User room. /stream psubscribes only `stream:*`, so joining this does not
    // pull in /chat's `user:*` relay — it exists purely so the USER-scoped
    // `user-ban:*` listener can reach a live broadcaster or viewer. Without it
    // a permanent ban left the offender's stream socket connected until their
    // access token happened to expire.
    void socket.join(`user:${userId}`);
    logger.debug(
      `/stream connected userId=${userId} recovered=${socket.recovered}`
    );

    // Streams this specific socket has contributed +1 to. The decrement paths
    // (leave / disconnect / kick) key off this set, not `socket.rooms`, so we
    // never double-decrement a user who joined the same room from two tabs.
    const streamIncremented = new Set<string>();
    (socket.data as { streamIncremented?: Set<string> }).streamIncremented =
      streamIncremented;

    // Per-socket increment: bumps the user's refcount, keeps join-time
    // hash + TTLs fresh, and remembers the streamId locally so the leave path
    // can decrement exactly once. Returns the current HLEN, or null on error.
    const incrementPresence = async (
      streamId: string
    ): Promise<number | null> => {
      try {
        await redisPub.hincrby(sessionKey(streamId), userId, 1);
        await redisPub.expire(sessionKey(streamId), VIEWER_KEY_TTL_SEC);
        await redisPub.hsetnx(
          sessionJoinedKey(streamId),
          userId,
          String(Date.now())
        );
        await redisPub.expire(sessionJoinedKey(streamId), VIEWER_KEY_TTL_SEC);
        streamIncremented.add(streamId);
        return await redisPub.hlen(sessionKey(streamId));
      } catch (err) {
        logger.warn(
          `/stream presence increment error for ${streamId}: ${String(err)}`
        );
        return null;
      }
    };

    // Per-socket decrement: drops the user from the refcount, HDELs the entry
    // (and the join-time hash) when this was the user's last open socket.
    // No-op if this socket never incremented for `streamId`.
    const decrementPresence = async (streamId: string): Promise<void> => {
      if (!streamIncremented.delete(streamId)) return;
      try {
        const remaining = await redisPub.hincrby(
          sessionKey(streamId),
          userId,
          -1
        );
        if (remaining <= 0) {
          await redisPub.hdel(sessionKey(streamId), userId);
          await redisPub.hdel(sessionJoinedKey(streamId), userId);
        }
      } catch (err) {
        logger.warn(
          `/stream presence decrement error for ${streamId}: ${String(err)}`
        );
      }
    };

    // connectionStateRecovery: Socket.IO restored this socket into its previous
    // rooms after a brief network drop. The disconnecting handler already ran
    // its decrement for the prior socket instance, so re-increment here to
    // keep the live count correct without a full stream:join from the client.
    if (socket.recovered) {
      for (const room of socket.rooms) {
        if (room.startsWith("stream:") && !room.startsWith("stream:viewers:")) {
          const streamId = room.slice("stream:".length);
          void incrementPresence(streamId).then((count) => {
            if (count === null) return;
            streamNs.to(roomKey(streamId)).emit("stream:viewer_count", {
              streamId,
              viewerCount: Math.max(0, count),
            });
          });
        }
      }
    }

    // Per-socket cache of the `canComment` gate (membership + mute +
    // commentStatus), keyed by streamId. Reactions never round-trip to
    // stream-service, so this cache is what blocks a muted user from reacting;
    // comments are additionally enforced server-side at the gRPC write path.
    // Stashed on socket.data so the pmessage-side notifyMuteStatus /
    // applyCommentStatus helpers can mutate it when mute/comment_status events
    // arrive mid-stream — otherwise the cache would stay stuck at the join-time
    // value and a muted user could keep reacting until they rejoin.
    const streamCommentPermissions = new Map<string, boolean>();
    (
      socket.data as { streamCommentPermissions?: Map<string, boolean> }
    ).streamCommentPermissions = streamCommentPermissions;

    // Sliding-window rate limit on comments (INCR + EXPIRE on first hit).
    // Fails OPEN: a Redis outage must not silence livestream chat.
    const isCommentRateLimited = async (streamId: string): Promise<boolean> => {
      const key = `rl:stream-comment:${userId}:${streamId}`;
      try {
        const count = await redisPub.incr(key);
        if (count === 1) {
          await redisPub.expire(key, COMMENT_RATE_WINDOW_SEC);
        }
        return count > COMMENT_RATE_MAX;
      } catch {
        return false; // fail open
      }
    };

    socket.on(
      "stream:join",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = StreamJoinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        const { streamId } = r.data;
        void (async () => {
          // Join gate: only non-banned ACTIVE community members (or the owner)
          // may enter. Fail-closed — a check error denies entry.
          let canComment: boolean;
          let access: Awaited<
            ReturnType<typeof streamClient.checkStreamAccess>
          >;
          try {
            access = await streamClient.checkStreamAccess({ streamId, userId });
            if (!access.allowed) {
              ackError(callback, "FORBIDDEN", locale);
              return;
            }
            canComment = access.canComment;
          } catch (err) {
            logger.warn(
              `/stream join access check failed for ${streamId}: ${String(err)}`
            );
            // Emit stream:error so the FE can distinguish a service outage from a
            // permanent ban (SERVICE_ERROR ack is retryable; FORBIDDEN is not).
            socket.emit("stream:error", {
              streamId,
              code: "SERVICE_UNAVAILABLE",
            });
            ackError(callback, "SERVICE_ERROR", locale);
            return;
          }

          void socket.join(roomKey(streamId));
          streamCommentPermissions.set(streamId, canComment);

          // Telegram-style "newest session wins" — emit stream:session:superseded
          // to any OTHER socket of the SAME user already viewing this stream, so
          // the older tab/device closes its viewer while this new one plays.
          // Broadcaster protection: skip when the joining user is the stream's
          // creator. A broadcaster opening the viewer in a second tab of their
          // OWN stream (or their broadcast socket ever landing in this room)
          // must not be kicked. Non-broadcaster viewers get the full kick.
          if (userId !== access.creatorId) {
            try {
              const peers = await streamNs.in(roomKey(streamId)).fetchSockets();
              for (const peer of peers) {
                if (peer.id === socket.id) continue;
                if (peer.data.userId !== userId) continue;
                peer.emit("stream:session:superseded", { streamId });
                void peer.leave(roomKey(streamId));
                // Clear the peer's own presence-tracking for this stream so its
                // own eventual disconnect/leave doesn't double-decrement. Only
                // works for local sockets — remote sockets self-heal via HDEL
                // when their FE leave arrives.
                const peerIncremented = peer.data.streamIncremented as
                  | Set<string>
                  | undefined;
                peerIncremented?.delete(streamId);
              }
            } catch (err) {
              logger.warn(
                `/stream supersede kick error for ${streamId}: ${String(err)}`
              );
            }
          }

          // Per-socket refcount bump. If this same user is already watching
          // from another tab/device, HLEN stays the same and no viewer_count
          // shrink fires when THIS socket later leaves — only the last tab
          // for the user drops them from the count.
          let viewerCount = 0;
          if (streamIncremented.has(streamId)) {
            // stream:join re-emitted on the same socket (e.g. React
            // strict-mode double-mount). Don't double-count — just report
            // the current HLEN.
            try {
              viewerCount = await redisPub.hlen(sessionKey(streamId));
            } catch (err) {
              logger.warn(
                `/stream join hlen error for ${streamId}: ${String(err)}`
              );
            }
          } else {
            const count = await incrementPresence(streamId);
            if (count !== null) viewerCount = count;
          }

          // Durable viewer-session record (separate from the Redis presence set
          // above) — best-effort, never blocks or fails the join ack. Idempotent
          // server-side: a reconnect while still "open" reuses the same session.
          streamClient
            .recordViewerJoin({ streamId, userId })
            .catch((err: unknown) =>
              logger.warn(
                `/stream recordViewerJoin failed for ${streamId}: ${String(err)}`
              )
            );

          // Backfill recent comments (best-effort; a stream-service blip must
          // not block the join).
          let recentComments: unknown[] = [];
          let nextCursor = "";
          let hasMore = false;
          try {
            const res = await streamClient.getComments({
              livestreamId: streamId,
              limit: RECENT_COMMENTS_LIMIT,
              before: "",
              requesterId: userId,
            });
            // gRPC returns newest-first; reverse to oldest-first so the backfill
            // reads chronologically and live `stream:comment:new` events append
            // naturally after it (one consistent, append-only timeline).
            const rawComments = [...res.comments].reverse();

            // Presign unique avatar keys so clients receive ready-to-use URLs.
            // Deduplicate by key to avoid N calls for N comments by the same user.
            // On presign failure keep the raw key so resolveStreamCommentAvatar()
            // on the client can fall back to the CDN URL instead of a blank avatar.
            const avatarKeyMap = new Map<string, string>();
            for (const c of rawComments) {
              if (c.senderAvatar && !avatarKeyMap.has(c.senderAvatar)) {
                const url = await presignAvatar(
                  mediaClient,
                  c.senderAvatar,
                  c.sentBy
                );
                avatarKeyMap.set(c.senderAvatar, url ?? c.senderAvatar);
              }
            }
            recentComments = rawComments.map((c) => ({
              ...c,
              senderAvatar: c.senderAvatar
                ? (avatarKeyMap.get(c.senderAvatar) ?? c.senderAvatar)
                : "",
            }));

            nextCursor = res.nextCursor ?? "";
            hasMore = res.hasMore ?? false;
          } catch (err) {
            logger.warn(
              `/stream join getComments error for ${streamId}: ${String(err)}`
            );
          }

          ackOk(callback, "SOCKET_STREAM_JOINED", locale, {
            viewerCount: Math.max(0, viewerCount),
            recentComments,
            nextCursor,
            hasMore,
            canComment,
            // Snapshot of stream state at join time — used by FE for reconnect
            // recovery (no need to re-fetch stream detail via REST after a blip).
            streamSnapshot: {
              status: access.streamStatus,
              chatEnabled: canComment,
              title: access.title,
              description: access.description,
              thumbnail: access.thumbnail || null,
              creatorId: access.creatorId,
              hlsUrl: access.hlsUrl || null,
              hlsQualities: access.hlsQualities,
              flvUrl: access.flvUrl || null,
              flvQualities: access.flvQualities,
              videoLostSince: access.videoLostSince || null,
            },
          });
          emitViewerCount(streamId);
        })();
      }
    );

    socket.on(
      "stream:leave",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = StreamLeaveSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        const { streamId } = r.data;
        void (async () => {
          // Only decrement if THIS socket personally contributed a refcount
          // (streamIncremented is our per-socket source of truth). A double
          // leave, a leave-after-ban, or a leave without a prior join is a
          // no-op — decrementPresence checks the tracking set first.
          const hadIncrement = streamIncremented.has(streamId);
          void socket.leave(roomKey(streamId));
          streamCommentPermissions.delete(streamId);
          if (hadIncrement) {
            await decrementPresence(streamId);
            emitViewerCount(streamId);
            // Close the durable viewer session to match the presence
            // decrement — best-effort, never blocks the leave ack.
            streamClient
              .recordViewerLeave({ streamId, userId })
              .catch((err: unknown) =>
                logger.warn(
                  `/stream recordViewerLeave failed for ${streamId}: ${String(err)}`
                )
              );
          }
          ackOk(callback, "SOCKET_STREAM_LEFT", locale);
        })();
      }
    );

    socket.on(
      "stream:comment",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = StreamCommentSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        const { streamId, message, clientCommentId } = r.data;
        // Fast pre-check using the join-time gate (membership + mute +
        // commentStatus). The authoritative check still runs server-side in
        // stream-service on every PostComment call — this only avoids a
        // pointless round trip for a user we already know is blocked.
        // Must also require room membership: `.get(streamId) === false` alone
        // passes (undefined !== false) for a socket that never called
        // stream:join at all, since it never got an entry in this map — same
        // shape as the stream:react/stream:comment:delete room checks below.
        if (
          !socket.rooms.has(roomKey(streamId)) ||
          streamCommentPermissions.get(streamId) === false
        ) {
          ackError(callback, "FORBIDDEN", locale);
          return;
        }
        void (async () => {
          if (await isCommentRateLimited(streamId)) {
            ackError(callback, "RATE_LIMITED", locale);
            return;
          }
          try {
            // NEVER trust a client userId — always use the authenticated one.
            const result = await streamClient.postComment({
              livestreamId: streamId,
              userId,
              message,
              clientCommentId: clientCommentId ?? "",
            });
            // The stream:comment:new broadcast arrives via the psubscribe path
            // (stream-service publishes it) — we do NOT emit it here. The ack
            // itself stays a thin confirmation (community/private chat pattern):
            // the full message shape only ever goes out on the :new broadcast.
            ackOk(callback, "SOCKET_STREAM_COMMENT_POSTED", locale, {
              commentId: result.comment.id,
              streamId,
              sentAt: result.comment.createdAt,
              clientCommentId: clientCommentId ?? "",
            });
          } catch (err: unknown) {
            const code = (err as { code?: number }).code;
            if (code === grpcStatus.PERMISSION_DENIED) {
              ackError(callback, "FORBIDDEN", locale);
            } else {
              logger.warn(`/stream stream:comment gRPC error: ${String(err)}`);
              ackError(callback, "SERVICE_ERROR", locale);
            }
          }
        })();
      }
    );

    // Cursor-paginated chat history / catch-up.
    // - `before`: history scroll — returns older comments oldest-first (prepend to top).
    // - `after`:  catch-up after reconnect — returns newer comments oldest-first (append to bottom).
    socket.on(
      "stream:load_more",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = StreamLoadMoreSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        const { streamId, before, after, limit } = r.data;
        void (async () => {
          try {
            const res = await streamClient.getComments({
              livestreamId: streamId,
              limit: limit ?? RECENT_COMMENTS_LIMIT,
              before: before ?? "",
              after: after ?? "",
              requesterId: userId,
            });
            // `before` (history): service returns newest-first → reverse to oldest-first for prepend.
            // `after`  (catch-up): service already returns oldest-first → no reverse needed.
            const isAfterQuery = !before && !!after;
            const rawComments = isAfterQuery
              ? res.comments
              : [...res.comments].reverse();

            // Presign unique avatar keys (same pattern as stream:join backfill).
            // On presign failure keep the raw key — CDN fallback on the client side.
            const avatarKeyMap = new Map<string, string>();
            for (const c of rawComments) {
              if (c.senderAvatar && !avatarKeyMap.has(c.senderAvatar)) {
                const url = await presignAvatar(
                  mediaClient,
                  c.senderAvatar,
                  c.sentBy
                );
                avatarKeyMap.set(c.senderAvatar, url ?? c.senderAvatar);
              }
            }
            const comments = rawComments.map((c) => ({
              ...c,
              senderAvatar: c.senderAvatar
                ? (avatarKeyMap.get(c.senderAvatar) ?? c.senderAvatar)
                : "",
            }));

            ackOk(callback, "SOCKET_STREAM_LOAD_MORE", locale, {
              comments,
              nextCursor: res.nextCursor,
              hasMore: res.hasMore,
            });
          } catch (err) {
            logger.warn(`/stream stream:load_more gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
          }
        })();
      }
    );

    // Ephemeral reactions: no persistence, no gRPC. Fire-and-forget with a tiny
    // ack so the client can confirm receipt without waiting on a round trip.
    socket.on(
      "stream:react",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = StreamReactSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        const { streamId, emoji } = r.data;
        // Same gate as comments: must be in the room and not blocked by the
        // join-time membership/mute/commentStatus check. Reactions never call
        // stream-service, so this cached flag is the only enforcement point.
        if (
          !socket.rooms.has(roomKey(streamId)) ||
          !streamCommentPermissions.get(streamId)
        ) {
          ackError(callback, "FORBIDDEN", locale);
          return;
        }
        streamNs.to(roomKey(streamId)).emit("stream:react:new", {
          streamId,
          userId,
          emoji,
        });
        ackOk(callback, "SOCKET_STREAM_REACTED", locale);
      }
    );

    socket.on(
      "stream:comment:delete",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = StreamCommentDeleteSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        const { streamId, commentId } = r.data;
        // Fast pre-check: socket must already be in this stream's room
        if (!socket.rooms.has(roomKey(streamId))) {
          ackError(callback, "FORBIDDEN", locale);
          return;
        }
        void (async () => {
          try {
            const result = await streamClient.deleteComment({
              commentId,
              requesterId: userId,
            });
            ackOk(callback, "SOCKET_STREAM_COMMENT_DELETED", locale, {
              commentId: result.commentId,
              streamId: result.livestreamId,
            });
          } catch (err: unknown) {
            const code = (err as { code?: number }).code;
            if (code === grpcStatus.NOT_FOUND) {
              ackError(callback, "NOT_FOUND", locale);
            } else if (code === grpcStatus.PERMISSION_DENIED) {
              ackError(callback, "FORBIDDEN", locale);
            } else {
              logger.warn(
                `/stream stream:comment:delete error: ${String(err)}`
              );
              ackError(callback, "SERVICE_ERROR", locale);
            }
          }
        })();
      }
    );

    // Keep-alive: client emits every ~30 s while the tab is visible. We refresh
    // TTLs on the presence + join-time hashes so a silent reconnect (network
    // blip that doesn't trigger a full socket reconnect) doesn't evict the
    // viewer before they leave. Only runs if this socket already contributed
    // to the refcount — prevents a rogue client from re-inflating the count
    // via a heartbeat it never earned via stream:join.
    socket.on("stream:heartbeat", (payload: unknown) => {
      const r = StreamHeartbeatSchema.safeParse(payload);
      if (!r.success) return;
      const { streamId } = r.data;
      if (!streamIncremented.has(streamId)) return;
      void redisPub
        .expire(sessionKey(streamId), VIEWER_KEY_TTL_SEC)
        .then(() =>
          // HSETNX: only stamps if the join time is missing (e.g. the
          // sessionJoinedKey TTL expired under a very long-running heartbeat);
          // never overwrites the real first-join time.
          redisPub.hsetnx(
            sessionJoinedKey(streamId),
            userId,
            String(Date.now())
          )
        )
        .then(() =>
          redisPub.expire(sessionJoinedKey(streamId), VIEWER_KEY_TTL_SEC)
        )
        .catch((err: unknown) => {
          logger.warn(
            `/stream heartbeat Redis error for ${streamId}: ${String(err)}`
          );
        });
    });

    // "disconnecting" fires before Socket.IO calls leaveAll(), so socket.rooms
    // is still populated here. "disconnect" fires after leaveAll() — rooms are
    // already empty by then, which is why dirty-disconnect cleanup was silently
    // skipped before this fix.
    socket.on("disconnecting", (reason: string) => {
      logger.debug(`/stream disconnecting userId=${userId} reason=${reason}`);

      // Decrement presence for every stream THIS socket personally
      // contributed to (not socket.rooms — a same-user sibling tab is
      // tracked by its own socket's streamIncremented, so we never
      // stomp on it here).
      const streamIds = [...streamIncremented];

      // NOTE: `viewerCountTimers` is namespace-scoped and deliberately NOT
      // cleared here. A pending timer belongs to a STREAM, not to this socket —
      // clearing it would cancel a broadcast the remaining viewers in that room
      // are still waiting on. The timer's own callback is the only thing that
      // removes its entry, and it reads live state from Redis at fire time, so
      // it stays correct after this socket is gone.
      streamCommentPermissions.clear();

      for (const streamId of streamIds) {
        void (async () => {
          await decrementPresence(streamId);
          // Close the durable viewer session — covers crashes/network drops
          // that never fire an explicit stream:leave. Best-effort.
          streamClient
            .recordViewerLeave({ streamId, userId })
            .catch((err: unknown) =>
              logger.warn(
                `/stream disconnect recordViewerLeave failed for ${streamId}: ${String(err)}`
              )
            );
          // Emit directly (the per-socket debounce map is already cleared and
          // the socket is leaving — read once and broadcast to the room).
          try {
            broadcastViewerCount(
              streamId,
              await redisPub.hlen(sessionKey(streamId))
            );
          } catch {
            /* best-effort fan-out on disconnect */
          }
        })();
      }
    });
  });
}
