import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { logger } from "@aimess/logger";
import { readPresenceSnapshots } from "@aimess/redis";
import { createGatewaySocketAuthMiddleware } from "../auth.middleware.js";
import { bindSocketAuditContext } from "../audit-context.js";
import { ackOk, ackError, resolveGrpcAckError } from "../ack.js";
import {
  personalizeConvUpdatedPreview,
  personalizeGroupSocketMessage,
} from "../system-message-personalize.js";
import {
  emitPersonalizedSender,
  type PersonalizeFn,
} from "../emit-personalized.js";
import { typingViewerFilter, viewerHidesReadReceipts } from "../chat-flags.js";
import type {
  CatchupEventDto,
  MessagingClient,
} from "../../grpc/clients/messaging.client.js";
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
import { scopeSocketLocale } from "../locale-scope.js";
import { createSessionTimers } from "../session-timers.js";

// §3: bound free-text + array fields so a naive or abusive client cannot exceed
// the 1 MB socket frame, blow up storage, or fan an oversized payload out to a
// whole room. These are coarse gateway guards; chat-service enforces the
// authoritative per-attachment media limits.
const MAX_TEXT_LEN = 4000; // message body / caption (matches chat-service CHAT_TEXT_MAX_CHARS)
const MAX_JSON_LEN = 16384; // pre-encoded contentJson on edits
const MAX_FILES = 30; // attachments per message (gallery)
const MAX_URLS = 20; // link previews per message
const MAX_EMOJI_LEN = 32; // one emoji grapheme incl. ZWJ/skin-tone sequences
const MAX_NAME_LEN = 120; // denormalized senderName fanned out to the room
const MAX_URL_LEN = 3000; // a single URL / objectKey / avatar

/**
 * How often a live socket refreshes its presence device session. Must be
 * comfortably under chat-service's PRESENCE_SESSION_TTL_SEC (150 s) so a couple
 * of dropped refreshes still don't expire a healthy connection.
 */
const PRESENCE_REFRESH_MS = Number(process.env.PRESENCE_REFRESH_MS ?? 45_000);

const CALL_INITIATE_RATE_MAX = env.CALL_INITIATE_RATE_MAX;
const CALL_INITIATE_RATE_WINDOW_SEC = env.CALL_INITIATE_RATE_WINDOW_SEC;

/**
 * Cross-namespace request-DTO parity (/community is the reference contract).
 *
 * /community names the same concepts `roomId`, `message`, `parentMessageId`, and
 * `content.text`; /chat has always named them `conversationId`, `contentText`,
 * `repliedToId`, and `contentText`. Renaming the /chat fields would break every
 * shipped Web/Android/iOS client, so instead this normalizes the /community
 * spelling INTO the /chat spelling before validation: both are accepted on the
 * wire, the legacy /chat name stays canonical downstream, and nothing existing
 * changes meaning. The legacy name always wins when a client sends both.
 *
 * Applied to every /chat inbound schema — a schema that has no such field simply
 * strips the injected key, so this is safe to apply uniformly.
 */
const withCommunityAliases = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const v = value as Record<string, unknown>;
    const aliased = { ...v };
    if (aliased.conversationId === undefined && v.roomId !== undefined) {
      aliased.conversationId = v.roomId;
    }
    if (aliased.contentText === undefined && v.message !== undefined) {
      aliased.contentText = v.message;
    }
    if (
      aliased.contentText === undefined &&
      v.content !== null &&
      typeof v.content === "object" &&
      !Array.isArray(v.content)
    ) {
      aliased.contentText = (v.content as Record<string, unknown>).text;
    }
    if (aliased.repliedToId === undefined && v.parentMessageId !== undefined) {
      aliased.repliedToId = v.parentMessageId;
    }
    if (
      aliased.targetConversationId === undefined &&
      v.targetRoomId !== undefined
    ) {
      aliased.targetConversationId = v.targetRoomId;
    }
    return aliased;
  }, schema);

// ─── Inbound payload schemas ────────────────────────────────────────────────
const ConvJoinSchema = withCommunityAliases(
  z.object({
    conversationId: z.string().min(1),
    // Additive/optional: legacy clients that omit it join unchecked (private
    // DM behavior, unchanged). GROUP join is membership-gated — see the
    // handler below.
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).optional()
    ),
  })
);
const ConvLeaveSchema = withCommunityAliases(
  z.object({ conversationId: z.string().min(1) })
);
const TypingSchema = withCommunityAliases(
  z.object({
    conversationId: z.string().min(1),
    // V2 §2.8: client supplies its own display name so recipients can show
    // "Alice is typing…" without an extra profile fetch.
    senderName: z.string().max(100).optional(),
    // Additive and optional: lets the gateway resolve the participant roster
    // through the right branch (private participants vs. group members) for
    // room-independent typing delivery. Legacy clients omit it and get the
    // PRIVATE default, which is what /chat typing has always assumed.
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
  })
);
const FileAttachmentSchema = z.object({
  objectKey: z.string().min(1).max(500).optional(),
  url: z.string().min(1).max(3000).optional(),
  name: z.string().max(255).default(""),
  size: z.number().nonnegative().default(0),
  mime: z.string().max(150).default(""),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  durationMs: z.number().nonnegative().optional(),
  // Poster frame the sender already generated and uploaded for videos/animated GIFs.
  // Omitting it here silently STRIPPED it (zod drops unknown keys), so no video was
  // ever stored with a thumbnail and every receiver had to decode a frame out of the
  // video itself over HTTP.
  thumbnailObjectKey: z.string().max(500).optional(),
  mediaBatchId: z.string().max(64).optional(),
  // §3.5: instant-preview metadata — blurhash (image/video) renders the bubble
  // at the right aspect ratio before download; waveform (voice) paints the bars.
  blurhash: z.string().max(120).optional(),
  waveform: z.array(z.number()).max(2048).optional(),
});
const LocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  placeName: z.string().max(200).optional(),
  placeAddress: z.string().max(500).optional(),
});
const ContactSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(50),
  avatar: z.string().max(3000).optional(),
  userId: z.string().max(100).optional(),
});
// STICKER sends carry their media OUTSIDE files[] (chat-service persists
// `content.sticker`). Omitting it here made zod strip it, so a sticker sent over
// the socket persisted with an EMPTY content blob — it rendered from local state
// and was gone on the next history read. Mirrors the REST `stickerSchema`.
const StickerSchema = z
  .object({
    mediaId: z.string().min(1).max(100).optional(),
    objectKey: z.string().min(1).max(500).optional(),
    url: z.string().max(MAX_URL_LEN).optional(),
    packId: z.string().max(100),
    stickerId: z.string().max(100),
  })
  .refine((d) => d.objectKey || d.url, {
    message: "sticker requires objectKey or url",
  });
const MessageSendSchemaBase = z.object({
  conversationId: z.string().min(1),
  clientMessageId: z.string().optional(),
  contentType: z
    .string()
    .min(1)
    .transform((v) => v.toUpperCase()),
  contentText: z.string().max(MAX_TEXT_LEN).optional(),
  // Deprecated single object-key shorthand — prefer files[] (a single file is an
  // array of one). Kept for back-compat; the gateway folds it into files[].
  mediaKey: z.string().max(MAX_URL_LEN).optional(),
  files: z.array(FileAttachmentSchema).max(MAX_FILES).optional(),
  urls: z.array(z.string().url().max(MAX_URL_LEN)).max(MAX_URLS).optional(),
  location: LocationSchema.optional(),
  contact: ContactSchema.optional(),
  sticker: StickerSchema.optional(),
  repliedToId: z.string().optional(),
  conversationType: z.preprocess(
    (value) =>
      typeof value === "string" ? value.toString().toLowerCase() : value,
    z.enum(["private", "group"]).default("private")
  ),
  receiverId: z.string().optional(),
  senderName: z.string().max(MAX_NAME_LEN).optional(),
  senderAvatar: z.string().max(MAX_URL_LEN).optional(),
  // §5.1: client compose time (epoch ms) — display only, never overwrites serverTs.
  clientTs: z.number().int().nonnegative().optional(),
});
const MessageReadSchemaBase = z.object({
  conversationId: z.string().min(1),
  upToMessageId: z.string().min(1),
  // Optional claim — chat-service resolves the authoritative type from the
  // room-id prefix (`grp_` / `prv_`). Kept for legacy unprefixed ids.
  conversationType: z.preprocess(
    (v) => (typeof v === "string" ? v.toLowerCase() : v),
    z.enum(["private", "group"]).optional()
  ),
});
const MessageReactSchemaBase = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1),
  // §3: a single emoji grapheme — bounded length (handles multi-codepoint ZWJ
  // and skin-tone sequences) but rejects pasted text used as a "reaction".
  emoji: z.string().min(1).max(MAX_EMOJI_LEN),
  // §2.4: route group reactions to the group collection (default private).
  conversationType: z.preprocess(
    (v) => (typeof v === "string" ? v.toLowerCase() : v),
    z.enum(["private", "group"]).default("private")
  ),
  // "set" => the caller ends up with exactly `emoji` (re-sending the same one clears it), so a
  // reaction CHANGE is one event instead of remove-then-add. Defaults to the legacy toggle.
  mode: z.preprocess(
    (v) => (typeof v === "string" ? v.toLowerCase() : v),
    z.enum(["toggle", "set"]).default("toggle")
  ),
});
const MessagesFetchSchemaBase = z.object({
  conversationId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
  conversationType: z.preprocess(
    (value) =>
      typeof value === "string" ? value.toString().toLowerCase() : value,
    z.enum(["private", "group"]).default("private")
  ),
});

