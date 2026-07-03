import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { status as grpcStatus } from "@grpc/grpc-js";
import { logger } from "@aimess/logger";
import { gatewaySocketAuthMiddleware } from "../auth.middleware.js";
import { ackOk, ackError } from "../ack.js";
import type { StreamClient } from "../../grpc/clients/stream.client.js";
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
const COMMENT_RATE_MAX = 2; // comments allowed…
const COMMENT_RATE_WINDOW_SEC = 3; // …per this window

// Debounce viewer_count broadcasts to ≤ 1 emit/sec per stream so a join/leave
// storm cannot fan a flood of identical counts out to a whole room.
const VIEWER_COUNT_DEBOUNCE_MS = 1000;

const roomKey = (streamId: string): string => `stream:${streamId}`;
// Session set: tracks unique watching userIds. SADD/SREM are idempotent per-user
// so SCARD is always the accurate live viewer count — no separate INCR counter needed.
const sessionKey = (streamId: string): string =>
  `stream:session:users:${streamId}`;
// Join-time hash: userId -> epoch ms of first join. HSETNX so a heartbeat/
// rejoin refresh never overwrites the original join time. Read by
// stream-service's getViewers() alongside the session set above.
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

/** Presign a USER_AVATAR object key to a download URL; returns null on any error. */
async function presignAvatar(
  mediaClient: MediaClient,
  objectKey: string,
  requesterId: string
): Promise<string | null> {
  if (!objectKey) return null;
  try {
    const res = await mediaClient.generateDownloadUrl({
      objectKey,
      category: "USER_AVATAR",
      requesterId,
    });
    return res?.downloadUrl ?? null;
  } catch {
    return null;
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
  const sentBy = typeof comment.sentBy === "string" ? comment.sentBy : "";
  if (!key) return comment;
  const url = await presignAvatar(mediaClient, key, sentBy);
  return { ...comment, senderAvatar: url ?? "" };
}

export function registerStreamNamespace(
  io: SocketIOServer,
  streamClient: StreamClient,
  redisSub: Redis,
  redisPub: Redis,
  mediaClient: MediaClient
): void {
  const streamNs: Namespace = io.of("/stream");
  streamNs.use(gatewaySocketAuthMiddleware);

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
      }
      // Remove banned user from the session set so getViewers reflects the kick.
      try {
        await redisPub.srem(sessionKey(streamId), bannedUserId);
        await redisPub.hdel(sessionJoinedKey(streamId), bannedUserId);
      } catch (err) {
        logger.warn(
          `/stream ban session srem error for ${streamId}: ${String(err)}`
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
      // Broadcast the corrected viewer count (SCARD is always accurate).
      try {
        const viewerCount = Math.max(
          0,
          await redisPub.scard(sessionKey(streamId))
        );
        streamNs
          .to(room)
          .emit("stream:viewer_count", { streamId, viewerCount });
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
    try {
      const sockets = await streamNs.in(room).fetchSockets();
      for (const s of sockets) {
        if (s.data.userId !== targetUserId) continue;
        s.emit(event, data);
      }
    } catch (err) {
      logger.warn(`/stream ${event} notify error for ${room}: ${String(err)}`);
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
        // Presign the senderAvatar object key before emitting live comments so
        // clients receive a ready-to-use image URL, not a raw S3 key.
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

  streamNs.on("connection", (socket: Socket) => {
    const { userId, locale } = socket.data;
    logger.debug(`/stream connected userId=${userId}`);

    // Per-socket debounce timers for viewer_count, keyed by streamId. A pending
    // timer means "an emit is already scheduled within the window" — we coalesce.
    const viewerCountTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // Per-socket cache of the join-time `canComment` gate (membership + mute +
    // commentStatus), keyed by streamId. Reactions never round-trip to
    // stream-service, so this cache is what blocks a muted user from reacting;
    // comments are additionally enforced server-side at the gRPC write path.
    const streamCommentPermissions = new Map<string, boolean>();

    // Read the live viewer count and broadcast it to the room, debounced to
    // ≤ 1 emit/sec per stream. The emit goes via the redis-adapter so every
    // gateway instance's sockets in the room receive it.
    const emitViewerCount = (streamId: string): void => {
      if (viewerCountTimers.has(streamId)) return;
      const timer = setTimeout(() => {
        viewerCountTimers.delete(streamId);
        redisPub
          .scard(sessionKey(streamId))
          .then((count) => {
            const viewerCount = Math.max(0, count);
            streamNs
              .to(roomKey(streamId))
              .emit("stream:viewer_count", { streamId, viewerCount });
          })
          .catch((err: unknown) => {
            logger.warn(
              `/stream viewer_count read error for ${streamId}: ${String(err)}`
            );
          });
      }, VIEWER_COUNT_DEBOUNCE_MS);
      viewerCountTimers.set(streamId, timer);
    };

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

          // SADD is idempotent per userId — a rejoining user (whose old socket's
          // leave hasn't fired yet) won't inflate the count. SCARD then gives the
          // exact number of unique watchers regardless of join/leave race order.
          let viewerCount = 0;
          try {
            await redisPub.sadd(sessionKey(streamId), userId);
            await redisPub.expire(sessionKey(streamId), VIEWER_KEY_TTL_SEC);
            // HSETNX: only stamps the join time on the *first* join — a
            // rejoin (reconnect) must not reset how long this viewer has
            // actually been watching.
            await redisPub.hsetnx(
              sessionJoinedKey(streamId),
              userId,
              String(Date.now())
            );
            await redisPub.expire(
              sessionJoinedKey(streamId),
              VIEWER_KEY_TTL_SEC
            );
            viewerCount = await redisPub.scard(sessionKey(streamId));
          } catch (err) {
            logger.warn(
              `/stream join session error for ${streamId}: ${String(err)}`
            );
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
            });
            // gRPC returns newest-first; reverse to oldest-first so the backfill
            // reads chronologically and live `stream:comment:new` events append
            // naturally after it (one consistent, append-only timeline).
            const rawComments = [...res.comments].reverse();

            // Presign unique avatar keys so clients receive ready-to-use URLs.
            // Deduplicate by key to avoid N calls for N comments by the same user.
            const avatarKeyMap = new Map<string, string>();
            for (const c of rawComments) {
              if (c.senderAvatar && !avatarKeyMap.has(c.senderAvatar)) {
                const url = await presignAvatar(
                  mediaClient,
                  c.senderAvatar,
                  c.sentBy
                );
                avatarKeyMap.set(c.senderAvatar, url ?? "");
              }
            }
            recentComments = rawComments.map((c) => ({
              ...c,
              senderAvatar: c.senderAvatar
                ? (avatarKeyMap.get(c.senderAvatar) ?? "")
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
              flvUrl: access.flvUrl || null,
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
          // Only SREM if this socket was actually in the room. If the user was
          // banned, kickBannedUser already SREM'd them; a subsequent stream:leave
          // from the unmounting Chat component is a no-op (SREM is idempotent).
          const wasInRoom = socket.rooms.has(roomKey(streamId));
          void socket.leave(roomKey(streamId));
          streamCommentPermissions.delete(streamId);
          if (wasInRoom) {
            try {
              await redisPub.srem(sessionKey(streamId), userId);
              await redisPub.hdel(sessionJoinedKey(streamId), userId);
            } catch (err) {
              logger.warn(
                `/stream leave session srem error for ${streamId}: ${String(err)}`
              );
            }
            emitViewerCount(streamId);
            // Close the durable viewer session to match the Redis presence
            // removal above — best-effort, never blocks the leave ack.
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
        if (streamCommentPermissions.get(streamId) === false) {
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
            // (stream-service publishes it) — we do NOT emit it here.
            ackOk(callback, "SOCKET_STREAM_COMMENT_POSTED", locale, result);
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
            });
            // `before` (history): service returns newest-first → reverse to oldest-first for prepend.
            // `after`  (catch-up): service already returns oldest-first → no reverse needed.
            const isAfterQuery = !before && !!after;
            const rawComments = isAfterQuery
              ? res.comments
              : [...res.comments].reverse();

            // Presign unique avatar keys (same pattern as stream:join backfill).
            const avatarKeyMap = new Map<string, string>();
            for (const c of rawComments) {
              if (c.senderAvatar && !avatarKeyMap.has(c.senderAvatar)) {
                const url = await presignAvatar(
                  mediaClient,
                  c.senderAvatar,
                  c.sentBy
                );
                avatarKeyMap.set(c.senderAvatar, url ?? "");
              }
            }
            const comments = rawComments.map((c) => ({
              ...c,
              senderAvatar: c.senderAvatar
                ? (avatarKeyMap.get(c.senderAvatar) ?? "")
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
    // the Redis session-set TTL so a silent reconnect (network blip that doesn't
    // trigger a full socket reconnect) doesn't evict the viewer before they leave.
    // Only refreshes if the socket is actually in the room — prevents phantom
    // heartbeats from a mis-wired client re-emitting stale streamIds.
    socket.on("stream:heartbeat", (payload: unknown) => {
      const r = StreamHeartbeatSchema.safeParse(payload);
      if (!r.success) return;
      const { streamId } = r.data;
      if (!socket.rooms.has(roomKey(streamId))) return;
      void redisPub
        .sadd(sessionKey(streamId), userId)
        .then(() => redisPub.expire(sessionKey(streamId), VIEWER_KEY_TTL_SEC))
        .then(() =>
          // HSETNX again: a no-op if this viewer already has a join time
          // (the common case) — just keeps the hash's own TTL from expiring
          // out from under a long-running heartbeat.
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

    socket.on("disconnect", (reason: string) => {
      logger.debug(`/stream disconnected userId=${userId} reason=${reason}`);

      // Decrement the viewer counter for every stream room this socket was in
      // and broadcast the updated count so the room never shows a phantom viewer.
      const streamRooms: string[] = [];
      for (const room of socket.rooms) {
        if (room.startsWith("stream:") && !room.startsWith("stream:viewers:")) {
          streamRooms.push(room.slice("stream:".length));
        }
      }

      // Flush any pending debounce timers — the socket is gone, so a deferred
      // emit would only leak a timer.
      for (const timer of viewerCountTimers.values()) {
        clearTimeout(timer);
      }
      viewerCountTimers.clear();
      streamCommentPermissions.clear();

      for (const streamId of streamRooms) {
        void (async () => {
          try {
            await redisPub.srem(sessionKey(streamId), userId);
            await redisPub.hdel(sessionJoinedKey(streamId), userId);
          } catch (err) {
            logger.warn(
              `/stream disconnect session srem error for ${streamId}: ${String(err)}`
            );
          }
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
            const viewerCount = Math.max(
              0,
              await redisPub.scard(sessionKey(streamId))
            );
            streamNs
              .to(roomKey(streamId))
              .emit("stream:viewer_count", { streamId, viewerCount });
          } catch {
            /* best-effort fan-out on disconnect */
          }
        })();
      }
    });
  });
}
