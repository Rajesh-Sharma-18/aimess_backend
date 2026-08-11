import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { logger } from "@aimess/logger";
import { createGatewaySocketAuthMiddleware } from "../auth.middleware.js";
import { ackOk, ackError, resolveGrpcAckError } from "../ack.js";
import type { CommunityClient } from "../../grpc/clients/community.client.js";
import type { UserClient } from "../../grpc/clients/user.client.js";
import type { MediaClient } from "../../grpc/clients/media.client.js";
import {
  resolveSocketUserDetails,
  buildTypingBroadcast,
} from "../user-details.js";
import {
  createPresenceIndicator,
  createDirectRosterBroadcast,
  createRoomBroadcast,
} from "../presence-indicator.js";
import { env } from "../../config/env.js";
import { createSessionTimers } from "../session-timers.js";
import { personalizeCommunitySocketMessage } from "../system-message-personalize.js";
import {
  emitPersonalizedSender,
  type PersonalizeFn,
} from "../emit-personalized.js";
import { scopeSocketLocale } from "../locale-scope.js";
import { typingViewerFilter, viewerHidesReadReceipts } from "../chat-flags.js";

// §3: bound free-text fields so a naive/abusive client cannot exceed the 1 MB
// socket frame or fan an oversized payload out to a whole community room.
const MAX_TEXT_LEN = 4000; // message body / caption (matches chat-service CHAT_TEXT_MAX_CHARS)
const MAX_FILES = 30; // attachments per message (gallery)
const MAX_EMOJI_LEN = 32; // one emoji grapheme incl. ZWJ/skin-tone sequences

const CommunityJoinSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
});
const CommunityLeaveSchema = z.object({ communityId: z.string().min(1) });
const CommunityTypingSchema = z.object({
  communityId: z.string().min(1),
  // roomId is accepted for forward-compat/contract symmetry but is intentionally
  // NOT used for fan-out: typing is community-scoped and broadcasts to the whole
  // `community:<communityId>` room (the only room clients join). senderName is a
  // legacy display fallback only — never an identity source (userId is server-side).
  roomId: z.string().min(1).optional(),
  senderName: z.string().max(100).optional(),
});
const CommunityMsgSendFileSchema = z.object({
  url: z.string().url().optional(),
  objectKey: z.string().min(1).max(500).optional(),
  name: z.string().default(""),
  size: z.number().nonnegative().default(0),
  mime: z.string().default(""),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  durationMs: z.number().nonnegative().optional(),
  blurhash: z.string().max(120).optional(),
  waveform: z.array(z.number()).max(2048).optional(),
});

const CommunityMsgSendSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  clientMessageId: z.string().optional(),
  message: z.string().max(MAX_TEXT_LEN).default(""),
  // Cross-namespace parity alias: `contentText` is accepted as an alias for `message`.
  contentText: z.string().max(MAX_TEXT_LEN).optional(),
  contentType: z
    .string()
    .min(1)
    .transform((v) => v.toUpperCase()),
  media: z
    .object({ files: z.array(CommunityMsgSendFileSchema).max(MAX_FILES) })
    .optional(),
  // Cross-namespace parity alias: top-level `files[]` is accepted as alias for `media.files[]`.
  files: z.array(CommunityMsgSendFileSchema).max(MAX_FILES).optional(),
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      placeName: z.string().max(200).optional(),
      placeAddress: z.string().max(500).optional(),
    })
    .optional(),
  contact: z
    .object({
      name: z.string().min(1).max(200),
      phone: z.string().min(1).max(50),
      avatar: z.string().max(3000).optional(),
      userId: z.string().max(100).optional(),
    })
    .optional(),
  sticker: z
    .object({
      objectKey: z.string().min(1).max(500).optional(),
      url: z.string().url().optional(),
      packId: z.string().max(100),
      stickerId: z.string().max(100),
    })
    .optional(),
  parentMessageId: z.string().optional(),
  // Cross-namespace parity alias: /chat names the reply target `repliedToId`.
  repliedToId: z.string().optional(),
});
const CommunityMsgsFetchSchema = z.object({
  roomId: z.string().min(1),
  // Gap #8: cursor must be a valid ISO 8601 date-time string AND must not be in
  // the future — a future cursor would return 0 results and is almost certainly
  // a client bug or a replay attack.
  // 5 s future grace absorbs sender-clock skew (last-message timestamps from a
  // device whose clock is slightly ahead should still be accepted as cursors).
  cursor: z
    .string()
    .datetime({ offset: true })
    .refine((d) => new Date(d) <= new Date(Date.now() + 5_000), {
      message: "cursor must not be in the future",
    })
    .optional(),
  limit: z.number().int().positive().max(100).default(30),
});
const CommunityMsgReactSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  emoji: z.string().min(1).max(MAX_EMOJI_LEN),
});
const CommunityCatchupRoomSchema = z.object({
  roomId: z.string().min(1),
  sinceId: z.string().optional(),
  // P2 §13: max 100 events per room per catchup request.
  limit: z.number().int().positive().max(100).optional(),
  /**
   * Epoch-ms (positive integer). When provided the server switches to an
   * updatedAt-based query that surfaces edits, reaction changes, and
   * tombstones — ideal for returning from the background.
   * Mutually exclusive with sinceId; sinceTs takes precedence when both given.
   */
  sinceTs: z.number().int().positive().optional(),
  /**
   * ZERO-LOSS revision cursor (highest precedence). The client's per-room CHANGE
   * high-water. When provided (including 0 for a cold start) the server returns
   * every message whose revision > sinceRevision — inserts AND mutations
   * (edits/reactions/deletes) — plus roomRevision/lastRevision/resetRequired.
   * Preferred over sinceId/sinceTs for reconnect. See the REST /changes feed.
   */
  sinceRevision: z.number().int().min(0).optional(),
});
// P2 §13: max 10 rooms per catchup request to prevent oversized payloads.
// Users in many communities must batch requests; the ack includes hasMore + cursors.
const CommunityCatchupSchema = z.object({
  rooms: z.array(CommunityCatchupRoomSchema).min(1).max(10),
});

