import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { status as grpcStatus } from "@grpc/grpc-js";
import { logger } from "@aimess/logger";
import { gatewaySocketAuthMiddleware } from "../auth.middleware.js";
import { ackOk, ackError } from "../ack.js";
import type { StreamClient } from "../../grpc/clients/stream.client.js";

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

// ─── Redis pub/sub message shape published by stream-service ─────────────────
// stream-service publishes { event: "stream:comment:new"|"stream:status", data }
// to channel "stream:<streamId>"; we fan it out to the matching room verbatim.
interface RedisSocketEvent {
  event: string;
  data: unknown;
}

export function registerStreamNamespace(
  io: SocketIOServer,
  streamClient: StreamClient,
  redisSub: Redis,
  redisPub: Redis
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
      } catch (err) {
        logger.warn(
          `/stream ban session srem error for ${streamId}: ${String(err)}`
        );
      }
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
          try {
            const access = await streamClient.checkStreamAccess({
              streamId,
              userId,
            });
            if (!access.allowed) {
              ackError(callback, "FORBIDDEN", locale);
              return;
            }
            canComment = access.canComment;
          } catch (err) {
            logger.warn(
              `/stream join access check failed for ${streamId}: ${String(err)}`
            );
            ackError(callback, "FORBIDDEN", locale);
            return;
          }

          void socket.join(roomKey(streamId));

          // SADD is idempotent per userId — a rejoining user (whose old socket's
          // leave hasn't fired yet) won't inflate the count. SCARD then gives the
          // exact number of unique watchers regardless of join/leave race order.
          let viewerCount = 0;
          try {
            await redisPub.sadd(sessionKey(streamId), userId);
            await redisPub.expire(sessionKey(streamId), VIEWER_KEY_TTL_SEC);
            viewerCount = await redisPub.scard(sessionKey(streamId));
          } catch (err) {
            logger.warn(
              `/stream join session error for ${streamId}: ${String(err)}`
            );
          }

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
            recentComments = [...res.comments].reverse();
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
          if (wasInRoom) {
            try {
              await redisPub.srem(sessionKey(streamId), userId);
            } catch (err) {
              logger.warn(
                `/stream leave session srem error for ${streamId}: ${String(err)}`
              );
            }
            emitViewerCount(streamId);
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
            logger.warn(`/stream stream:comment gRPC error: ${String(err)}`);
            ackError(callback, "SERVICE_ERROR", locale);
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
            ackOk(callback, "SOCKET_STREAM_LOAD_MORE", locale, {
              comments: isAfterQuery
                ? res.comments
                : [...res.comments].reverse(),
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

      for (const streamId of streamRooms) {
        void (async () => {
          try {
            await redisPub.srem(sessionKey(streamId), userId);
          } catch (err) {
            logger.warn(
              `/stream disconnect session srem error for ${streamId}: ${String(err)}`
            );
          }
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