// Each `*Base` above defines the canonical /chat field names; the exported
// schema additionally accepts the equivalent /community spellings (roomId,
// message, content.text, parentMessageId). See withCommunityAliases.
const MessageSendSchema = withCommunityAliases(MessageSendSchemaBase);
const MessageReadSchema = withCommunityAliases(MessageReadSchemaBase);
const MessageReactSchema = withCommunityAliases(MessageReactSchemaBase);
const MessagesFetchSchema = withCommunityAliases(MessagesFetchSchemaBase);

const CatchupSchema = z.object({
  rooms: z
    .array(
      z.object({
        roomId: z.string().min(1),
        sinceSeq: z.number().int().nonnegative().default(0),
        conversationType: z.preprocess(
          (v) => (typeof v === "string" ? v.toLowerCase() : v),
          z.enum(["private", "group"]).default("private")
        ),
        limit: z.number().int().positive().max(200).optional(),
        /**
         * ZERO-LOSS revision cursor (takes precedence over sinceSeq). The client's
         * per-room CHANGE high-water. When provided (including 0 for a cold start)
         * the server returns every message whose revision > sinceRevision — inserts
         * AND mutations (edits/reactions/deletes) — plus roomRevision/lastRevision/
         * resetRequired. Preferred over sinceSeq for reconnect. Mirrors
         * community:catchup and the REST /changes feed.
         */
        sinceRevision: z.number().int().min(0).optional(),
      })
    )
    .min(1)
    .max(50),
});

// ── Friend management schemas ─────────────────────────────────────────────────
const FriendRequestSchema = z.object({
  addresseeId: z.string().uuid(),
});
const FriendAcceptSchema = z.object({
  requestId: z.string().uuid(),
});
const FriendRejectSchema = z.object({
  requestId: z.string().uuid(),
});
const FriendRemoveSchema = z.object({
  targetUserId: z.string().uuid(),
});
const FriendCancelRequestSchema = z.object({
  requestId: z.string().uuid(),
});

// ─── Redis pub/sub message shape published by messaging-service ──────────────
interface RedisSocketEvent {
  event: string;
  data: unknown;
  /**
   * Envelope-only (never emitted to clients): when present, this user's own
   * sockets are skipped for this `conv:<roomId>` broadcast. Set by the group
   * removal path so a banned/kicked member never receives the room event
   * announcing their own removal ("Admin banned X" / group:member:removed).
   */
  excludeUserId?: string;
}

/** Restore the canonical message shape stripped down by the catch-up protobuf. */
export function normalizeCatchupEvent(
  event: CatchupEventDto,
  conversationType: string
): Record<string, unknown> {
  const { systemData: rawSystemData, ...eventWithoutRawSystemData } = event;
  let content: Record<string, unknown> = {
    text: event.contentText ?? "",
    urls: [],
    files: [],
  };
  if (event.contentJson) {
    try {
      const parsedContent = JSON.parse(event.contentJson) as unknown;
      if (parsedContent && typeof parsedContent === "object") {
        content = parsedContent as Record<string, unknown>;
      }
    } catch {
      // Keep the contentText fallback above.
    }
  }

  let systemData: Record<string, unknown> | undefined;
  if (rawSystemData) {
    try {
      const parsedSystemData = JSON.parse(rawSystemData) as unknown;
      if (parsedSystemData && typeof parsedSystemData === "object") {
        systemData = parsedSystemData as Record<string, unknown>;
      }
    } catch {
      // Malformed optional metadata must not hide the message.
    }
  }

  const serverTs = Number(event.sentAt);
  return {
    ...eventWithoutRawSystemData,
    id: event.messageId,
    roomId: event.conversationId,
    conversationType: conversationType.toUpperCase(),
    content,
    // Canonical grouped reaction state carried by the catch-up protobuf event —
    // without this a reaction applied live vanished the next time the client
    // caught up (reopen room, reload, reconnect), since reconnect hydration
    // never re-sent the plain `message:reaction` broadcast.
    reactions: event.reactions ?? [],
    sequenceNumber: Number(event.sequenceNumber),
    // int64 arrives as a string via proto-loader (longs: String).
    revision: Number(event.revision ?? 0),
    serverTs,
    sentAt: serverTs,
    createdAt: new Date(serverTs).toISOString(),
    editedAt: Number(event.editedAt),
    ...(systemData ? { systemData } : {}),
  };
}