const CommunityMsgEditSchema = z
  .object({
    messageId: z.string().min(1),
    communityId: z.string().min(1),
    roomId: z.string().min(1).optional(),
    content: z.object({ text: z.string().min(1).max(MAX_TEXT_LEN) }).optional(),
    // Cross-namespace parity alias: /chat's message:edit sends a flat
    // `contentText`. Exactly one of content.text / contentText is required.
    contentText: z.string().min(1).max(MAX_TEXT_LEN).optional(),
  })
  .refine((v) => v.content !== undefined || v.contentText !== undefined, {
    message: "content.text or contentText is required",
    path: ["content"],
  });

const CommunityMsgDeleteSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  type: z.enum(["forEveryone", "forMe"]),
});

const CommunityMsgPinSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
});

const CommunityMsgUnpinSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
});

// ── Moderation schemas ───────────────────────────────────────────────────────
const KickMemberSchema = z.object({
  communityId: z.string().min(1),
  targetUserId: z.string().min(1),
  reason: z.string().max(500).optional(),
});
const BanMemberSchema = z.object({
  communityId: z.string().min(1),
  targetUserId: z.string().min(1),
  reason: z.string().max(500).optional(),
});
const UnbanMemberSchema = z.object({
  communityId: z.string().min(1),
  targetUserId: z.string().min(1),
});
const TransferAdminSchema = z.object({
  communityId: z.string().min(1),
  newAdminId: z.string().min(1),
});
const ChangeMemberRoleSchema = z.object({
  communityId: z.string().min(1),
  targetUserId: z.string().min(1),
  newRole: z.enum(["MODERATOR", "MEMBER"]),
});
const CreateReportSchema = z.object({
  communityId: z.string().min(1),
  reason: z.string().min(1).max(1000),
  targetMessageId: z.string().optional(),
});
const DeleteCommunitySchema = z.object({
  communityId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

// ── New parity schemas ────────────────────────────────────────────────────────
const CommunityMsgReadSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  upToMessageId: z.string().min(1),
});
const CommunityMsgReactionsGetSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
});
const CommunityMsgForwardSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  targetCommunityId: z.string().min(1),
  targetRoomId: z.string().min(1).optional(),
  clientMessageId: z.string().min(1),
});
const CommunityMsgDeliveredSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  upToMessageId: z.string().min(1),
});
interface RedisSocketEvent {
  event: string;
  data: unknown;
}

export function registerCommunityNamespace(
  io: SocketIOServer,
  communityClient: CommunityClient,
  redisSub: Redis,
  redisPub: Redis,
  userClient: UserClient,
  mediaClient: MediaClient
): void {
  const community: Namespace = io.of("/community");
  community.use(createGatewaySocketAuthMiddleware(redisPub));

  // Process-local, best-effort cache of communities currently CLOSED/SUSPENDED.
  // Populated reactively from the community:closed/community:reopened Redis
  // relay below (so every gateway instance stays in sync in real time) and
  // self-healed from the checkCommunityMembership response on community:join.
  // Deliberately NOT a per-keystroke gRPC lookup — typing/recording indicators
  // check this Set (O(1), zero network cost) before broadcasting. The
  // authoritative, persisted-effect gate for community writes remains
  // assertCommunityRoomWritable in chat-service; this is defense-in-depth only.
  const closedCommunityIds = new Set<string>();

  // Dedicated subscriber for community channels.
  // Backend services publish: { event: "community:message:new"|"community:member:joined", data: {...} }
  // to Redis channel community:<communityId>.
  // Also subscribe to user:* so community:read_sync events reach the reader's own devices.
  void redisSub.psubscribe("community:*");
  void redisSub.psubscribe("user:*");
  redisSub.on(
    "pmessage",
    (pattern: string, channel: string, message: string) => {
      // user:* relay: only forward community-scoped events to avoid cross-firing
      // chat-service events (e.g. message:new for private rooms) onto /community.
      if (pattern === "user:*") {
        try {
          const parsed = JSON.parse(message) as RedisSocketEvent;
          if ((parsed.event as string).startsWith("community:")) {
            const viewerUserId = channel.slice("user:".length);
            // ── Stream live indicator debug log ─────────────────────────────
            if (
              parsed.event === "community:stream:started" ||
              parsed.event === "community:stream:ended" ||
              parsed.event === "community:stream:updated"
            ) {
              const d = parsed.data as {
                communityId?: string;
                streamId?: string;
              };
              logger.info(
                `🔴 [STREAM:GATEWAY:USER] user:* relay event=${parsed.event} userId=${viewerUserId} communityId=${d.communityId ?? "?"} → emitting to Socket.IO room="user:${viewerUserId}"`
              );
            }
            // Per-socket delivery (not a bare room emit) so the recipient's own
            // locale drives both the SYSTEM-line translation and the "You"
            // sender swap — see emitPersonalizedSender. `community:updated`
            // needs no special case: its senderId/senderName pair is handled
            // generically there.
            void emitPersonalizedSender(
              community,
              channel,
              parsed.event,
              parsed.data,
              parsed.event === "community:message:new"
                ? personalizeCommunitySocketMessage
                : undefined
            );

            // Auto-join the typing room when the user is added to a new community
            // while their socket is connected, so they immediately receive
            // typing:start / typing:stop for that community without a reconnect.
            if (parsed.event === "community:added") {
              const addedData = parsed.data as
                | { communityId?: string }
                | null
                | undefined;
              const newCommunityId = addedData?.communityId;
              if (newCommunityId) {
                void (async () => {
                  try {
                    const sockets = await community
                      .in(`user:${viewerUserId}`)
                      .fetchSockets();
                    await Promise.all(
                      sockets.map((s) =>
                        s.join(`community-typing:${newCommunityId}`)
                      )
                    );
                    logger.debug(
                      `/community auto-joined community-typing:${newCommunityId} for ${sockets.length} socket(s) of userId=${viewerUserId}`
                    );
                  } catch (joinErr) {
                    logger.warn(
                      `/community auto-join typing room on community:added failed userId=${viewerUserId} communityId=${newCommunityId}: ${String(joinErr)}`
                    );
                  }
                })();
              }
            }
          }
        } catch (err) {
          logger.warn(
            `/community Redis user:* parse error on ${channel}: ${String(err)}`
          );
        }
        return;
      }
      if (pattern !== "community:*") return;
      try {
        const parsed = JSON.parse(message) as RedisSocketEvent;
        // Keep the local closed-community cache in sync in real time.
        if (parsed.event === "community:closed") {
          closedCommunityIds.add(channel.slice("community:".length));
        } else if (parsed.event === "community:reopened") {
          closedCommunityIds.delete(channel.slice("community:".length));
        }
        // ── Stream live indicator debug logs ─────────────────────────────────
        if (
          parsed.event === "community:stream:started" ||
          parsed.event === "community:stream:ended" ||
          parsed.event === "community:stream:updated"
        ) {
          const d = parsed.data as { communityId?: string; streamId?: string };
          logger.info(
            `🔴 [STREAM:GATEWAY] Redis pmessage received event=${parsed.event} channel=${channel} communityId=${d.communityId ?? "?"} streamId=${d.streamId ?? "?"}`
          );
          logger.info(
            `🔴 [STREAM:GATEWAY] emitting ${parsed.event} to Socket.IO room="${channel}" (sockets in room must have called community:join)`
          );
        }

        let personalizeFn: PersonalizeFn | undefined;
        if (parsed.event === "community:message:new") {
          personalizeFn = personalizeCommunitySocketMessage;
        }

        const TYPING_ROOM_BROADCAST_EVENTS = new Set([
          "community:member:joined",
          "community:member:updated",
          "community:member:removed",
          "community:member:muted",
          "community:member:unmuted",
          "community:stream:started",
          "community:stream:ended",
          "community:stream:updated",
        ]);

        // `community:member:removed` is special-cased below (excludes the
        // removed/banned user's OWN sockets from the broadcast — see the block
        // after this one) instead of going through the generic room broadcast,
        // so its handling is deliberately skipped here.
        // Reciprocity for Settings → Chat → Read Receipt, recipient half.
        // chat-service already withholds the receipt of a READER who switched
        // it off; this drops it for a VIEWER who did. It cannot happen at
        // publish time — one `community:message:read` reaches every member of
        // the room, each with their own setting. Mirrors chat.ns.ts.
        const skipViewer =
          parsed.event === "community:message:read"
            ? (viewerUserId: string) =>
                viewerHidesReadReceipts(userClient, viewerUserId)
            : undefined;

        if (parsed.event !== "community:member:removed") {
          void emitPersonalizedSender(
            community,
            channel,
            parsed.event,
            parsed.data,
            personalizeFn,
            undefined,
            skipViewer
          );

          if (TYPING_ROOM_BROADCAST_EVENTS.has(parsed.event)) {
            const typingRoom = `community-typing:${channel.slice("community:".length)}`;
            void emitPersonalizedSender(
              community,
              typingRoom,
              parsed.event,
              parsed.data,
              personalizeFn
            );
          }
        }

        // Evict-on-removal: when a member is removed (banned/kicked/left), force
        // their live sockets out of the broadcast room in real time so a BANNED
        // user stops receiving community events immediately — defense-in-depth
        // alongside the community:join ban gate (which stops them on reconnect).
        // Also broadcast a typing:stop for the removed user so stale indicators
        // are cleared from all peers' UIs.
        //
        // The `community:member:removed` room broadcast itself is sent here
        // (not via the generic path above) EXCLUDING the removed/banned user's
        // own socket(s) — every other member gets it for their roster update,
        // but the target must never see a "you were removed" room event on
        // their own connection. This matters even for a ban, where the target
        // is deliberately NOT actually removed from the community (restricted-
        // access model — see `community:membership:restricted` on the personal
        // channel): without this exclusion, a still-connected banned socket
        // would receive this room-wide event carrying their own userId, which
        // a client's generic "member removed" handler can easily (and
        // incorrectly) treat as self-removal and evict the community from its
        // local list — the exact bug this closes.
        if (parsed.event === "community:member:removed") {
          const removedData = parsed.data as {
            userId?: string;
            communityId?: string;
          } | null;
          const removedUserId = removedData?.userId;
          const removedCommunityId =
            removedData?.communityId ?? channel.slice("community:".length);
          const typingRoom = `community-typing:${removedCommunityId}`;
          void (async () => {
            try {
              const [roomSockets, typingSockets] = await Promise.all([
                community.in(channel).fetchSockets(),
                community.in(typingRoom).fetchSockets(),
              ]);
              const isTarget = (s: { data: { userId?: string } }) =>
                removedUserId != null && s.data.userId === removedUserId;

              // Broadcast to everyone in each room EXCEPT the removed user's
              // own sockets (defense-in-depth: even if removedUserId is
              // somehow absent, this degrades to a normal full-room broadcast).
              for (const s of roomSockets) {
                if (!isTarget(s)) s.emit(parsed.event, parsed.data);
              }
              if (TYPING_ROOM_BROADCAST_EVENTS.has(parsed.event)) {
                for (const s of typingSockets) {
                  if (!isTarget(s)) s.emit(parsed.event, parsed.data);
                }
              }

              if (!removedUserId) return;
              for (const s of roomSockets) {
                if (!isTarget(s)) continue;
                void s.leave(channel);
                // Also leave the lightweight typing room.
                void s.leave(typingRoom);
                // Broadcast stop so peers clear any stale typing indicator.
                community
                  .to(`community:${removedCommunityId}`)
                  .to(typingRoom)
                  .emit(
                    "typing:stop",
                    buildTypingBroadcast(
                      removedUserId,
                      s.data.userDetails ?? {
                        userId: removedUserId,
                        username: "",
                        displayName: "",
                        avatarUrl: null,
                      },
                      removedCommunityId,
                      Date.now(),
                      { communityId: removedCommunityId }
                    )
                  );
              }
            } catch (evictErr) {
              logger.warn(
                `/community evict-on-removed failed channel=${channel} user=${removedUserId}: ${String(evictErr)}`
              );
            }
          })();
        }
      } catch (err) {
        logger.warn(
          `/community Redis message parse error on ${channel}: ${String(err)}`
        );
      }
    }
  );

  community.on("connection", (socket: Socket) => {
    const { userId, sessionId, locale } = socket.data;
    scopeSocketLocale(socket);
    void socket.join(`user:${userId}`);
    void socket.join(`session:${sessionId}`);
    logger.debug(`/community connected userId=${userId}`);

    // Resolve sender identity ONCE per connection (gRPC snapshot + avatar
    // presign) so typing broadcasts carry userDetails without a per-event fetch.
    // Fire-and-forget: a safe default is set immediately and overwritten when
    // the resolved value is ready, keeping connect latency zero.
    socket.data.userDetails = {
      userId,
      username: "",
      displayName: "",
      avatarUrl: null,
    };
    void resolveSocketUserDetails(userClient, mediaClient, userId).then(
      (ud) => {
        socket.data.userDetails = ud;
      }
    );

    // ── Auto-join all typing rooms on connect ───────────────────────────────
    // Join community-typing:<id> for every community the user is an ACTIVE
    // member of. These lightweight rooms receive only typing:start / typing:stop,
    // so members see sidebar typing indicators for ALL their communities without
    // opening each one. De-coupled from community:<id> so closing a chat (which
    // leaves community:<id> on community:leave) does not break sidebar typing.
    // Fail-open: a gRPC failure here only means the socket misses the auto-join
    // for this connection; the client can still emit community:join manually.
    //
    // The promise itself (not just the fire-and-forget side effect) is kept
    // around: `isAuthorizedForCommunity` awaits it so the very first
    // typing:start/stop right after connect — which would otherwise race this
    // gRPC round trip and be silently dropped — waits on this SAME in-flight
    // call instead of requiring the client to send an explicit community:join
    // first. Once resolved, every later check is a synchronous room lookup.
    const typingRoomsReady: Promise<void> = (async () => {
      try {
        const { communityIds } =
          await communityClient.getUserActiveCommunityIds({ userId });
        if (communityIds.length === 0) return;

        // allSettled (not all): one bad room id must not stop the rest from
        // joining, and we need the per-room outcome to log which ids failed.
        const results = await Promise.allSettled(
          communityIds.map((id) => socket.join(`community-typing:${id}`))
        );
        const failedCommunityIds = communityIds.filter(
          (_id, i) => results[i]!.status === "rejected"
        );
        const joinedCount = communityIds.length - failedCommunityIds.length;

        logger.info(
          `/community auto-join on connect socketId=${socket.id} userId=${userId} joinedRoomCount=${joinedCount}` +
            (failedCommunityIds.length > 0
              ? ` failedRoomIds=${JSON.stringify(failedCommunityIds)}`
              : "")
        );
        if (failedCommunityIds.length > 0) {
          for (let i = 0; i < communityIds.length; i++) {
            const result = results[i]!;
            if (result.status === "rejected") {
              logger.warn(
                `/community auto-join typing room failed socketId=${socket.id} userId=${userId} communityId=${communityIds[i]}: ${String(result.reason)}`
              );
            }
          }
        }
      } catch (err) {
        // gRPC lookup itself failed — fail-open: the socket misses this
        // connection's auto-join entirely, but the client can still fall back
        // to an explicit community:join and the NEXT reconnect retries the
        // lookup from scratch.
        logger.warn(
          `/community auto-join typing rooms failed (fail-open) socketId=${socket.id} userId=${userId}: ${String(err)}`
        );
      }
    })();

    // ── Typing indicator ────────────────────────────────────────────────────
    // Fire-and-forget (no ack). A 6 s server-side TTL auto-stops stale
    // indicators if typing:stop is never received (crash / network drop).
    // On disconnect all pending timers are flushed and stop events broadcast.
    //
    // Events:
    //   client→server: typing:start | community:typing:start (new canonical alias)
    //   client→server: typing:stop  | community:typing:stop  (new canonical alias)
    //   server→client: typing:start (direct per-recipient delivery, sender excluded)
    //   server→client: typing:stop  (direct per-recipient delivery, sender excluded)
    //
    // ROOM-INDEPENDENT BY DESIGN (unlike recording/livestream below, which are
    // unchanged and still room-based): typing no longer relies on
    // community:<id> or community-typing:<id> room membership at all — a
    // member receives typing events whether or not their socket has ever
    // joined either room. See getActiveCommunityMemberIds below; the direct
    // per-recipient delivery itself now lives in the shared
    // createDirectRosterBroadcast, which /chat typing uses too.
    // ── Room-independent recipient resolution (typing only) ────────────────
    // Reuses communityClient.getCommunityActiveMemberIds, which is itself a
    // thin gRPC wrapper around community-service's existing
    // communityRepository.findActiveMemberIds — the SAME repository method
    // already used to build notification rosters (community deletion,
    // livestream lifecycle). One query, select userId only — no N+1.
    //
    // The returned list does double duty: (1) membership validation for the
    // sender — a BANNED/LEFT/PENDING user never appears in an ACTIVE-only
    // list, so `memberIds.includes(userId)` is equivalent to the ACTIVE-status
    // check `checkCommunityMembership` performs elsewhere, without a second
    // gRPC round trip — and (2) the recipient roster. The CLOSED/SUSPENDED
    // community gate is unrelated to membership and stays a separate, cheap
    // Set lookup (closedCommunityIds), consistent with how it already gates
    // community:join and the recording indicator below.
    const getActiveCommunityMemberIds = async (
      communityId: string
    ): Promise<string[]> => {
      try {
        const { userIds } = await communityClient.getCommunityActiveMemberIds({
          communityId,
        });
        return userIds;
      } catch (err) {
        logger.warn(
          `/community typing: failed to resolve active members communityId=${communityId}: ${String(err)}`
        );
        return [];
      }
    };

    // Authorization gate for the recording indicator (typing no longer uses
    // this — see getActiveCommunityMemberIds above): reuses room membership
    // already established at connect (ban-gated getUserActiveCommunityIds
    // auto-join) or via community:join (ban-gated gRPC check). Without this,
    // socket.to(room) would happily broadcast to a communityId the sender was
    // never authorized to join, letting any authenticated user inject a fake
    // presence indicator into any community.
    //
    // Fast path: the rooms are already joined (steady state, or an explicit
    // community:join happened) — pure sync lookup, zero overhead per keystroke.
    // Slow path (only ever hit once per connection, at most): the connect-time
    // auto-join is still in flight, so await that SAME promise (not a new gRPC
    // call) before re-checking — this is what lets typing work immediately
    // after connecting without waiting on an explicit room join.
    const hasTypingRoom = (communityId: string): boolean =>
      socket.rooms.has(`community:${communityId}`) ||
      socket.rooms.has(`community-typing:${communityId}`);
    const isAuthorizedForCommunity = async (
      communityId: string
    ): Promise<boolean> => {
      // Single shared CLOSED guard for typing/recording — a CLOSED/SUSPENDED
      // community must not receive new presence indicators. Sync Set lookup,
      // zero overhead per keystroke (see closedCommunityIds above).
      if (closedCommunityIds.has(communityId)) return false;
      if (hasTypingRoom(communityId)) return true;
      await typingRoomsReady;
      return hasTypingRoom(communityId);
    };

    // Build the canonical community typing payload for server→client broadcasts.
    // userId is always server-authoritative (from the verified JWT, not the payload).
    // Shared with /chat via buildTypingBroadcast so private, group, and community
    // presence events are byte-for-byte the same shape (roomId === communityId,
    // because the community GeneralRoom id === communityId).
    const communityTypingPayload = (communityId: string) =>
      buildTypingBroadcast(
        userId,
        socket.data.userDetails,
        communityId,
        Date.now(),
        { communityId }
      );

    // Room-independent typing, now driven by the SHARED presence engine that
    // /chat also uses (timers, 6 s TTL, disconnect flush live there). The
    // behaviour is unchanged: the active-member roster both validates the
    // sender and supplies the recipient set, the sender is excluded by never
    // appearing in that set, and the TTL re-resolves membership at fire time
    // because it runs outside the request context.
    const typing = createPresenceIndicator({
      startEvent: "typing:start",
      stopEvent: "typing:stop",
      canStart: async () =>
        (await userClient.getChatFlags(userId)).typingIndicators,
      broadcast: createDirectRosterBroadcast({
        namespace: community,
        senderId: userId,
        resolveRoster: getActiveCommunityMemberIds,
        buildPayload: communityTypingPayload,
        isSuppressed: (communityId) => closedCommunityIds.has(communityId),
        // Reciprocal: a member who turned their own indicator off doesn't see mine.
        filterRecipients: typingViewerFilter(userClient),
      }),
    });

    // Shared handler for both the new canonical name and the legacy alias.
    const handleTypingStart = (payload: unknown): void => {
      const r = CommunityTypingSchema.safeParse(payload);
      if (!r.success) return;
      typing.start(r.data.communityId);
    };

    const handleTypingStop = (payload: unknown): void => {
      const r = CommunityTypingSchema.safeParse(payload);
      if (!r.success) return;
      typing.stop(r.data.communityId);
    };

    // ── FIRE-AND-FORGET (NO ACK) — canonical names ──────────────────────────
    socket.on("community:typing:start", handleTypingStart);
    socket.on("community:typing:stop", handleTypingStop);
    // ── FIRE-AND-FORGET — legacy aliases (backward compat) ──────────────────
    socket.on("typing:start", handleTypingStart);
    socket.on("typing:stop", handleTypingStop);

    // ── Voice recording presence ────────────────────────────────────────────────
    // Fire-and-forget (no ack). A 6 s server-side TTL auto-stops stale indicators
    // if recording:stop is never received. On disconnect all pending timers are
    // flushed and stop events broadcast. Identical to typing indicator architecture.
    // Broadcasts to both community:<id> (open-chat) AND community-typing:<id>
    // (always-on membership) rooms so sidebar recording indicators work even when
    // chat is not open. Socket.IO de-duplicates recipients.
    const communityRecordingPayload = (communityId: string) =>
      buildTypingBroadcast(
        userId,
        socket.data.userDetails,
        communityId,
        Date.now(),
        { communityId }
      );

    const recording = createPresenceIndicator({
      startEvent: "recording:start",
      stopEvent: "recording:stop",
      broadcast: createRoomBroadcast({
        namespace: community,
        socket,
        // Both rooms — Socket.IO de-duplicates a member present in both.
        rooms: (communityId) => [
          `community:${communityId}`,
          `community-typing:${communityId}`,
        ],
        buildPayload: communityRecordingPayload,
        isAuthorized: isAuthorizedForCommunity,
      }),
    });

    // Shared handler for both canonical and legacy recording event names.
    const handleRecordingStart = (payload: unknown): void => {
      const r = CommunityTypingSchema.safeParse(payload);
      if (!r.success) return;
      recording.start(r.data.communityId);
    };

    const handleRecordingStop = (payload: unknown): void => {
      const r = CommunityTypingSchema.safeParse(payload);
      if (!r.success) return;
      recording.stop(r.data.communityId);
    };

    // ── FIRE-AND-FORGET (NO ACK) — canonical names ──────────────────────────
    socket.on("community:recording:start", handleRecordingStart);
    socket.on("community:recording:stop", handleRecordingStop);
    // ── FIRE-AND-FORGET — legacy aliases (backward compat) ──────────────────
    socket.on("recording:start", handleRecordingStart);
    socket.on("recording:stop", handleRecordingStop);

    socket.on(
      "community:join",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityJoinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        const communityId = r.data.communityId;
        void (async () => {
          // Membership gate: only a current ACTIVE member may enter the
          // broadcast room. A BANNED user is rejected with the explicit
          // USER_BANNED code; anyone else who isn't ACTIVE (LEFT — including a
          // just-unbanned user who hasn't rejoined — PENDING, or never a
          // member at all) is rejected as FORBIDDEN. Unban never re-admits: it
          // only lifts the ban to LEFT, so this gate is what actually stops a
          // stale/unbanned client from receiving room broadcasts until they go
          // through the normal join flow again. Only an explicit verdict
          // rejects — on a gRPC/breaker failure we fail OPEN (join allowed)
          // because the act-vector (send/edit/react) is independently
          // hard-blocked at chat-service, so the only risk of a transient
          // failure is a brief receive-side leak, not an integrity breach.
          try {
            const m = await communityClient.checkCommunityMembership({
              communityId,
              userId,
            });
            if (m.isBanned) {
              ackError(callback, "USER_BANNED", locale);
              return;
            }
            // PUBLIC communities let non-members READ history via REST — the
            // socket ban gate mirrors that by also letting them subscribe to
            // live broadcasts, so the FE doesn't render past messages but
            // silently miss every new one. PRIVATE stays members-only.
            if (!m.isMember && !m.isPublicCommunity) {
              ackError(callback, "FORBIDDEN", locale);
              return;
            }
            // Self-heal the local closed-community cache — covers a gateway
            // instance that (re)started while the community was already closed
            // and so never observed the community:closed relay event.
            if (m.isCommunityClosed) {
              closedCommunityIds.add(communityId);
            } else {
              closedCommunityIds.delete(communityId);
            }
          } catch (err) {
            logger.warn(
              `/community join membership check failed (fail-open) community=${communityId} user=${userId}: ${String(err)}`
            );
          }
          void socket.join(`community:${communityId}`);
          // Also join the typing room (idempotent — safe even if auto-joined
          // at connect; does NOT get left on community:leave so sidebar typing
          // keeps working after the user closes the chat view).
          void socket.join(`community-typing:${communityId}`);
          ackOk(callback, "SOCKET_COMMUNITY_JOINED", locale);
        })();
      }
    );

    socket.on(
      "community:leave",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityLeaveSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void socket.leave(`community:${r.data.communityId}`);
        ackOk(callback, "SOCKET_COMMUNITY_LEFT", locale);
      }
    );

    socket.on(
      "community:message:send",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgSendSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .sendCommunityMessage({
            communityId: r.data.communityId,
            roomId: r.data.roomId ?? r.data.communityId,
            senderId: userId,
            clientMessageId: r.data.clientMessageId,
            // Cross-namespace parity: accept contentText as an alias for message.
            message: r.data.message || r.data.contentText || "",
            contentType: r.data.contentType,
            // Cross-namespace parity: accept top-level files[] as alias for media.files[].
            mediaFiles: r.data.media?.files ?? r.data.files,
            location: r.data.location,
            contact: r.data.contact,
            sticker: r.data.sticker,
            // Cross-namespace parity: accept repliedToId as an alias.
            parentMessageId: r.data.parentMessageId ?? r.data.repliedToId,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_SENT", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:send gRPC error: ${String(err)}`);
            // Preserve the specific failure reason (file too large, too many
            // images, unsupported type, community not found, muted/banned,
            // etc.) when chat-service mapped it from an AppError; anything
            // unrecognized falls back to the generic SERVICE_ERROR message.
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "community:messages:fetch",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgsFetchSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .getCommunityMessages({ ...r.data, requesterId: userId })
          .then((result) => {
            // Reshape each gRPC DTO into the wire shape the FE expects.
            // Real-time sends use `content: { text, files }` — history fetch
            // must match that shape so mapCommunityMessage renders images.
            const messages = result.messages.map((m) => {
              let files: unknown[] = [];
              if (m.attachmentsJson) {
                try {
                  const parsed = JSON.parse(m.attachmentsJson) as unknown[];
                  if (Array.isArray(parsed)) files = parsed;
                } catch (err) {
                  logger.error(
                    "Failed to parse attachmentsJson from community message:",
                    err
                  );
                }
              }
              if (files.length === 0 && m.mediaKey) {
                files = [{ url: m.mediaKey }];
              }

              let reactions: unknown[] = [];
              if (m.reactionsJson) {
                try {
                  const parsed = JSON.parse(m.reactionsJson) as unknown[];
                  if (Array.isArray(parsed)) reactions = parsed;
                } catch (err) {
                  logger.error(
                    "Failed to parse reactionsJson from community message:",
                    err
                  );
                }
              }

              let quoteData: unknown = null;
              if (m.quoteDataJson) {
                try {
                  quoteData = JSON.parse(m.quoteDataJson);
                } catch (err) {
                  logger.error(
                    "Failed to parse quoteDataJson from community message:",
                    err
                  );
                }
              }

              return {
                id: m.messageId,
                messageId: m.messageId,
                roomId: m.roomId,
                senderId: m.senderId,
                senderName: m.senderName || undefined,
                senderAvatar: m.senderAvatar || undefined,
                contentType: m.contentType,
                content: {
                  text: m.message || undefined,
                  files: files.length > 0 ? files : undefined,
                },
                message: m.message,
                reactions,
                quoteData: quoteData || undefined,
                sentAt: m.sentAt,
              };
            });
            // pinnedMessage: FE always knows the currently pinned message
            // without depending on the PINNED_MESSAGE system line, which
            // scrolls out of view as newer messages arrive. null = no active pin.
            let pinnedMessage: unknown = null;
            if (result.pinnedMessageJson) {
              try {
                pinnedMessage = JSON.parse(result.pinnedMessageJson);
              } catch (err) {
                logger.error(
                  "Failed to parse pinnedMessageJson from community messages:fetch:",
                  err
                );
              }
            }

            return ackOk(
              callback,
              "SOCKET_COMMUNITY_MESSAGES_FETCHED",
              locale,
              {
                messages,
                nextCursor: result.nextCursor,
                hasMore: result.hasMore,
                pinnedMessage,
              }
            );
          })
          .catch((err: unknown) => {
            logger.warn(`/community messages:fetch gRPC error: ${String(err)}`);
            // Preserve the specific denial (USER_BANNED for a banned member,
            // not-a-member, etc.) instead of a generic retryable SERVICE_ERROR.
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "community:message:react",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgReactSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .reactToCommunityMessage({ ...r.data, userId })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_REACTED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:react gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // Reconnect gap-fill: fetch missed messages per community room since a
    // known message id. Mirrors chat:catchup for private/group rooms.
    socket.on(
      "community:catchup",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const parsed = CommunityCatchupSchema.safeParse(payload);
        if (!parsed.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const rooms = parsed.data.rooms;
          const results = await Promise.allSettled(
            rooms.map((room) =>
              communityClient.communityCatchup({
                roomId: room.roomId,
                requesterId: userId,
                sinceId: room.sinceId ?? "",
                limit: room.limit ?? 100,
                sinceTs: room.sinceTs,
                // Only forward when the client opted in (undefined ⇒ gateway sends
                // the -1 "not revision mode" sentinel; 0 IS a valid cold start).
                sinceRevision: room.sinceRevision,
              })
            )
          );

          const ackRooms: Array<{
            roomId: string;
            hasMore: boolean;
            lastId: string;
            nextTs: number;
            authorized: boolean;
            lastRevision: number;
            roomRevision: number;
            resetRequired: boolean;
          }> = [];

          results.forEach((res, idx) => {
            const room = rooms[idx]!;
            if (res.status === "fulfilled") {
              const r = res.value;
              socket.emit("community:catchup:result", {
                roomId: room.roomId,
                events: r.events.map((e) => ({
                  ...e,
                  sentAt: Number(e.sentAt),
                  editedAt: Number(e.editedAt),
                  reactions: e.reactions ?? [],
                  // Zero-loss CHANGE cursor per message.
                  revision: Number(e.revision ?? 0),
                })),
                hasMore: r.hasMore,
                lastId: r.lastId,
                nextTs: Number(r.nextTs ?? 0),
                // Zero-loss revision-mode fields (0/false in id/ts modes).
                lastRevision: Number(r.lastRevision ?? 0),
                roomRevision: Number(r.roomRevision ?? 0),
                resetRequired: Boolean(r.resetRequired),
              });
              ackRooms.push({
                roomId: room.roomId,
                hasMore: r.hasMore,
                lastId: r.lastId,
                nextTs: Number(r.nextTs ?? 0),
                authorized: r.authorized,
                lastRevision: Number(r.lastRevision ?? 0),
                roomRevision: Number(r.roomRevision ?? 0),
                resetRequired: Boolean(r.resetRequired),
              });
            } else {
              logger.warn(
                `/community community:catchup gRPC error for room ${room.roomId}: ${String(res.reason)}`
              );
            }
          });

          ackOk(callback, "SOCKET_COMMUNITY_CATCHUP_COMPLETED", locale, {
            rooms: ackRooms,
          });
        })();
      }
    );

    socket.on(
      "community:message:edit",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgEditSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .editCommunityMessage({
            messageId: r.data.messageId,
            communityId: r.data.communityId,
            userId,
            // content.text is canonical; contentText is the /chat-parity alias.
            text: r.data.content?.text ?? r.data.contentText ?? "",
          })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_EDITED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:edit gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "community:message:delete",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgDeleteSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .deleteCommunityMessage({
            messageId: r.data.messageId,
            communityId: r.data.communityId,
            userId,
            deleteType: r.data.type,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_DELETED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:delete gRPC error: ${String(err)}`);
            // Preserve the specific failure reason (message not found, already
            // deleted, insufficient permissions, muted, room suspended, etc.)
            // when chat-service mapped it from an AppError; anything unrecognized
            // (network failure, breaker-open, a genuine internal error) falls
            // back to the generic SERVICE_ERROR message as before.
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "community:message:pin",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgPinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .pinCommunityMessage({
            ...r.data,
            roomId: r.data.roomId ?? r.data.communityId,
            userId,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_PINNED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:pin gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "community:message:unpin",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgUnpinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .unpinCommunityMessage({
            ...r.data,
            roomId: r.data.roomId ?? r.data.communityId,
            userId,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_UNPINNED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:unpin gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // ── Moderation ────────────────────────────────────────────────────────────
    // All moderation actions are authorised server-side (community-service checks
    // the actor's role). The gateway passes the authenticated userId as actorId
    // so clients cannot impersonate another actor.

    socket.on(
      "community.member.kick",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = KickMemberSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .kickMember({ ...r.data, actorId: userId })
          .then((result) =>
            result.ok
              ? ackOk(
                  callback,
                  "SOCKET_COMMUNITY_MEMBER_KICKED",
                  locale,
                  result
                )
              : ackError(callback, "FORBIDDEN", locale)
          )
          .catch((err: unknown) => {
            logger.warn(`/community member.kick gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "community.member.ban",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = BanMemberSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .banMember({ ...r.data, actorId: userId })
          .then((result) =>
            result.ok
              ? ackOk(
                  callback,
                  "SOCKET_COMMUNITY_MEMBER_BANNED",
                  locale,
                  result
                )
              : ackError(callback, "FORBIDDEN", locale)
          )
          .catch((err: unknown) => {
            logger.warn(`/community member.ban gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "community.member.unban",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = UnbanMemberSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .unbanMember({ ...r.data, actorId: userId })
          .then((result) =>
            result.ok
              ? ackOk(
                  callback,
                  "SOCKET_COMMUNITY_MEMBER_UNBANNED",
                  locale,
                  result
                )
              : ackError(callback, "FORBIDDEN", locale)
          )
          .catch((err: unknown) => {
            logger.warn(`/community member.unban gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "community.admin.transfer",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = TransferAdminSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .transferAdmin({ ...r.data, actorId: userId })
          .then((result) =>
            result.ok
              ? ackOk(
                  callback,
                  "SOCKET_COMMUNITY_ADMIN_TRANSFERRED",
                  locale,
                  result
                )
              : ackError(callback, "FORBIDDEN", locale)
          )
          .catch((err: unknown) => {
            logger.warn(`/community admin.transfer gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "community.member.role_change",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = ChangeMemberRoleSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .changeMemberRole({ ...r.data, actorId: userId })
          .then((result) =>
            result.ok
              ? ackOk(callback, "SOCKET_COMMUNITY_ROLE_CHANGED", locale, result)
              : ackError(callback, "FORBIDDEN", locale)
          )
          .catch((err: unknown) => {
            logger.warn(
              `/community member.role_change gRPC error: ${String(err)}`
            );
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "community.report.create",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CreateReportSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .createReport({ ...r.data, reporterId: userId })
          .then((result) =>
            result.ok
              ? ackOk(
                  callback,
                  "SOCKET_COMMUNITY_REPORT_CREATED",
                  locale,
                  result
                )
              : ackError(callback, "SERVICE_ERROR", locale)
          )
          .catch((err: unknown) => {
            logger.warn(`/community report.create gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "community.delete",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = DeleteCommunitySchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .deleteCommunity({ ...r.data, actorId: userId })
          .then((result) => {
            if (!result.ok) {
              ackError(callback, "FORBIDDEN", locale);
              return;
            }
            // Broadcast deletion to all community members before acking.
            community
              .to(`community:${r.data.communityId}`)
              .emit("community.deleted", {
                communityId: r.data.communityId,
                deletedBy: userId,
              });
            ackOk(callback, "SOCKET_COMMUNITY_DELETED", locale, result);
          })
          .catch((err: unknown) => {
            logger.warn(`/community delete gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // ── community:message:read ─────────────────────────────────────────────────
    socket.on(
      "community:message:read",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgReadSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .markCommunityMessageRead({
            communityId: r.data.communityId,
            roomId: r.data.roomId ?? r.data.communityId,
            readerId: userId,
            upToMessageId: r.data.upToMessageId,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_COMMUNITY_MESSAGE_READ", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/community message:read gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // ── community:message:reactions:get ───────────────────────────────────────
    socket.on(
      "community:message:reactions:get",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgReactionsGetSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .getCommunityMessageReactions({ ...r.data, requesterId: userId })
          .then((result) =>
            ackOk(
              callback,
              "SOCKET_COMMUNITY_REACTIONS_FETCHED",
              locale,
              result
            )
          )
          .catch((err: unknown) => {
            logger.warn(
              `/community message:reactions:get gRPC error: ${String(err)}`
            );
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // ── community:message:forward ──────────────────────────────────────────────
    socket.on(
      "community:message:forward",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgForwardSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .forwardCommunityMessage({
            sourceMessageId: r.data.messageId,
            sourceCommunityId: r.data.communityId,
            targetCommunityId: r.data.targetCommunityId,
            targetRoomId: r.data.targetRoomId ?? r.data.targetCommunityId,
            senderId: userId,
            clientMessageId: r.data.clientMessageId,
          })
          .then((result) =>
            ackOk(
              callback,
              "SOCKET_COMMUNITY_MESSAGE_FORWARDED",
              locale,
              result
            )
          )
          .catch((err: unknown) => {
            logger.warn(
              `/community message:forward gRPC error: ${String(err)}`
            );
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // ── community:message:delivered ───────────────────────────────────────────
    socket.on(
      "community:message:delivered",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CommunityMsgDeliveredSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        communityClient
          .markCommunityMessageDelivered({
            communityId: r.data.communityId,
            roomId: r.data.roomId ?? r.data.communityId,
            recipientId: userId,
            upToMessageId: r.data.upToMessageId,
          })
          .then((result) =>
            ackOk(
              callback,
              "SOCKET_COMMUNITY_MESSAGE_DELIVERED",
              locale,
              result
            )
          )
          .catch((err: unknown) => {
            logger.warn(
              `/community message:delivered gRPC error: ${String(err)}`
            );
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // ── auth:refresh + session:expired ────────────────────────────────────────
    const {
      clearSessionTimers,
      scheduleSessionTimers,
      registerAuthRefreshHandler,
    } = createSessionTimers(socket, locale, "/community", env.AUTH_SERVICE_URL);

    if (socket.data.tokenExpiresAt > 0) {
      scheduleSessionTimers(socket.data.tokenExpiresAt);
    }
    registerAuthRefreshHandler();

    socket.on("disconnect", (reason: string) => {
      logger.debug(`/community disconnected userId=${userId} reason=${reason}`);

      // Clear session expiry timers.
      clearSessionTimers();

      // Flush every pending presence timer and broadcast the stop, so members
      // are never stuck with a "typing…" / "recording…" indicator after the
      // socket closes. Typing delivers directly to each active member
      // (room-independent), recording broadcasts to the rooms — both handled
      // by the shared engine, identically to /chat.
      typing.flush();
      recording.flush();
    });
  });
}