export function registerChatNamespace(
  io: SocketIOServer,
  messagingClient: MessagingClient,
  redisSub: Redis,
  redisPub: Redis,
  userClient: UserClient,
  mediaClient: MediaClient
): void {
  const chat: Namespace = io.of("/chat");
  chat.use(createGatewaySocketAuthMiddleware(redisPub));

  /**
   * ROOM MODEL — the security invariant this namespace rests on.
   *
   *   user:<id>       ONLY that user's own sockets. Everything a service
   *                   addresses to a person (message:new, message:delivered,
   *                   message:read/read_sync, conv:updated, calls, typing
   *                   fan-out, friend events, settings) is delivered here, so
   *                   NOTHING else may ever join it.
   *   presence:<id>   Watchers of that user's online status. Joined by
   *                   `presence:subscribe` after a whoCanSeeOnlineStatus check.
   *                   Carries `presence:status` and nothing else.
   *   conv:<roomId>   Participants of one conversation — membership-gated.
   *   self:<id>       Historical alias of user:<id>; kept because call.service
   *                   publishes call lifecycle straight to Redis `self:<id>`.
   *   session:<id>    One device/session.
   *
   * `presence:subscribe` used to join the watcher into `user:<peerId>` — the
   * same room every private event lands in — which leaked the peer's whole
   * private stream to anyone who watched their dot. The two roles are split so
   * the leak cannot recur: adding a new user-addressed event is now safe by
   * default instead of requiring a hand-maintained "self-only" denylist.
   */

  /**
   * Re-run the `presence:subscribe` authorization for every socket that asked
   * to watch `subjectId`, in BOTH directions, and tell each one what it should
   * now believe. Called when the subject's privacy settings change or a
   * friendship of theirs changes — i.e. exactly when a granted subscription can
   * turn stale, or a denied one can become legitimate.
   *
   * Two things make this instant rather than "correct on next reconnect":
   *
   *  - Revoked watchers are pushed an explicit `presence:status` **offline**
   *    before they leave the room. Dropping them silently is safe but leaves a
   *    green dot on screen forever, since the room they just left is the only
   *    thing that would ever have corrected it. Reporting the subject as
   *    offline is not a disclosure — it is precisely what a denied viewer is
   *    entitled to see.
   *  - Newly-allowed watchers are joined and pushed the subject's CURRENT
   *    status. Widening used to require the client to re-subscribe, because a
   *    denied socket never joined the room and nothing tracked that it wanted
   *    to; `presence-intent:<subjectId>` is that missing record.
   *
   * The subject's OWN sockets are skipped (they are in `user:<self>` for their
   * own events, not as watchers). `filterVisiblePresence` fails CLOSED, so a
   * user-service outage during this pass revokes rather than grants.
   */
  const resyncPresenceWatchers = async (subjectId: string): Promise<void> => {
    try {
      const watchers = await chat
        .in(`presence-intent:${subjectId}`)
        .fetchSockets();
      if (watchers.length === 0) return;

      // One Redis read for the whole pass, straight from the CANONICAL presence
      // state chat-service writes. This used to read the gateway's own
      // `user:online:<id>` flag, which was set on connect and deleted on any
      // disconnect — so a user with two tabs was reported offline the moment
      // either one closed, disagreeing with the presence:status stream itself.
      const subject = (await readPresenceSnapshots(redisPub, [subjectId])).get(
        subjectId
      );

      await Promise.all(
        watchers.map(async (watcher) => {
          const watcherId = watcher.data?.userId as string | undefined;
          if (!watcherId || watcherId === subjectId) return;
          const visible = await userClient.filterVisiblePresence(watcherId, [
            subjectId,
          ]);
          const allowed = visible.includes(subjectId);
          const subscribed = watcher.rooms.has(`presence:${subjectId}`);

          if (allowed && !subscribed) {
            void watcher.join(`presence:${subjectId}`);
            watcher.emit("presence:status", {
              userId: subjectId,
              isOnline: subject?.isOnline ?? false,
              lastSeen: subject?.lastSeen ?? null,
              version: subject?.version ?? 0,
            });
            return;
          }
          if (!allowed && subscribed) {
            // Revocation, not a state report — so it carries NO `version`.
            // A version-less presence:status is unconditional by contract
            // (see BACKEND_PRESENCE_MOBILE.md): version-guarding this one would
            // let a stale-but-higher version keep the green dot lit for a
            // viewer who is no longer allowed to see it.
            watcher.emit("presence:status", {
              userId: subjectId,
              isOnline: false,
              lastSeen: null,
            });
            void watcher.leave(`presence:${subjectId}`);
          }
        })
      );
    } catch (err) {
      logger.warn(
        `/chat presence re-authorization failed for ${subjectId}: ${String(err)}`
      );
    }
  };

  // Dedicated subscriber for conversation, call, and user channels.
  // Backend services publish: { event: "message:new"|"message:edited"|..., data: {...} }
  // to the matching Redis channel. V2 events (pin:updated, read_sync) ride the
  // existing conv:* / user:* channels — no new subscription needed.
  void redisSub.psubscribe("conv:*");
  void redisSub.psubscribe("call:*");
  void redisSub.psubscribe("user:*");
  // Call lifecycle for a single user is published to Redis `self:<userId>` so
  // presence subscribers (who join Socket.IO `user:<peerId>`) never see it.
  void redisSub.psubscribe("self:*");
  redisSub.on(
    "pmessage",
    (pattern: string, channel: string, message: string) => {
      const allowedPatterns = ["conv:*", "call:*", "user:*", "self:*"];
      if (!allowedPatterns.includes(pattern)) return;
      try {
        const parsed = JSON.parse(message) as RedisSocketEvent;

        // Community list-bump / read-sync events (community:updated,
        // community:read_sync, …) ride the shared user:<id> channel but belong to
        // the /community namespace only. Skip them here so they are NOT duplicated
        // onto /chat — the mirror filter in community.ns.ts forwards exactly these
        // (event name starts with "community:") from user:*. /chat keeps delivering
        // conv:updated for the private/group inbox bump.
        if (parsed.event.startsWith("community:")) return;

        // V2 §2.3 fix: inject conversationId into message:delete so clients can
        // route the tombstone even if the conversation isn't currently loaded.
        // The channel is always "conv:<conversationId>", so we parse it here.
        if (parsed.event === "message:delete" && pattern === "conv:*") {
          const conversationId = channel.slice("conv:".length);
          const enriched = {
            conversationId,
            ...(parsed.data as object),
          };
          void emitPersonalizedSender(chat, channel, parsed.event, enriched);
          return;
        }

        let personalizeFn: PersonalizeFn | undefined;
        // The inbox bump previews the same SYSTEM line `message:new` carries, so
        // it needs the same per-viewer rebuild — otherwise the open room reads
        // in the viewer's language while the list row above it stays in the
        // write-time English.
        if (parsed.event === "conv:updated" && pattern === "user:*") {
          personalizeFn = personalizeConvUpdatedPreview;
        }
        if (parsed.event === "message:new" && pattern === "conv:*") {
          const contentType = String(
            (parsed.data as { contentType?: string; messageType?: string })
              .contentType ??
              (parsed.data as { messageType?: string }).messageType ??
              ""
          ).toUpperCase();
          if (contentType === "SYSTEM") {
            personalizeFn = personalizeGroupSocketMessage;
          }
        }

        // Every event is delivered to the room named by the channel it was
        // published on, and reaches nobody else: `user:<id>` holds only that
        // user's own sockets (see the ROOM MODEL note at the top of this
        // namespace). This used to need a hand-maintained "self-only" denylist
        // rewriting a dozen event names onto `self:<id>`, because
        // `presence:subscribe` put watchers INTO `user:<peerId>` — which meant
        // any event NOT on the list (message:new, message:delivered,
        // message:read, read_sync, typing, …) was fanned out to every peer
        // watching the recipient's online dot. The room split removed the
        // shared room, and with it the denylist.

        // Presence is the ONE thing watchers are entitled to. It is published
        // on `user:<subjectId>` (chat-service PresenceService), so mirror it to
        // the watcher room.
        //
        // `user:account_deleted` is the second and only other mirrored event,
        // and it is mirrored for the same reason presence is: the watcher room
        // holds exactly the peers who have this user's conversation row or chat
        // header on screen, and "this account no longer exists" is a fact about
        // that row. It discloses strictly LESS than presence does — a boolean
        // and a timestamp, no name, no avatar, no online state — and it is the
        // signal that stops those peers rendering the old identity until their
        // next fetch. Nothing else is ever mirrored; adding to this list means
        // handing peer watchers data they did not subscribe to.
        // `user:profile_updated` is mirrored on exactly the same footing as
        // `user:account_deleted`: same audience (the peers rendering this
        // user's row or chat header), same signal-only payload
        // (`{ userId, updatedAt }` — no name, no avatar, no online state), and
        // it discloses strictly LESS than the presence they already subscribed
        // to. It is what stops those peers rendering the old profile picture
        // until their next fetch.
        if (
          pattern === "user:*" &&
          (parsed.event === "presence:status" ||
            parsed.event === "user:account_deleted" ||
            parsed.event === "user:profile_updated")
        ) {
          chat
            .to(`presence:${channel.slice("user:".length)}`)
            .emit(parsed.event, parsed.data);
        }

        const callData = parsed.data as
          | { callId?: unknown; reason?: unknown }
          | null
          | undefined;
        const shouldMirrorJoinCallRoom =
          pattern === "self:*" &&
          typeof callData?.callId === "string" &&
          (parsed.event === "call:outgoing_mirror" ||
            (parsed.event === "call:handled" &&
              callData.reason === "answered_elsewhere"));
        if (shouldMirrorJoinCallRoom) {
          void chat.in(channel).socketsJoin(`call:${callData.callId}`);
        }

        // Presence subscriptions are authorized at `presence:subscribe` time,
        // so a socket that joined `presence:<subjectId>` while it was allowed
        // keeps hearing that user's presence forever — including after they set
        // whoCanSeeOnlineStatus to NO_ONE/FRIENDS, or unfriended/blocked the
        // watcher. Both of those changes already publish on `user:<subjectId>`,
        // so re-authorize the room's watchers here: the revocation lands on the
        // same event that caused it, with no client action needed.
        // A Settings → Chat switch just moved: drop the cached typing /
        // read-receipt flags for that user so the next typing burst or receipt
        // is judged on the new value instead of up to a minute of stale cache.
        // Every gateway instance psubscribes `user:*`, so this reaches all of
        // their in-process caches, not just the one that served the PATCH.
        if (pattern === "user:*" && parsed.event === "settings:updated") {
          userClient.invalidateChatFlags?.(channel.slice("user:".length));
        }

        if (
          pattern === "user:*" &&
          (parsed.event === "settings:updated" ||
            parsed.event === "friend:removed" ||
            parsed.event === "friend:blocked" ||
            // Widening halves of the same coin: under a FRIENDS scope, becoming
            // friends (or being unblocked) GRANTS presence that was previously
            // denied. Without these the new friend stays grey until they
            // reconnect — the mirror image of the stale-green-dot bug.
            parsed.event === "friend:accepted" ||
            parsed.event === "friend:unblocked")
        ) {
          void resyncPresenceWatchers(channel.slice("user:".length));
          // Friendship changes are symmetric: they move BOTH users' visibility,
          // but the event lands on one channel per publish (and `friend:blocked`
          // is published to the BLOCKER only, since blocking is silent to the
          // blocked party). Resync the counterpart from the payload too, or one
          // side of every pair keeps a stale view.
          const peer = parsed.data as {
            targetUserId?: unknown;
            otherUserId?: unknown;
            requesterId?: unknown;
            addresseeId?: unknown;
          } | null;
          const subjectId = channel.slice("user:".length);
          for (const candidate of [
            peer?.targetUserId,
            peer?.otherUserId,
            peer?.requesterId,
            peer?.addresseeId,
          ]) {
            if (typeof candidate === "string" && candidate !== subjectId) {
              void resyncPresenceWatchers(candidate);
            }
          }
        }

        // `call:handled` means "another of YOUR devices dealt with this ring", and
        // it is addressed to the whole user — including the device that dealt with
        // it, which must not dismiss its own live call. Deliver it to every leg
        // except that one, and never leak the leg id to clients.
        const handledByLegId = (
          parsed.data as { handledByLegId?: unknown } | null | undefined
        )?.handledByLegId;
        if (
          parsed.event === "call:handled" &&
          typeof handledByLegId === "string"
        ) {
          const { handledByLegId: _omit, ...payload } = parsed.data as Record<
            string,
            unknown
          >;
          void (async () => {
            try {
              const sockets = await chat.in(channel).fetchSockets();
              for (const s of sockets) {
                if (s.data.callLegId === handledByLegId) continue;
                s.emit(parsed.event, payload);
              }
            } catch (err) {
              logger.warn(`/chat call:handled fan-out failed: ${String(err)}`);
            }
          })();
          return;
        }

        // Honor an envelope-level excludeUserId on conv:* broadcasts only —
        // the removal path sets it so the banned/kicked target's own sockets
        // are skipped while every remaining member still gets the event.
        const excludeUserId =
          pattern === "conv:*" && typeof parsed.excludeUserId === "string"
            ? parsed.excludeUserId
            : undefined;

        // Reciprocity for Settings → Chat → Read Receipt: chat-service already
        // withholds the receipt of a READER who switched it off; this drops it
        // for a VIEWER who did. It has to happen here, not at publish time — one
        // `message:read` reaches many viewers with different settings.
        const skipViewer =
          parsed.event === "message:read"
            ? (viewerUserId: string) =>
                viewerHidesReadReceipts(userClient, viewerUserId)
            : undefined;

        // Fast path for the receipt that actually flips the sender's tick.
        // chat-service publishes every `message:read` straight to each other
        // participant's `user:<id>` as well as to `conv:<roomId>`, and a
        // `user:<id>` room holds exactly ONE viewer — so the reciprocity
        // check above can be answered once, up front, and the event go out as
        // a plain room emit. Routing it through `emitPersonalizedSender` with
        // `skipViewer` made `message:read` the only chat event that had to
        // `fetchSockets()` (a Redis round trip, 5s cluster timeout, and on
        // that timeout a SILENT drop with no fallback) before a single byte
        // reached the sender. The `conv:*` copy still takes the per-socket
        // path below, since that room mixes viewers with different settings.
        if (parsed.event === "message:read" && pattern === "user:*") {
          const viewerUserId = channel.slice("user:".length);
          void viewerHidesReadReceipts(userClient, viewerUserId).then(
            (hides) => {
              if (!hides) chat.to(channel).emit(parsed.event, parsed.data);
            }
          );
          return;
        }

        void emitPersonalizedSender(
          chat,
          channel,
          parsed.event,
          parsed.data,
          personalizeFn,
          excludeUserId,
          skipViewer
        );

        // Pin state is published to `conv:<roomId>` only, but that Socket.IO
        // room holds just the sockets that called `conv:join` — i.e. the ONE
        // conversation each tab currently has open. Every other device, tab and
        // sidebar of the same members therefore never learned about a pin until
        // a refetch. Mirror it onto each participant's `user:<id>` channel, the
        // same room the roster events (`group:member:updated`) already use, so
        // the pinned banner and the row's `pinnedCount` update everywhere.
        // Members already in `conv:<roomId>` get it twice; the client's pin
        // handler is idempotent (it assigns the single active pin id), so the
        // duplicate is cheaper than a per-socket room-membership scan.
        if (pattern === "conv:*" && parsed.event === "pin:updated") {
          const pinRoomId = channel.slice("conv:".length);
          void (async () => {
            try {
              const { userIds } = await messagingClient.getRoomParticipantIds({
                conversationId: pinRoomId,
                conversationType: pinRoomId.startsWith("grp_")
                  ? "group"
                  : "private",
              });
              for (const uid of userIds) {
                chat.to(`user:${uid}`).emit(parsed.event, parsed.data);
              }
            } catch (pinErr) {
              logger.warn(
                `/chat pin:updated user-channel mirror failed roomId=${pinRoomId}: ${String(pinErr)}`
              );
            }
          })();
        }

        // Auto-join the conversation room when the user is added to a new
        // group while their socket is connected, so they immediately receive
        // message:new/typing for that group without a reconnect or conv:join.
        // Mirrors community.ns.ts's community-typing auto-join on community:added.
        if (parsed.event === "group:added") {
          const addedData = parsed.data as
            | { roomId?: string }
            | null
            | undefined;
          const newRoomId = addedData?.roomId;
          if (newRoomId) {
            void (async () => {
              try {
                const sockets = await chat.in(channel).fetchSockets();
                await Promise.all(
                  sockets.map((s) => s.join(`conv:${newRoomId}`))
                );
                logger.debug(
                  `/chat auto-joined conv:${newRoomId} for ${sockets.length} socket(s) of userId=${channel.slice("user:".length)}`
                );
              } catch (joinErr) {
                logger.warn(
                  `/chat auto-join conv room on group:added failed roomId=${newRoomId}: ${String(joinErr)}`
                );
              }
            })();
          }
        }

        // Mirror of the group:added auto-join above, in reverse: force every
        // live socket of a member who just left/was kicked/was banned OUT of
        // conv:<roomId>. Without this, a socket that had already called
        // conv:join keeps sitting in the Socket.IO room forever — nothing else
        // ever calls conv:leave for them — so they'd keep receiving live
        // message:new/recording broadcasts for a group they can no longer read
        // or write to.
        if (parsed.event === "group:removed") {
          const removedData = parsed.data as
            | { roomId?: string }
            | null
            | undefined;
          const removedRoomId = removedData?.roomId;
          if (removedRoomId) {
            const removedUserId = channel.slice("user:".length);
            void (async () => {
              try {
                const sockets = await chat.in(channel).fetchSockets();
                await Promise.all(
                  sockets.map((s) => s.leave(`conv:${removedRoomId}`))
                );
                logger.debug(
                  `/chat evicted conv:${removedRoomId} for ${sockets.length} socket(s) of userId=${removedUserId}`
                );
              } catch (leaveErr) {
                logger.warn(
                  `/chat evict conv room on group:removed failed roomId=${removedRoomId}: ${String(leaveErr)}`
                );
              }
            })();

            // Clear any stale typing/recording indicator the removed member
            // left behind — mirrors community.ns.ts's evict-on-removal. Group
            // typing is delivered DIRECTLY to each remaining member's
            // user:<id> (room-independent, see the typing handler below), so
            // clearing it needs the roster; recording rides conv:<roomId>
            // directly, which the still-subscribed remaining members are in.
            void (async () => {
              try {
                const stopPayload = buildTypingBroadcast(
                  removedUserId,
                  {
                    userId: removedUserId,
                    username: "",
                    displayName: "",
                    avatarUrl: null,
                  },
                  removedRoomId,
                  Date.now(),
                  {}
                );
                chat
                  .to(`conv:${removedRoomId}`)
                  .emit("recording:stop", stopPayload);

                const { userIds } = await messagingClient.getRoomParticipantIds(
                  {
                    conversationId: removedRoomId,
                    conversationType: "group",
                  }
                );
                for (const uid of userIds) {
                  if (uid === removedUserId) continue;
                  chat.to(`user:${uid}`).emit("typing:stop", stopPayload);
                }
              } catch (stopErr) {
                logger.warn(
                  `/chat clear typing/recording on group:removed failed roomId=${removedRoomId}: ${String(stopErr)}`
                );
              }
            })();
          }
        }
      } catch (err) {
        logger.warn(
          `/chat Redis message parse error on ${channel}: ${String(err)}`
        );
      }
    }
  );

  const MessageForwardSchemaBase = z.object({
    messageId: z.string().min(1),
    targetConversationId: z.string().min(1),
    clientMessageId: z.string().min(1),
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
    receiverId: z.string().optional(),
    senderName: z.string().optional(),
    senderAvatar: z.string().optional(),
  });
  const MessageReactionsGetSchemaBase = z.object({
    messageId: z.string().min(1),
    conversationId: z.string().min(1),
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
  });
  const MessageEditSchemaBase = z.object({
    messageId: z.string().min(1),
    conversationId: z.string().min(1),
    contentText: z.string().max(MAX_TEXT_LEN).optional(),
    contentJson: z.string().max(MAX_JSON_LEN).optional(),
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
  });
  const MessageDeliveredSchemaBase = z.object({
    conversationId: z.string().min(1),
    upToMessageId: z.string().min(1),
  });
  // Parity with /community's community:message:delete / pin / unpin — private/
  // group previously had no socket RPC for these (REST-only).
  const MessageDeleteSchemaBase = z.object({
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    type: z.enum(["forMe", "forEveryone"]).default("forMe"),
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
  });
  const MessagePinSchemaBase = z.object({
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    conversationType: z.preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["private", "group"]).default("private")
    ),
  });
  const MessageForwardSchema = withCommunityAliases(MessageForwardSchemaBase);
  const MessageReactionsGetSchema = withCommunityAliases(
    MessageReactionsGetSchemaBase
  );
  const MessageEditSchema = withCommunityAliases(MessageEditSchemaBase);
  const MessageDeliveredSchema = withCommunityAliases(
    MessageDeliveredSchemaBase
  );
  const MessageDeleteSchema = withCommunityAliases(MessageDeleteSchemaBase);
  const MessagePinSchema = withCommunityAliases(MessagePinSchemaBase);

  const PresenceSubscribeSchema = z.object({
    peerIds: z.array(z.string().min(1)).max(500),
  });
  // Exactly one of calleeId (1:1) / groupId (group call) must be present —
  // the group branch has no privateRoomId concept, so a caller can't send both.
  const CallInitiateSchema = z
    .object({
      calleeId: z.string().min(1).optional(),
      groupId: z.string().min(1).optional(),
      callType: z.enum(["AUDIO", "VIDEO"]).default("AUDIO"),
      privateRoomId: z.string().optional(),
      legId: z.string().min(1).max(128).optional(),
    })
    .refine((v) => Boolean(v.calleeId) !== Boolean(v.groupId), {
      message: "exactly one of calleeId or groupId is required",
    });
  // `legId` identifies ONE connection of the user, not one login: two browser
  // tabs share a session (and therefore `socket.data.sessionId`), so the client
  // mints a per-page-load id and sends it here. Optional — a client that omits it
  // falls back to session granularity, which is still correct for one-tab-per-device.
  const CallAnswerSchema = z.object({
    callId: z.string().min(1),
    legId: z.string().min(1).max(128).optional(),
  });
  // `intentional: true` is required so stale HMR/zombie socket listeners that
  // still auto-emit `{ callId }` (old busy auto-decline) cannot kill a live ring.
  // Only an explicit user Decline click from a current client includes the flag.
  const CallDeclineSchema = z.object({
    callId: z.string().min(1),
    intentional: z.literal(true),
  });
  const CallEndSchema = z.object({
    callId: z.string().min(1),
    legId: z.string().min(1).max(128).optional(),
    // The caller's client reporting that its ring window elapsed rather than
    // that the user hung up. Closed enum — chat-service re-validates the call
    // state before it changes the outcome, so this can only ever pick between
    // two legitimate readings of the same hangup.
    reason: z.enum(["NO_ANSWER"]).optional(),
  });
  const CallRejoinSchema = z.object({ callId: z.string().min(1) });

  // A killed app (force-quit, OOM, crash) never sends `call:end`, and for a call
  // still RINGING the caller has not joined the LiveKit room yet — so LiveKit's
  // `participant_left` webhook cannot fire either and the row would sit open
  // until the 60s missed sweep. Detect the participant's transport disconnect
  // here, wait out a short reconnection grace, and finalize through the SAME
  // idempotent `endCall` the explicit hang-up uses.
  const CALL_DISCONNECT_GRACE_MS = Number(
    process.env.CALL_DISCONNECT_GRACE_MS ?? 15_000
  );
  const CALL_MEMBER_TTL_SEC = 4 * 60 * 60;
  const pendingCallCleanups = new Map<string, NodeJS.Timeout>();

  const rememberCallMember = (callId: string, userId: string): void => {
    redisPub
      .set(`call:member:${callId}:${userId}`, "1", "EX", CALL_MEMBER_TTL_SEC)
      .catch((err: unknown) =>
        logger.warn(`/chat call member set failed ${callId}: ${String(err)}`)
      );
  };

  const cancelCallCleanup = (callId: string, userId: string): void => {
    const key = `${callId}:${userId}`;
    const timer = pendingCallCleanups.get(key);
    if (!timer) return;
    clearTimeout(timer);
    pendingCallCleanups.delete(key);
  };

  const scheduleCallCleanup = (
    callId: string,
    userId: string,
    legId: string
  ): void => {
    const key = `${callId}:${userId}`;
    if (pendingCallCleanups.has(key)) return;
    const timer = setTimeout(() => {
      pendingCallCleanups.delete(key);
      void (async () => {
        try {
          // Adapter-aware, so a reconnect landing on ANOTHER gateway node still
          // counts as present and cancels the cleanup.
          const sockets = await chat.in(`call:${callId}`).fetchSockets();
          if (sockets.some((s) => s.data.userId === userId)) return;
          // Carries the disconnected leg: chat-service ignores an end request
          // from a callee leg that never answered, so a sibling tab closing can
          // no longer take down the call the user is actually on.
          await messagingClient.endCall({ callId, userId, legId });
          logger.info(
            `/chat call cleanup after disconnect callId=${callId} userId=${userId}`
          );
        } catch (err: unknown) {
          logger.warn(`/chat call cleanup failed ${callId}: ${String(err)}`);
        }
      })();
    }, CALL_DISCONNECT_GRACE_MS);
    timer.unref();
    pendingCallCleanups.set(key, timer);
  };

  chat.on("connection", (socket: Socket) => {
    const { userId, sessionId, locale } = socket.data;
    scopeSocketLocale(socket);
    bindSocketAuditContext(socket);
    const deviceId = sessionId ?? socket.id;
    // One socket is one call leg. `deviceId` is only session-granular (two tabs
    // share a login), so the client's per-page-load `legId` supersedes it as soon
    // as this socket initiates or answers a call — and the disconnect cleanup then
    // ends the call under the SAME leg that claimed it. On socket.data so other
    // gateway nodes can read it through `fetchSockets()`.
    socket.data.callLegId = deviceId;
    void socket.join(`user:${userId}`);
    // Private per-user room. Unlike `user:<id>` — which `presence:subscribe`
    // lets ANY peer join — only this user's own sockets are ever in `self:<id>`.
    // Call lifecycle events are routed here so a DM peer can't receive (or act
    // on) another user's call, including the LiveKit token in `call:incoming`.
    void socket.join(`self:${userId}`);
    void socket.join(`session:${sessionId}`);
    logger.debug(`/chat connected userId=${userId}`);

    // Resolve sender identity ONCE per connection (gRPC snapshot + avatar
    // presign) so every typing broadcast can carry userDetails without a
    // per-event fetch. Fire-and-forget: a safe default is set immediately and
    // the resolved value overwrites it when ready, keeping connect latency zero.
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

    // Presence is per SOCKET, not per session. `sessionId` identifies a LOGIN —
    // two browser tabs share one — so keying the device session by it made the
    // first tab to close report the whole session disconnected, and the user
    // went grey while still connected in the other tab. `socket.id` is unique
    // per connection across gateway nodes, so "any live socket" is exactly the
    // multi-device rule presence needs. `deviceId` above stays session-granular
    // because call legs genuinely are per login.
    const presenceDeviceId = socket.id;
    let socketAppState = "FOREGROUND";

    // Server-driven liveness. Clients are asked to send `presence:heartbeat`,
    // but presence must not DEPEND on their cooperation — a mobile client that
    // never heartbeats would silently expire while its socket is wide open.
    // Any traffic on the connection (including engine.io's own ping/pong, which
    // never stops while the transport is healthy) refreshes the device session,
    // throttled so this costs one gRPC call per socket per refresh window.
    let lastPresenceRefreshAt = 0;
    const refreshPresence = (appState: string, force = false): void => {
      const now = Date.now();
      if (!force && now - lastPresenceRefreshAt < PRESENCE_REFRESH_MS) return;
      lastPresenceRefreshAt = now;
      messagingClient
        .presenceHeartbeat({ userId, deviceId: presenceDeviceId, appState })
        .catch((err: unknown) =>
          logger.warn(`/chat presence refresh error: ${String(err)}`)
        );
    };

    // Mark the user online in chat-service presence (best-effort).
    if (userId) {
      const platform =
        (socket.handshake.query?.platform as string) ||
        (socket.handshake.headers["x-platform"] as string) ||
        "unknown";
      const clientType =
        (socket.handshake.query?.clientType as string) ||
        (socket.handshake.headers["x-client-type"] as string) ||
        "unknown";
      lastPresenceRefreshAt = Date.now();
      messagingClient
        .presenceConnect({
          userId,
          deviceId: presenceDeviceId,
          platform,
          clientType,
          appState: "FOREGROUND",
        })
        .catch((err: unknown) =>
          logger.warn(`/chat presence:connect error: ${String(err)}`)
        );

      // Engine.io's server-sent ping is answered by a client `pong`, which
      // arrives here — so a healthy transport keeps presence alive on its own,
      // with no cooperation from the application layer.
      const onEnginePacket = (): void => refreshPresence(socketAppState);
      socket.conn.on("packet", onEnginePacket);
      socket.on("disconnect", () => socket.conn.off("packet", onEnginePacket));
    }

    socket.on(
      "conv:join",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = ConvJoinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        // Idempotent: re-joining an already-tracked room is a no-op in Socket.IO.
        //
        // `conversationId` is CLIENT-SUPPLIED, and `conv:<roomId>` is where
        // message:new / reactions / edits / deletes / recording are broadcast —
        // so membership is checked HERE, before the join, for BOTH kinds. Only
        // GROUP used to be gated; PRIVATE joined unchecked on the theory that
        // sends are still refused downstream, which protected writes but not
        // reads: any authenticated socket could emit
        // `conv:join {conversationId: "<someone else's room>"}` and receive that
        // conversation's live traffic.
        //
        // `getRoomParticipantIds` is the same ACTIVE-roster oracle typing
        // resolves through, and it handles both kinds: an explicit "group" uses
        // the group roster, anything else looks the id up as a private room and
        // falls back to the group roster when it isn't one (so legacy clients
        // that omit `conversationType` are gated identically). It fails CLOSED —
        // an empty roster (unknown room, blocked DM, gRPC error) denies.
        void (async () => {
          try {
            const { userIds } = await messagingClient.getRoomParticipantIds({
              conversationId: r.data.conversationId,
              conversationType: r.data.conversationType ?? "private",
            });
            if (!userIds.includes(userId)) {
              ackError(callback, "FORBIDDEN", locale);
              return;
            }
            void socket.join(`conv:${r.data.conversationId}`);
            ackOk(callback, "SOCKET_CONVERSATION_JOINED", locale);
          } catch (err) {
            // Still no join — but report it as the retryable failure it is, so a
            // client that reads the ack retries instead of treating a
            // chat-service blip as a permanent denial. (A roster the service
            // returns EMPTY is a verdict, not an outage, and stays FORBIDDEN.)
            logger.warn(
              `/chat conv:join membership check failed roomId=${r.data.conversationId}: ${String(err)}`
            );
            ackError(callback, "SERVICE_ERROR", locale);
          }
        })();
      }
    );

    socket.on(
      "conv:leave",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = ConvLeaveSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        // Idempotent: leaving a room the socket is not in is a no-op.
        // Clients may call leave on reconnect clean-up even if the prior session
        // already left — that is safe.
        void socket.leave(`conv:${r.data.conversationId}`);
        ackOk(callback, "SOCKET_CONVERSATION_LEFT", locale);
      }
    );

    socket.on(
      "message:send",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageSendSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        const files = [...(r.data.files ?? [])];
        if (r.data.mediaKey && !files.some((f) => f.objectKey)) {
          files.push({
            objectKey: r.data.mediaKey,
            name: "",
            size: 0,
            mime: "",
          });
        }
        const content = {
          text: r.data.contentText ?? "",
          urls: r.data.urls ?? [],
          files,
          ...(r.data.location ? { location: r.data.location } : {}),
          ...(r.data.contact ? { contact: r.data.contact } : {}),
          ...(r.data.sticker ? { sticker: r.data.sticker } : {}),
        };
        messagingClient
          .sendMessage({
            ...r.data,
            senderId: userId,
            contentJson: JSON.stringify(content),
            conversationType: r.data.conversationType,
            receiverId: r.data.receiverId ?? "",
            senderName: r.data.senderName ?? "",
            senderAvatar: r.data.senderAvatar ?? "",
          })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_SENT", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:send gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "message:read",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageReadSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .markMessagesRead({ ...r.data, readerId: userId })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_READ", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:read gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "message:react",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageReactSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .sendReaction({ ...r.data, userId })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_REACTED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:react gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "messages:fetch",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessagesFetchSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .getConversationMessages({ ...r.data, requesterId: userId })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGES_FETCHED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat messages:fetch gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // Reconnect gap-fill: fetch missed messages per room since a known seq.
    socket.on(
      "chat:catchup",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const parsed = CatchupSchema.safeParse(payload);
        if (!parsed.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const rooms = parsed.data.rooms;
          const results = await Promise.allSettled(
            rooms.map((room) =>
              messagingClient.catchupRoom({
                conversationId: room.roomId,
                requesterId: userId,
                sinceSeq: room.sinceSeq,
                limit: room.limit ?? 100,
                conversationType: room.conversationType,
                // Only forward when the client opted in (undefined ⇒ the client
                // sends the -1 "not revision mode" sentinel; 0 IS a valid cold start).
                sinceRevision: room.sinceRevision,
              })
            )
          );

          const ackRooms: Array<{
            roomId: string;
            hasMore: boolean;
            lastSeq: number;
            authorized: boolean;
            lastRevision: number;
            roomRevision: number;
            resetRequired: boolean;
          }> = [];

          results.forEach((res, idx) => {
            const room = rooms[idx]!;
            if (res.status === "fulfilled") {
              const r = res.value;
              socket.emit("chat:catchup:result", {
                roomId: room.roomId,
                // Normalize the thin gRPC CatchupEventDto back to the same
                // canonical shape as live message:new. Without this, reconnect
                // gap-fill rows have no `id`/`content`, so DM SYSTEM call audit
                // entries (and ordinary text) cannot render until a full reload.
                events: r.events.map((event) =>
                  normalizeCatchupEvent(event, room.conversationType)
                ),
                hasMore: r.hasMore,
                lastSeq: Number(r.lastSeq),
                // Zero-loss revision-mode fields (0/false in sinceSeq mode).
                lastRevision: Number(r.lastRevision ?? 0),
                roomRevision: Number(r.roomRevision ?? 0),
                resetRequired: Boolean(r.resetRequired),
              });
              ackRooms.push({
                roomId: room.roomId,
                hasMore: r.hasMore,
                lastSeq: Number(r.lastSeq),
                authorized: r.authorized,
                lastRevision: Number(r.lastRevision ?? 0),
                roomRevision: Number(r.roomRevision ?? 0),
                resetRequired: Boolean(r.resetRequired),
              });
            } else {
              logger.warn(
                `/chat chat:catchup gRPC error for room ${room.roomId}: ${String(
                  res.reason
                )}`
              );
            }
          });

          ackOk(callback, "SOCKET_CATCHUP_COMPLETED", locale, {
            rooms: ackRooms,
          });
        })();
      }
    );

    // Feature 13: Edit message
    socket.on(
      "message:edit",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageEditSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .editMessage({ ...r.data, editorId: userId })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_EDITED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:edit gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // Feature 15: Delivered receipts (client emits on receiving message:new)
    socket.on(
      "message:delivered",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageDeliveredSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .markDelivered({ ...r.data, recipientId: userId })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_DELIVERED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:delivered gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // Feature 18/19: Presence heartbeat + peer subscription.
    //
    // The client heartbeat is now only about APP STATE (foreground/background).
    // Liveness itself is server-driven (see refreshPresence above), so a client
    // that stops beating no longer goes grey while its socket is still open,
    // and a client that keeps beating after its process died cannot happen.
    // An app-state CHANGE is forced through immediately — backgrounding is a
    // real presence input, not a keepalive, and must not be swallowed by the
    // refresh throttle.
    socket.on("presence:heartbeat", (payload: unknown) => {
      const appState =
        (payload as { appState?: string } | undefined)?.appState ??
        "FOREGROUND";
      const changed = appState !== socketAppState;
      socketAppState = appState;
      refreshPresence(appState, changed);
    });

    socket.on(
      "presence:subscribe",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = PresenceSubscribeSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        // `whoCanSeeOnlineStatus` gate. Joining `presence:<peerId>` is what
        // makes a peer's presence reachable, so the filter has to happen BEFORE
        // the join — masking on emit would be too late. Denied peers are
        // silently dropped rather than erroring: a per-peer rejection would
        // itself disclose the setting.
        void (async () => {
          // Record the INTENT to watch each peer, allowed or not. Nothing is
          // ever published to `presence-intent:*` — it exists so a later
          // widening (NO_ONE → EVERYONE, or becoming friends) can find the
          // sockets that asked and grant them, without the client
          // re-subscribing.
          for (const peerId of r.data.peerIds) {
            void socket.join(`presence-intent:${peerId}`);
          }
          const visible = await userClient.filterVisiblePresence(
            userId,
            r.data.peerIds
          );
          for (const peerId of visible) {
            // NEVER `user:<peerId>` — that room carries the peer's private
            // message/read/typing/inbox stream, not just their online dot.
            void socket.join(`presence:${peerId}`);
          }
          // The ack CARRIES the current state, it does not merely confirm the
          // join. Socket events are delivery, not durable state: a client that
          // was disconnected while a peer flipped would otherwise sit on a
          // stale dot until the peer flipped AGAIN. Subscribing is exactly the
          // moment to reconcile, and it costs one pipelined Redis read — no
          // extra REST round trip, and nothing to invalidate on reconnect.
          const snapshots = await readPresenceSnapshots(redisPub, visible);
          ackOk(callback, "SOCKET_PRESENCE_SUBSCRIBED", locale, {
            subscribedCount: visible.length,
            statuses: [...snapshots.values()],
          });
        })();
      }
    );

    socket.on(
      "presence:unsubscribe",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = PresenceSubscribeSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        for (const peerId of r.data.peerIds) {
          void socket.leave(`presence:${peerId}`);
          // Drop the intent too, or a later widening would silently re-grant a
          // subscription the client explicitly gave up.
          void socket.leave(`presence-intent:${peerId}`);
        }
        ackOk(callback, "SOCKET_PRESENCE_UNSUBSCRIBED", locale);
      }
    );

    // Gap #6: bulk-clear all peer presence subscriptions in one call.
    socket.on(
      "presence:unsubscribe_all",
      (_payload: unknown, callback?: (res: unknown) => void) => {
        let unsubscribedCount = 0;
        for (const room of socket.rooms) {
          // Leave every presence:* watch room. `user:<self>` is this socket's
          // own delivery room and is never a subscription, so it is untouched.
          if (room.startsWith("presence:")) {
            void socket.leave(room);
            unsubscribedCount++;
          }
          // Intents go with them — see `presence:unsubscribe`.
          if (room.startsWith("presence-intent:")) {
            void socket.leave(room);
          }
        }
        ackOk(callback, "SOCKET_PRESENCE_UNSUBSCRIBED_ALL", locale, {
          unsubscribedCount,
        });
      }
    );

    // Gap #6: query which peers this socket is currently tracking.
    socket.on(
      "presence:list",
      (_payload: unknown, callback?: (res: unknown) => void) => {
        const peerIds: string[] = [];
        for (const room of socket.rooms) {
          if (room.startsWith("presence:")) {
            peerIds.push(room.slice("presence:".length));
          }
        }
        ackOk(callback, "SOCKET_PRESENCE_LIST_FETCHED", locale, { peerIds });
      }
    );

    // session:expired warning + auth:refresh — shared helper handles the 5-min
    // warn timer, 60-s grace disconnect, and token-refresh event registration.
    const {
      clearSessionTimers,
      scheduleSessionTimers,
      registerAuthRefreshHandler,
    } = createSessionTimers(socket, locale, "/chat", env.AUTH_SERVICE_URL);

    if (socket.data.tokenExpiresAt > 0) {
      scheduleSessionTimers(socket.data.tokenExpiresAt);
    }
    registerAuthRefreshHandler();

    // ── Typing indicator ────────────────────────────────────────────────────
    // Fire-and-forget (no ack). Timer/TTL/flush mechanics live in the shared
    // presence-indicator engine — the same instance /community uses.
    //
    // ROOM-INDEPENDENT, matching /community: recipients are resolved from the
    // room's participant roster and reached through their `user:<id>` sockets,
    // so a peer receives the indicator whether or not they ever sent
    // conv:join. This also closes the gap where /chat performed NO
    // authorization at all — conv:join has no membership oracle, so any
    // authenticated socket could previously join `conv:<anyRoomId>` and inject
    // a fake typing indicator into a DM or group it was not part of. The
    // roster now gates the sender, exactly as community's active-member list
    // does. Fail-closed: an empty/failed roster suppresses the event.
    //
    // The wire event names (`typing:start` / `typing:stop`) and the payload
    // (buildTypingBroadcast) are unchanged — shipped clients see no difference.
    const typingPayload = (conversationId: string, senderName?: string) =>
      buildTypingBroadcast(
        userId,
        socket.data.userDetails,
        conversationId,
        Date.now(),
        { senderName }
      );

    // Remembers what the client last told us about a room, so the TTL-expiry
    // and disconnect-flush stops — which carry no client payload — resolve the
    // roster through the same branch the start did and keep the same
    // senderName fallback in the payload.
    const typingHints = new Map<
      string,
      { kind: "private" | "group"; senderName?: string }
    >();

    const typing = createPresenceIndicator({
      startEvent: "typing:start",
      stopEvent: "typing:stop",
      canStart: async () =>
        (await userClient.getChatFlags(userId)).typingIndicators,
      broadcast: createDirectRosterBroadcast({
        namespace: chat,
        senderId: userId,
        resolveRoster: async (conversationId) => {
          try {
            const { userIds, mutedUserIds } =
              await messagingClient.getRoomParticipantIds({
                conversationId,
                conversationType:
                  typingHints.get(conversationId)?.kind ?? "private",
              });
            // A GROUP member under a moderation mute cannot send, so they must
            // not be able to broadcast "…is typing" either (Scenario 1).
            // Returning an empty roster drops the event: createDirectRosterBroadcast
            // treats roster-membership as the sender's authorization. The muted
            // member is NOT removed from `userIds` for anyone else's broadcast,
            // so they keep RECEIVING peers' indicators — mute restricts sending
            // only. `mutedUserIds` is always empty for PRIVATE.
            if (mutedUserIds?.includes(userId)) return [];
            return userIds;
          } catch (err) {
            logger.warn(
              `/chat typing: failed to resolve participants conversationId=${conversationId}: ${String(err)}`
            );
            return [];
          }
        },
        buildPayload: (conversationId) =>
          typingPayload(
            conversationId,
            typingHints.get(conversationId)?.senderName
          ),
        // Reciprocal: a peer who turned their own indicator off doesn't see mine.
        filterRecipients: typingViewerFilter(userClient),
      }),
    });

    const rememberTypingHint = (d: {
      conversationId: string;
      conversationType: "private" | "group";
      senderName?: string;
    }): void => {
      typingHints.set(d.conversationId, {
        kind: d.conversationType,
        senderName: d.senderName,
      });
    };

    socket.on("typing:start", (payload: unknown) => {
      const r = TypingSchema.safeParse(payload);
      if (!r.success) return;
      rememberTypingHint(r.data);
      typing.start(r.data.conversationId);
    });

    socket.on("typing:stop", (payload: unknown) => {
      const r = TypingSchema.safeParse(payload);
      if (!r.success) return;
      rememberTypingHint(r.data);
      typing.stop(r.data.conversationId);
    });

    // ── Voice recording presence ────────────────────────────────────────────
    // Same shared engine, room-based delivery — identical to /community's
    // recording indicator, which also stayed room-based when typing moved to
    // direct delivery.
    //
    // isAuthorized mirrors community's isAuthorizedForCommunity: a cheap sync
    // check that the sender's OWN socket currently sits in conv:<id>. Without
    // it, socket.to(room) would happily broadcast (and accept) a recording
    // indicator for a group the sender left or was never in — conv:join is
    // membership-gated for groups and group:removed force-leaves the room on
    // leave/kick/ban (see conv:join handler above), so "currently in the room"
    // is already the authoritative membership signal; no extra gRPC call
    // needed here.
    const recordingNames = new Map<string, string | undefined>();

    const recording = createPresenceIndicator({
      startEvent: "recording:start",
      stopEvent: "recording:stop",
      broadcast: createRoomBroadcast({
        namespace: chat,
        socket,
        rooms: (conversationId) => [`conv:${conversationId}`],
        buildPayload: (conversationId) =>
          buildTypingBroadcast(
            userId,
            socket.data.userDetails,
            conversationId,
            Date.now(),
            { senderName: recordingNames.get(conversationId) }
          ),
        // Both kinds consult the same roster typing uses. PRIVATE: it returns
        // an empty roster once either side has blocked the other, so a blocked
        // DM never leaks a "recording…" indicator in either direction. GROUP:
        // membership is already proven by the conv:<id> room check, but the
        // roster also reports who is moderation-muted — a muted member must
        // not advertise recording, since they cannot send the voice note.
        // One gRPC call per recording start/stop (not per keystroke).
        isAuthorized: async (conversationId) => {
          if (!socket.rooms.has(`conv:${conversationId}`)) return false;
          const kind = typingHints.get(conversationId)?.kind ?? "private";
          try {
            const { userIds, mutedUserIds } =
              await messagingClient.getRoomParticipantIds({
                conversationId,
                conversationType: kind,
              });
            // Voice-note recording is a send action — a muted member must not
            // advertise it (GROUP only; mutedUserIds is empty for PRIVATE).
            if (mutedUserIds?.includes(userId)) return false;
            // GROUP membership is already proven by the conv:<id> room check
            // above; only PRIVATE needs the block-aware roster membership test.
            return kind === "group" || userIds.includes(userId);
          } catch (err) {
            logger.warn(
              `/chat recording: failed to resolve participants conversationId=${conversationId}: ${String(err)}`
            );
            return false;
          }
        },
      }),
    });

    socket.on("recording:start", (payload: unknown) => {
      const r = TypingSchema.safeParse(payload);
      if (!r.success) return;
      recordingNames.set(r.data.conversationId, r.data.senderName);
      rememberTypingHint(r.data);
      recording.start(r.data.conversationId);
    });

    socket.on("recording:stop", (payload: unknown) => {
      const r = TypingSchema.safeParse(payload);
      if (!r.success) return;
      recordingNames.set(r.data.conversationId, r.data.senderName);
      rememberTypingHint(r.data);
      recording.stop(r.data.conversationId);
    });

    // Feature 1: Forward message
    socket.on(
      "message:forward",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageForwardSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .forwardMessage({
            messageId: r.data.messageId,
            targetConversationId: r.data.targetConversationId,
            senderId: userId,
            receiverId: r.data.receiverId ?? "",
            clientMessageId: r.data.clientMessageId,
            conversationType: r.data.conversationType,
            senderName: r.data.senderName ?? "",
            senderAvatar: r.data.senderAvatar ?? "",
          })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_FORWARDED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:forward gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // Delete a message (for me / for everyone) over the socket — parity with
    // /community's community:message:delete. Broadcast (message:delete on
    // conv:<id>) is published by the gRPC handler via the shared orchestrator,
    // same as the REST delete endpoint.
    socket.on(
      "message:delete",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageDeleteSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .deleteMessage({
            conversationId: r.data.conversationId,
            messageId: r.data.messageId,
            userId,
            deleteType: r.data.type,
            conversationType: r.data.conversationType,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_DELETED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:delete gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // Pin/unpin a message over the socket — parity with /community's
    // community:message:pin/unpin.
    socket.on(
      "message:pin",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessagePinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .pinMessage({
            conversationId: r.data.conversationId,
            messageId: r.data.messageId,
            userId,
            conversationType: r.data.conversationType,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_PINNED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:pin gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "message:unpin",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessagePinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .unpinMessage({
            conversationId: r.data.conversationId,
            messageId: r.data.messageId,
            userId,
            conversationType: r.data.conversationType,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_MESSAGE_UNPINNED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat message:unpin gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // Feature 2: Get reaction users
    socket.on(
      "message:reactions:get",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = MessageReactionsGetSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .getMessageReactions({ ...r.data, requesterId: userId })
          .then((result) =>
            ackOk(callback, "SOCKET_REACTIONS_FETCHED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(
              `/chat message:reactions:get gRPC error: ${String(err)}`
            );
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // Feature 4: Call signaling

    /**
     * Ring-bomb brake. `initiateCall` cancels the caller's own RINGING rows as part
     * of its self-cleanup, so the busy gate never stops a caller from re-ringing the
     * same victim in a tight loop. The HTTP rate limiter can't help: it never sees
     * Socket.IO frames, and it is skipped outright in development. Same
     * incr+expire+fail-open shape as the /stream comment limiter.
     */
    // Returns the remaining TTL in seconds when rate-limited, false otherwise.
    const isCallInitiateRateLimited = async (): Promise<number | false> => {
      const key = `rl:call-initiate:${userId}`;
      try {
        const count = await redisPub.incr(key);
        if (count === 1) {
          await redisPub.expire(key, CALL_INITIATE_RATE_WINDOW_SEC);
        }
        if (count > CALL_INITIATE_RATE_MAX) {
          const ttl = await redisPub.ttl(key);
          return Math.max(1, ttl);
        }
        return false;
      } catch {
        return false; // fail open
      }
    };

    socket.on(
      "call:initiate",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CallInitiateSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const rateLimitedTtl = await isCallInitiateRateLimited();
          if (rateLimitedTtl !== false) {
            ackError(
              callback,
              "RATE_LIMITED",
              locale,
              undefined,
              rateLimitedTtl
            );
            return;
          }
          socket.data.callLegId = r.data.legId ?? deviceId;
          messagingClient
            .initiateCall({
              callerId: userId,
              calleeId: r.data.calleeId ?? "",
              type: r.data.callType,
              privateRoomId: r.data.privateRoomId,
              groupId: r.data.groupId,
            })
            .then((result) => {
              // Join the caller's socket to `call:<callId>` so lifecycle events
              // (call:answered / call:declined / call:ended) reach them.
              void socket.join(`call:${result.callId}`);
              rememberCallMember(result.callId, userId);
              ackOk(callback, "SOCKET_CALL_INITIATED", locale, {
                callId: result.callId,
                status: result.status,
                livekitUrl: result.livekit?.url,
                token: result.livekit?.token,
              });
            })
            .catch((err: unknown) => {
              logger.warn(`/chat call:initiate gRPC error: ${String(err)}`);
              const { code, detailKey } = resolveGrpcAckError(err);
              ackError(callback, code, locale, detailKey);
            });
        })();
      }
    );

    socket.on(
      "call:answer",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CallAnswerSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        socket.data.callLegId = r.data.legId ?? deviceId;
        messagingClient
          .answerCall({
            callId: r.data.callId,
            calleeId: userId,
            legId: socket.data.callLegId,
            // Excludes this device from the backstop push only. `legId` already
            // excludes it on the socket fan-out; the push queue cannot carry a
            // leg, and device tokens are keyed by session anyway.
            sessionId,
          })
          .then((result) => {
            // Callee joins `call:<callId>` on answer — mirrors the caller's
            // join at initiate. Both peers now receive `call:ended` etc.
            void socket.join(`call:${result.callId}`);
            rememberCallMember(result.callId, userId);
            ackOk(callback, "SOCKET_CALL_ANSWERED", locale, {
              callId: result.callId,
              status: result.status,
              livekitUrl: result.livekit?.url,
              token: result.livekit?.token,
            });
          })
          .catch((err: unknown) => {
            logger.warn(`/chat call:answer gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "call:decline",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CallDeclineSchema.safeParse(payload);
        if (!r.success) {
          // Likely a zombie HMR listener still doing busy auto-decline with
          // `{ callId }` only — do not forward to chat-service.
          logger.warn(
            `/chat call:decline rejected (need intentional:true) userId=${userId} payload=${JSON.stringify(payload)}`
          );
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        logger.info(
          `/chat call:decline userId=${userId} callId=${r.data.callId} socket=${socket.id}`
        );
        messagingClient
          .declineCall({
            callId: r.data.callId,
            calleeId: userId,
            // See the answerCall call above — push-exclusion for this device.
            sessionId,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_CALL_DECLINED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat call:decline gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    socket.on(
      "call:end",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CallEndSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        messagingClient
          .endCall({
            callId: r.data.callId,
            userId,
            legId: r.data.legId ?? socket.data.callLegId,
            reason: r.data.reason,
            // See the answerCall call above — push-exclusion for this device.
            sessionId,
          })
          .then((result) =>
            ackOk(callback, "SOCKET_CALL_ENDED", locale, result)
          )
          .catch((err: unknown) => {
            logger.warn(`/chat call:end gRPC error: ${String(err)}`);
            const { code, detailKey } = resolveGrpcAckError(err);
            ackError(callback, code, locale, detailKey);
          });
      }
    );

    // Re-entry into `call:<id>` after a transport reconnect. Authorized against
    // the membership key written when this user initiated/answered THAT call, so
    // no new callId is minted and no peer can join a call they were never in.
    socket.on(
      "call:rejoin",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = CallRejoinSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        const { callId } = r.data;
        void (async () => {
          const isMember = await redisPub
            .get(`call:member:${callId}:${userId}`)
            .catch(() => null);
          if (!isMember) {
            ackError(callback, "FORBIDDEN", locale);
            return;
          }
          cancelCallCleanup(callId, userId);
          void socket.join(`call:${callId}`);
          ackOk(callback, "SOCKET_CALL_REJOINED", locale, { callId });
        })();
      }
    );

    // Note: `call:ice` was removed with the LiveKit migration — LiveKit's
    // client SDKs handle ICE/NAT internally. See Docs/calls/CALLS-LIVEKIT.md.

    // ── Friend management ────────────────────────────────────────────────────
    // Gateway calls user-service REST endpoints on behalf of the authenticated
    // user (forwarding their JWT), then publishes real-time notifications to
    // the target's user:* Redis channel for immediate socket fan-out.

    const userSvcBase = env.USER_SERVICE_URL
      ? `${env.USER_SERVICE_URL}/api/v1/users/friends`
      : null;

    const callUserSvc = async (
      method: string,
      path: string,
      body?: object
    ): Promise<{ ok: boolean; status: number; data: unknown }> => {
      if (!userSvcBase) return { ok: false, status: 503, data: null };
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${userSvcBase}${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${socket.data.accessToken}`,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const json = (await res.json().catch(() => null)) as { data?: unknown };
        return { ok: res.ok, status: res.status, data: json?.data ?? null };
      } catch {
        clearTimeout(timeoutId);
        return { ok: false, status: 500, data: null };
      }
    };

    // Realtime friend:* fan-out (all logged-in devices, both parties) is
    // published centrally by user-service after every DB mutation — see
    // `apps/user-service/src/lib/friend-socket.ts` — so it fires identically
    // whether the client called this RPC or the REST API directly. These
    // handlers are thin proxies only; they must NOT also publish, or every
    // socket-originated action would double-emit.
    socket.on(
      "friend.request",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = FriendRequestSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const result = await callUserSvc("POST", "/requests", {
            addresseeId: r.data.addresseeId,
          });
          if (!result.ok) {
            ackError(
              callback,
              result.status === 409 ? "CONFLICT" : "SERVICE_ERROR",
              locale
            );
            return;
          }
          const reqData = result.data as { id?: string } | null;
          ackOk(callback, "SOCKET_FRIEND_REQUEST_SENT", locale, {
            requestId: reqData?.id,
          });
        })();
      }
    );

    socket.on(
      "friend.accept",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = FriendAcceptSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const result = await callUserSvc(
            "POST",
            `/requests/${r.data.requestId}/accept`
          );
          if (!result.ok) {
            ackError(
              callback,
              result.status === 404 ? "NOT_FOUND" : "SERVICE_ERROR",
              locale
            );
            return;
          }
          ackOk(callback, "SOCKET_FRIEND_REQUEST_ACCEPTED", locale);
        })();
      }
    );

    socket.on(
      "friend.reject",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = FriendRejectSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const result = await callUserSvc(
            "POST",
            `/requests/${r.data.requestId}/reject`
          );
          if (!result.ok) {
            ackError(
              callback,
              result.status === 404 ? "NOT_FOUND" : "SERVICE_ERROR",
              locale
            );
            return;
          }
          ackOk(callback, "SOCKET_FRIEND_REQUEST_REJECTED", locale);
        })();
      }
    );

    socket.on(
      "friend.remove",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = FriendRemoveSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const result = await callUserSvc("DELETE", `/${r.data.targetUserId}`);
          if (!result.ok) {
            ackError(
              callback,
              result.status === 404 ? "NOT_FOUND" : "SERVICE_ERROR",
              locale
            );
            return;
          }
          ackOk(callback, "SOCKET_FRIEND_REMOVED", locale);
        })();
      }
    );

    socket.on(
      "friend.cancel_request",
      (payload: unknown, callback?: (res: unknown) => void) => {
        const r = FriendCancelRequestSchema.safeParse(payload);
        if (!r.success) {
          ackError(callback, "INVALID_PAYLOAD", locale);
          return;
        }
        void (async () => {
          const result = await callUserSvc(
            "DELETE",
            `/requests/${r.data.requestId}`
          );
          if (!result.ok) {
            ackError(
              callback,
              result.status === 404 ? "NOT_FOUND" : "SERVICE_ERROR",
              locale
            );
            return;
          }
          ackOk(callback, "SOCKET_FRIEND_REQUEST_CANCELLED", locale);
        })();
      }
    );

    // `socket.rooms` is already emptied by the time `disconnect` fires, so the
    // call rooms this participant was in must be read here.
    socket.on("disconnecting", () => {
      if (!userId) return;
      for (const room of socket.rooms) {
        if (!room.startsWith("call:")) continue;
        scheduleCallCleanup(
          room.slice("call:".length),
          userId,
          socket.data.callLegId ?? deviceId
        );
      }
    });

    socket.on("disconnect", (reason: string) => {
      logger.debug(`/chat disconnected userId=${userId} reason=${reason}`);

      clearSessionTimers();

      // Flush every pending presence timer and broadcast the stop, so peers are
      // never stuck with a "typing…" / "recording…" indicator after the socket
      // closes. Both flushes route through the shared engine, so /chat and
      // /community now clean up identically.
      typing.flush();
      recording.flush();

      if (userId) {
        // Only THIS socket's session ends here. chat-service re-derives the
        // aggregate from whatever sessions remain, so another tab or the phone
        // keeps the user online and no offline event is published.
        messagingClient
          .presenceDisconnect({ userId, deviceId: presenceDeviceId })
          .catch((err: unknown) =>
            logger.warn(`/chat presence:disconnect error: ${String(err)}`)
          );
      }
    });
  });
}
