import { randomUUID } from "node:crypto";

import { logger } from "@aimess/logger";
import { BadRequestError, NotFoundError } from "@aimess/errors";
import {
  buildReactionActivityText,
  isCallContentType,
} from "@aimess/constants";

import type { Redis, Cluster } from "ioredis";

import { publishCommunityActivitySafe } from "../events/publish-community-activity.js";
import {
  publishConvUpdatedSafe,
  publishCommunityUpdatedSafe,
} from "../events/publish-conv-updated.js";
import { publishConversationReadSafe } from "../events/publish-conversation-read.js";
import { publishMessageSentSafe } from "../events/publish-message-sent.js";
import { notifyUnreadChanged } from "../events/unread-summary-bridge.js";
import {
  convertMessageToPreview,
  buildPushPreview,
} from "./message-preview.service.js";
import {
  buildChatMessageEvent,
  buildCanonicalQuote,
  normalizeMessageType,
  autoDeleteWireFields,
  type ReactionGroup,
  type CanonicalQuote,
} from "../lib/chat-message.serializer.js";
import {
  resolveMediaUrl,
  resolveMediaUrlMap,
  urlFromMap,
  resolveContentFiles,
  resolveQuoteThumbnail,
  fileMediaKey,
  pushImageKeyOf,
  type MediaFileLike,
} from "../lib/media-resolve.js";
import { isIdempotentReplay } from "../lib/idempotency.js";
import { getAlbumMessages } from "../lib/album-messages.js";
import { mayBroadcastReadReceipts } from "../lib/account-chat-settings.js";

import type { PrivateMessageService } from "./private-message.service.js";
import type { GroupMessageService } from "./group-message.service.js";
import type { GroupMemberService } from "./group-member.service.js";
import type { CommunityMessageService } from "./community-message.service.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import { resolveSenderIdentity } from "../lib/resolve-sender-identity.js";
import type { PrivatePinService } from "./private-pin.service.js";
import type { GroupPinService } from "./group-pin.service.js";
import { resolveConversationType } from "../lib/conversation-type.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { PresenceService } from "./presence.service.js";
import { buildDeletePayload } from "../lib/chat-message.serializer.js";
import { unpinAfterDelete } from "../lib/pin-after-delete.js";
import { renderConvOverrides } from "../lib/recipient-override-render.js";
import { buildMessagePreview } from "../events/publish-message-sent.js";

function publishRealtimeSafe(
  redis: Redis | Cluster,
  channel: string,
  event: string,
  data: unknown,
  context: string
): void {
  redis
    .publish(channel, JSON.stringify({ event, data }))
    .catch((err: unknown) => {
      logger.warn(
        `ChatMessageOrchestrator|realtime publish failed event=${event} channel=${channel} ${context}: ${String(err)}`
      );
    });
}

/**
 * Structured message content as it travels through the send path: the body text
 * plus optional attachment arrays / structured extras. Mirrors the shape the
 * private/group `*MessageService.sendMessage` persist (and the socket/gRPC
 * senders build), so the orchestrator can both forward it to the service and
 * resolve-on-read its attachment keys for the live broadcast.
 */
export interface OrchestratorContent {
  text: string;
  urls?: string[];
  files?: Array<Record<string, unknown>>;
  location?: Record<string, unknown>;
  contact?: Record<string, unknown>;
  sticker?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SendDirectParams {
  conversationType: "PRIVATE" | "GROUP";
  roomId: string;
  senderId: string;
  /** Required for PRIVATE (the peer); ignored for GROUP. */
  receiverId?: string;
  /** Sender display name; resolved from the user snapshot when omitted. */
  senderName?: string;
  /** Sender avatar object-key/URL; resolved from the user snapshot when omitted. */
  senderAvatar?: string;
  content: OrchestratorContent;
  messageType: string;
  parentMessageId?: string | null;
  /** Idempotency key; defaulted to a fresh UUID when omitted. */
  clientMessageId?: string | null;
  /** Client compose time (epoch ms) — display only; never overwrites serverTs. */
  clientTs?: number | null;
}

export interface SendDirectResult {
  messageId: string;
  /** epoch ms server-authoritative time. */
  sentAt: number;
  /** True when the service collapsed this onto a pre-existing message (replay). */
  alreadySent: boolean;
  sequenceNumber: number;
  /** Canonical wire event — byte-identical to the socket `message:new` payload. */
  message: Record<string, unknown>;
}

export interface SendCommunityParams {
  /** community-service Community.id — used for the broadcast + activity bump. */
  communityId: string;
  /** chat-service GeneralRoom.id — used for the message persist. */
  roomId: string;
  senderId: string;
  /** Sender display name; resolved from the user snapshot when omitted. */
  senderName?: string;
  /** Sender avatar object-key/URL; resolved from the user snapshot when omitted. */
  senderAvatar?: string;
  /** Community display name — used as the FCM push notification title. */
  communityName?: string;
  message: string;
  messageType: string;
  parentMessageId?: string | null;
  /** Idempotency key; defaulted to a fresh UUID when omitted. */
  clientMessageId?: string | null;
  attachments?: Array<Record<string, unknown>>;
}

export interface SendCommunityResult {
  messageId: string;
  roomId: string;
  /** epoch ms server-authoritative time. */
  sentAt: number;
  /** True when the service collapsed this onto a pre-existing message (replay). */
  alreadySent: boolean;
  sequenceNumber: number;
  /** Canonical wire event — byte-identical to the socket `community:message:new`. */
  message: Record<string, unknown>;
}

export interface ForwardCommunityParams {
  sourceMessageId: string;
  /** community-service Community.id the source message actually belongs to. */
  sourceCommunityId: string;
  /** community-service Community.id — used for the broadcast + activity bump. */
  targetCommunityId: string;
  /** chat-service GeneralRoom.id — used for the message persist. */
  targetRoomId: string;
  senderId: string;
  /** Sender display name; resolved from the user snapshot when omitted. */
  senderName?: string;
  /** Sender avatar object-key/URL; resolved from the user snapshot when omitted. */
  senderAvatar?: string;
  /** Idempotency key; defaulted to a fresh UUID when omitted. */
  clientMessageId?: string | null;
}

export interface ForwardCommunityResult {
  messageId: string;
  roomId: string;
  /** epoch ms server-authoritative time. */
  sentAt: number;
  /** True when the service collapsed this onto a pre-existing message (replay). */
  alreadySent: boolean;
  sequenceNumber: number;
  /** Canonical wire event — byte-identical to the socket `community:message:new`. */
  message: Record<string, unknown>;
}

export interface DeleteDirectParams {
  conversationType: "PRIVATE" | "GROUP";
  roomId: string;
  messageId: string;
  userId: string;
  scope: "forMe" | "forEveryone";
  /**
   * Server-initiated delete (the auto-delete sweeper). Skips the actor
   * permission checks — the expired timer is the authority, and the nominal
   * `userId` (the original sender) may have left the group or be muted by then.
   * Set only from inside the service; no request path can reach it.
   */
  bySystem?: boolean;
}

export interface DeleteDirectResult {
  /** Canonical tombstone — byte-identical to the REST delete response / socket message:delete. */
  tombstone: Record<string, unknown>;
}

export interface PinDirectParams {
  conversationType: "PRIVATE" | "GROUP";
  roomId: string;
  messageId: string;
  userId: string;
}

export interface PinDirectResult {
  pin: Record<string, unknown>;
  pinnedCount: number;
}

export interface UnpinDirectResult {
  pinnedCount: number;
}

export interface MarkReadDirectParams {
  conversationType: "PRIVATE" | "GROUP";
  roomId: string;
  readerId: string;
  /** Highest message id the reader has now seen (read high-water mark). */
  upToMessageId: string;
}

export interface MarkReadDirectResult {
  /** The `sequenceNumber` of `upToMessageId` (read_to_seq high-water mark); 0 if missing. */
  readToSeq: number;
}

export interface ReactDirectParams {
  conversationType: "PRIVATE" | "GROUP";
  roomId: string;
  messageId: string;
  /** Reacting user (the access-token subject). */
  userId: string;
  emoji: string;
  /** add = toggle the reaction ON if absent; remove = toggle it OFF if present. */
  /** `set` = caller ends up holding exactly this emoji (community REST semantics). */
  op: "add" | "remove" | "set";
}

export interface ReactDirectResult {
  /** Canonical grouped reactions after the op, reactor avatars resolved-on-read. */
  reactions: ReactionGroup[];
}

/**
 * Single owner of message SEND for every conversation kind. Wraps the per-kind
 * CRUD service (`*MessageService.sendMessage`) with the identical post-write
 * side-effects the gRPC handlers perform — Redis `message:new` /
 * `community:message:new` broadcast, inbox/community `*:updated` bump, and the
 * FCM push trigger — so both transports (gRPC today, REST now) route effects
 * through ONE place instead of duplicating them. Effects are fire-and-forget
 * exactly where the gRPC code is: a bump/push/activity failure can never reject
 * the send (the message is already persisted).
 */
export class ChatMessageOrchestrator {
  constructor(
    private readonly privateMessageService: PrivateMessageService,
    private readonly groupMessageService: GroupMessageService,
    private readonly groupMemberService: GroupMemberService,
    private readonly communityMessageService: CommunityMessageService,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly cacheRepo: CacheRepository,
    private readonly redis: Redis | Cluster,
    private readonly privatePinService: PrivatePinService,
    private readonly groupPinService: GroupPinService,
    // ponytail: optional — omitted in existing unit tests that don't cover
    // presence; PRIVATE conv:updated bumps just skip the isOffline field then.
    private readonly presenceService?: PresenceService
  ) {}

  /**
   * Reused by every PRIVATE conv:updated publish — undefined skips isOffline
   * entirely. Viewer-scoped on purpose: `isOffline` is presence, so it goes
   * through the same `whoCanSeeOnlineStatus` gate as every other read.
   */
  private getIsOnline():
    | ((viewerId: string, subjectId: string) => Promise<boolean>)
    | undefined {
    return this.presenceService
      ? (viewerId: string, subjectId: string) =>
          this.presenceService!.getPresenceFor(viewerId, subjectId)
      : undefined;
  }

  /**
   * Send a PRIVATE or GROUP message and run its effects. Authorization
   * (friendship gate for private, active-membership for group) and idempotency
   * (clientMessageId + unique index) are enforced INSIDE the called service —
   * not duplicated here.
   */
  async sendDirect(params: SendDirectParams): Promise<SendDirectResult> {
    // VOICE_CALL / VIDEO_CALL are written ONLY by the call service — a forged
    // one would fake a call in someone's timeline (and, as a systemEvent-less
    // row, one that never happened). The REST validators already reject them via
    // `z.enum(CONTENT_TYPES)`, but the socket/gRPC path takes the kind as a free
    // string, so the guard belongs here: the one point every send funnels
    // through, whatever the transport.
    if (isCallContentType(params.messageType ?? "")) {
      throw new BadRequestError("CHAT_INVALID_MESSAGE_TYPE");
    }
    const conversationType = resolveConversationType(
      params.roomId,
      params.conversationType
    );
    const clientMessageId = params.clientMessageId || randomUUID();
    const clientTs = params.clientTs ?? 0;

    // Resolve the sender's display identity once (used by the broadcast + push)
    // when the caller did not supply it — keeps identity resolution in one place.
    const { senderName, senderAvatar } = await this.resolveSenderIdentity(
      params.senderId,
      params.senderName,
      params.senderAvatar
    );

    let msg: {
      id: string;
      messageType: string;
      content: unknown;
      createdAt: unknown;
      sequenceNumber: number;
      senderRole?: string;
    };

    if (conversationType === "GROUP") {
      msg = await this.groupMessageService.sendMessage({
        roomId: params.roomId,
        senderId: params.senderId,
        senderName,
        senderAvatar,
        content: params.content,
        messageType: params.messageType || "TEXT",
        parentMessageId: params.parentMessageId ?? null,
        clientMessageId,
        clientTs,
      });
    } else {
      msg = await this.privateMessageService.sendMessage({
        roomId: params.roomId,
        senderId: params.senderId,
        content: params.content,
        messageType: params.messageType || "TEXT",
        parentMessageId: params.parentMessageId ?? null,
        clientMessageId,
        clientTs,
      });
    }

    const serverTs =
      msg.createdAt instanceof Date ? msg.createdAt.getTime() : Date.now();
    const full = msg as Record<string, unknown>;

    // WHO receives this DM is decided by the room, not by the caller. The
    // service derives the peer from `PrivateRoom.participants` and persists it,
    // so the row we just got back IS the answer — read it here instead of
    // trusting `params.receiverId`, which drove all four fan-outs below.
    // Omitting it delivered the message to `user:""` (the peer's list row and
    // push never fired); forging it delivered `message:new`, the `conv:updated`
    // bump and a push notification to someone who is not in the room.
    const resolvedReceiverId =
      conversationType === "GROUP"
        ? undefined
        : ((full.receiverId as string | null) ?? "");

    // Detect an idempotency replay via the authoritative marker the service set
    // when it returned a PRE-EXISTING row for a repeated clientMessageId (a
    // pre-send dedup hit or a duplicate-key collapse). Mirrors the gRPC
    // sendMessage handler — the time-window heuristic was unreliable. On a replay
    // the row's FIRST send already broadcast/bumped/pushed, so all three live
    // effects must be suppressed (re-running them duplicates the bubble + bump).
    const alreadySent = isIdempotentReplay(msg);

    // Resolve-on-read: raw avatar/attachment object-keys → presigned URLs for the
    // returned/broadcast wire object only (the stored snapshot keeps raw keys).
    // Built UNCONDITIONALLY — the controller returns this canonical wire event
    // even on a replay (the client still gets the message it sent).
    const [bcastAvatar, bcastContent, bcastQuote] = await Promise.all([
      resolveMediaUrl(senderAvatar || ""),
      this.resolveBroadcastContent(msg.content ?? null),
      this.resolveBroadcastQuote(full.quoteData ?? null),
    ]);
    const wireEvent = buildChatMessageEvent({
      id: msg.id,
      clientMessageId,
      roomId: params.roomId,
      conversationType,
      senderId: params.senderId,
      senderName,
      senderAvatar: bcastAvatar,
      senderRole: msg.senderRole,
      receiverId: resolvedReceiverId,
      messageType: msg.messageType,
      content: bcastContent ?? null,
      parentMessageId: (full.parentMessageId as string) || "",
      quoteData: bcastQuote,
      reactions: [],
      clientTs,
      serverTs,
      sequenceNumber: msg.sequenceNumber,
      revision: (msg as unknown as { revision?: number }).revision ?? 0,
      countInUnread: (msg as unknown as { countInUnread?: boolean | null })
        .countInUnread,
      ...autoDeleteWireFields(msg),
    });

    if (!alreadySent) {
      const albumRows = getAlbumMessages(msg);
      // ── 1. Live broadcast: message:new on conv:<roomId> (one per album row) ─
      for (const row of albumRows) {
        const rowFull = row as Record<string, unknown>;
        const rowServerTs =
          row.createdAt instanceof Date ? row.createdAt.getTime() : serverTs;
        const [rowBcastContent, rowBcastQuote] = await Promise.all([
          this.resolveBroadcastContent(row.content ?? null),
          this.resolveBroadcastQuote(rowFull.quoteData ?? null),
        ]);
        const rowWire = buildChatMessageEvent({
          id: row.id,
          clientMessageId,
          roomId: params.roomId,
          conversationType,
          senderId: params.senderId,
          senderName,
          senderAvatar: bcastAvatar,
          senderRole:
            (row as { senderRole?: string }).senderRole ?? msg.senderRole,
          receiverId: resolvedReceiverId,
          messageType: row.messageType,
          content: rowBcastContent ?? null,
          parentMessageId: (rowFull.parentMessageId as string) || "",
          quoteData: rowBcastQuote,
          reactions: [],
          clientTs,
          serverTs: rowServerTs,
          sequenceNumber: row.sequenceNumber,
          revision: (row as unknown as { revision?: number }).revision ?? 0,
          countInUnread: (row as unknown as { countInUnread?: boolean | null })
            .countInUnread,
          ...autoDeleteWireFields(row),
        });
        const bcastContext = `roomId=${params.roomId} messageId=${row.id} sequenceNumber=${row.sequenceNumber}`;
        publishRealtimeSafe(
          this.redis,
          `conv:${params.roomId}`,
          "message:new",
          rowWire,
          bcastContext
        );
        // Personal bus too. `conv:<id>` only reaches sockets that have this chat OPEN
        // (join happens on `conversation:join`), so a recipient on the chat list or in
        // the background never saw the message and never sent a delivery receipt —
        // leaving the sender stuck on a single tick. Mirrors the gRPC send path.
        // Excludes the sender: their own socket is already in `conv:<roomId>` (from
        // sending) and gets the message via the ack, so a personal-channel copy on
        // top of the room broadcast double-delivers `message:new` to just them.
        const fanOut = (ids: string[]) => {
          for (const userId of new Set(ids.filter(Boolean))) {
            if (userId === params.senderId) continue;
            publishRealtimeSafe(
              this.redis,
              `user:${userId}`,
              "message:new",
              rowWire,
              bcastContext
            );
          }
        };
        if (conversationType === "GROUP") {
          void this.groupMessageService
            .getActiveMemberIds(params.roomId)
            .then(fanOut)
            .catch((err: unknown) => {
              logger.warn(
                `ChatMessageOrchestrator|message:new personal fan-out failed ${bcastContext}: ${String(err)}`
              );
            });
        } else {
          fanOut([params.senderId, resolvedReceiverId ?? ""]);
        }
      }

      // ── 2. Bump-to-top: conv:updated fan-out (fire-and-forget) ───────────
      const bumpBase = {
        redis: this.redis,
        type: conversationType,
        roomId: params.roomId,
        senderId: params.senderId,
        senderName: senderName || "",
        lastMessageId: msg.id,
        lastMessageAt: serverTs,
        preview: {
          contentType: normalizeMessageType(msg.messageType),
          text: convertMessageToPreview(msg.messageType, msg.content),
          clientMessageId,
          seq: msg.sequenceNumber ?? 0,
          revision: (msg as unknown as { revision?: number }).revision ?? 0,
          createdAt: serverTs,
        },
      };
      if (conversationType === "GROUP") {
        publishConvUpdatedSafe({
          ...bumpBase,
          fetchRecipients: () =>
            this.groupMessageService.getActiveMemberIds(params.roomId),
          resolveUnreadCounts: () =>
            this.groupMessageService.getUnreadCountsByUser(params.roomId),
        });
      } else {
        publishConvUpdatedSafe({
          ...bumpBase,
          recipientIds: [params.senderId, resolvedReceiverId ?? ""],
          getIsOnline: this.getIsOnline(),
          resolveUnreadCounts: () =>
            this.privateMessageService.getUnreadCountsByUser(params.roomId),
        });
      }

      // ── 3. FCM/APNs push (fire-and-forget) ───────────────────────────────
      const pushText =
        ((msg.content as Record<string, unknown>)?.text as string) ?? "";
      const pushBase = {
        conversationId: params.roomId,
        conversationType,
        messageId: msg.id,
        clientMessageId,
        senderId: params.senderId,
        senderName: senderName || "",
        senderAvatar: senderAvatar || "",
        preview: buildPushPreview(msg.messageType, pushText),
        ...(pushImageKeyOf(msg.messageType, msg.content)
          ? { previewImageKey: pushImageKeyOf(msg.messageType, msg.content) }
          : {}),
        messageType: msg.messageType,
        sentAt: serverTs,
      };
      if (conversationType === "GROUP") {
        // Group name + avatar are resolved from GroupRoom inside
        // `publishMessageSentSafe` — the one place every producer goes through.
        publishMessageSentSafe({
          ...pushBase,
          fetchRecipients: () =>
            this.groupMessageService.getActiveMemberIds(params.roomId),
        });
      } else {
        publishMessageSentSafe({
          ...pushBase,
          recipientIds: [resolvedReceiverId ?? ""],
        });
      }
    }

    return {
      messageId: msg.id,
      sentAt: serverTs,
      alreadySent,
      sequenceNumber: msg.sequenceNumber,
      message: wireEvent,
    };
  }

  /**
   * Send a COMMUNITY message and run its effects: `community:message:new`
   * broadcast on community:<communityId>, the community-activity denormalization
   * for GET /communities/mine, and the `community:updated` bump fan-out. Active
   * membership + suspended-room guards are enforced INSIDE the service.
   */
  async sendCommunity(
    params: SendCommunityParams
  ): Promise<SendCommunityResult> {
    const clientMessageId = params.clientMessageId || randomUUID();

    const { senderName, senderAvatar } = await this.resolveSenderIdentity(
      params.senderId,
      params.senderName,
      params.senderAvatar
    );

    const saved = await this.communityMessageService.sendMessage({
      roomId: params.roomId,
      sentBy: params.senderId,
      senderName,
      senderAvatar,
      message: params.message || "",
      messageType: (params.messageType || "TEXT").toUpperCase(),
      parentMessageId: params.parentMessageId ?? null,
      clientMessageId,
      attachments: params.attachments,
    });

    const sentAt =
      saved.createdAt instanceof Date ? saved.createdAt.getTime() : Date.now();

    // Idempotency replay: the service tagged the returned row when a repeated
    // clientMessageId collapsed onto a pre-existing message. Suppress all live
    // effects (broadcast, activity denormalization, bump) on a replay — the
    // row's FIRST send already ran them. Same marker the private/group path uses.
    const alreadySent = isIdempotentReplay(saved);

    // Resolve-on-read for the live push: sender avatar + attachment keys → full
    // presigned URLs (the stored snapshot keeps the raw keys).
    const files = Array.isArray(params.attachments) ? params.attachments : [];
    const location = this.firstAttachmentOfType(params.attachments, "location");
    const contact = this.firstAttachmentOfType(params.attachments, "contact");
    const sticker = this.firstAttachmentOfType(params.attachments, "sticker");
    const [bcastSenderAvatar, bcastFiles, bcastQuote, bcastSticker] =
      await Promise.all([
        resolveMediaUrl(senderAvatar || ""),
        resolveContentFiles(files as MediaFileLike[]),
        this.resolveBroadcastQuote(saved.quoteData),
        this.resolveStickerAttachment(sticker),
      ]);

    const wireEvent: Record<string, unknown> = {
      // V2 canonical fields (mirror grpc sendCommunityMessage).
      id: saved.id,
      messageId: saved.id,
      communityId: params.communityId,
      roomId: saved.roomId,
      senderId: saved.sentBy,
      senderName,
      senderAvatar: bcastSenderAvatar,
      parentMessageId: saved.parentMessageId ?? "",
      quoteData: bcastQuote,
      content: {
        text: saved.message ?? "",
        files: bcastFiles,
        ...(location ? { location } : {}),
        ...(contact ? { contact } : {}),
        ...(bcastSticker ? { sticker: bcastSticker } : {}),
      },
      reactions: [],
      message: saved.message ?? "",
      contentType: normalizeMessageType(saved.messageType),
      countInUnread:
        (saved as unknown as { countInUnread?: boolean | null })
          .countInUnread ?? true,
      clientMessageId,
      serverTs: sentAt,
      sentAt,
      // The community gRPC handler predates per-room sequencing; the field now
      // exists, so include it for parity with private/group broadcasts.
      sequenceNumber: saved.sequenceNumber,
      // Zero-loss CHANGE cursor — the client tracks per-room localMaxRevision and
      // gap-checks (revision > local+1 ⇒ missed a change ⇒ call /changes).
      revision: (saved as unknown as { revision?: number }).revision ?? 0,
    };

    if (!alreadySent) {
      const albumRows = getAlbumMessages(saved);
      for (const row of albumRows) {
        const rowSentAt =
          row.createdAt instanceof Date ? row.createdAt.getTime() : sentAt;
        const rowAttachments = Array.isArray(row.attachments)
          ? (row.attachments as MediaFileLike[])
          : [];
        const rowLocation = this.firstAttachmentOfType(
          rowAttachments as Array<Record<string, unknown>>,
          "location"
        );
        const rowContact = this.firstAttachmentOfType(
          rowAttachments as Array<Record<string, unknown>>,
          "contact"
        );
        const rowSticker = this.firstAttachmentOfType(
          rowAttachments as Array<Record<string, unknown>>,
          "sticker"
        );
        const [rowBcastFiles, rowBcastQuote, rowBcastSticker] =
          await Promise.all([
            resolveContentFiles(rowAttachments),
            this.resolveBroadcastQuote(row.quoteData),
            this.resolveStickerAttachment(rowSticker),
          ]);
        const rowWire: Record<string, unknown> = {
          id: row.id,
          messageId: row.id,
          communityId: params.communityId,
          roomId: row.roomId,
          senderId: row.sentBy,
          senderName,
          senderAvatar: bcastSenderAvatar,
          parentMessageId: row.parentMessageId ?? "",
          quoteData: rowBcastQuote,
          content: {
            text: row.message ?? "",
            files: rowBcastFiles,
            ...(rowLocation ? { location: rowLocation } : {}),
            ...(rowContact ? { contact: rowContact } : {}),
            ...(rowBcastSticker ? { sticker: rowBcastSticker } : {}),
          },
          reactions: [],
          message: row.message ?? "",
          contentType: normalizeMessageType(row.messageType),
          clientMessageId,
          serverTs: rowSentAt,
          sentAt: rowSentAt,
          sequenceNumber: row.sequenceNumber,
          revision: (row as unknown as { revision?: number }).revision ?? 0,
        };
        publishRealtimeSafe(
          this.redis,
          `community:${params.communityId}`,
          "community:message:new",
          rowWire,
          `communityId=${params.communityId} roomId=${row.roomId} messageId=${row.id} sequenceNumber=${row.sequenceNumber}`
        );
      }

      const lastAttachments = Array.isArray(saved.attachments)
        ? (saved.attachments as Array<Record<string, unknown>>)
        : [];
      const lastLocation = this.firstAttachmentOfType(
        lastAttachments,
        "location"
      );
      const lastContact = this.firstAttachmentOfType(
        lastAttachments,
        "contact"
      );

      // Denormalize activity to community-service (orders GET /communities/mine).
      // Keyed by communityId (Community.id), NOT roomId (GeneralRoom.id).
      if (params.communityId) {
        publishCommunityActivitySafe({
          communityId: params.communityId,
          lastMessageAt:
            saved.createdAt instanceof Date
              ? saved.createdAt.toISOString()
              : new Date(sentAt).toISOString(),
          lastMessageId: saved.id,
          senderUserId: params.senderId,
          senderUsername: senderName,
          // Centralized preview — identical to the sibling community:updated
          // socket preview below, so non-text messages (media/sticker/voice/
          // document/location/contact) never persist a blank preview.
          messagePreview: convertMessageToPreview(saved.messageType, {
            text: saved.message ?? "",
            files: lastAttachments,
            ...(lastLocation ? { location: lastLocation } : {}),
            ...(lastContact ? { contact: lastContact } : {}),
          }),
          clientMessageId,
          seq: saved.sequenceNumber ?? 0,
          contentType: normalizeMessageType(saved.messageType),
        });
      }

      // Bump-to-top: community:updated fan-out (fire-and-forget).
      publishCommunityUpdatedSafe({
        redis: this.redis,
        communityId: params.communityId,
        roomId: saved.roomId,
        fetchMembers: () =>
          this.communityMessageService.getActiveMemberIds(params.roomId),
        senderId: params.senderId,
        senderName,
        lastMessageId: saved.id,
        lastMessageAt: sentAt,
        preview: {
          contentType: normalizeMessageType(saved.messageType),
          text: convertMessageToPreview(saved.messageType, {
            text: saved.message ?? "",
            files: lastAttachments,
            ...(lastLocation ? { location: lastLocation } : {}),
            ...(lastContact ? { contact: lastContact } : {}),
          }),
          clientMessageId,
          seq: saved.sequenceNumber ?? 0,
          revision: (saved as unknown as { revision?: number }).revision ?? 0,
          createdAt: sentAt,
        },
      });

      // FCM push — community messages need the same offline-wake push as
      // private/group. fetchRecipients is lazy so the DB call only runs when
      // RabbitMQ is configured. communityName falls back to the locally-mirrored
      // GeneralRoom.name when the caller omits it, so the consumer always has a
      // real community name for the push title (not the sender's name).
      publishMessageSentSafe({
        conversationId: params.communityId,
        conversationType: "COMMUNITY",
        communityId: params.communityId,
        // `params.communityName` comes off the REQUEST BODY — a client that
        // hasn't seen a rename sends the old name — so it is only a fallback.
        // `publishMessageSentSafe` prefers the locally-mirrored GeneralRoom
        // row (name + logo, kept current by `community.meta_synced`), which is
        // also where the push's tray image comes from, so title and image can
        // never describe two different versions of the community.
        communityName: params.communityName || "",
        messageId: saved.id,
        clientMessageId,
        senderId: params.senderId,
        senderName: senderName || "",
        senderAvatar: senderAvatar || "",
        preview: buildPushPreview(saved.messageType, saved.message ?? ""),
        messageType: normalizeMessageType(saved.messageType),
        sentAt,
        fetchRecipients: () =>
          this.communityMessageService.getActiveMemberIds(params.roomId),
      });
    }

    return {
      messageId: saved.id,
      roomId: saved.roomId,
      sentAt,
      alreadySent,
      sequenceNumber: saved.sequenceNumber,
      message: wireEvent,
    };
  }

  /**
   * Forward a COMMUNITY message and run the SAME `community:message:new`
   * broadcast / activity-denormalization / `community:updated` bump / FCM-push
   * effects `sendCommunity` runs — mirrors the private/group REST forward
   * controllers (which build their own broadcast rather than routing through a
   * generic "send"), so community forward gets identical real-time parity
   * instead of being REST-only with no live update. `communityMessageService
   * .forwardMessage` owns the source-room-membership IDOR guard, the
   * target-membership check, and idempotency (via its internal `sendMessage`).
   */
  async forwardCommunity(
    params: ForwardCommunityParams
  ): Promise<ForwardCommunityResult> {
    const clientMessageId = params.clientMessageId || randomUUID();

    const { senderName, senderAvatar } = await this.resolveSenderIdentity(
      params.senderId,
      params.senderName,
      params.senderAvatar
    );

    const saved = await this.communityMessageService.forwardMessage({
      sourceMessageId: params.sourceMessageId,
      sourceCommunityId: params.sourceCommunityId,
      targetCommunityId: params.targetCommunityId,
      targetRoomId: params.targetRoomId,
      senderId: params.senderId,
      clientMessageId,
    });

    const sentAt =
      saved.createdAt instanceof Date ? saved.createdAt.getTime() : Date.now();
    const alreadySent = isIdempotentReplay(saved);

    const attachments = Array.isArray(saved.attachments)
      ? (saved.attachments as Array<Record<string, unknown>>)
      : [];
    const location = this.firstAttachmentOfType(attachments, "location");
    const contact = this.firstAttachmentOfType(attachments, "contact");
    const sticker = this.firstAttachmentOfType(attachments, "sticker");
    const [bcastSenderAvatar, bcastFiles, bcastQuote, bcastSticker] =
      await Promise.all([
        resolveMediaUrl(saved.senderAvatar || senderAvatar || ""),
        resolveContentFiles(attachments as MediaFileLike[]),
        this.resolveBroadcastQuote(saved.quoteData),
        this.resolveStickerAttachment(sticker),
      ]);

    const wireEvent: Record<string, unknown> = {
      id: saved.id,
      messageId: saved.id,
      communityId: params.targetCommunityId,
      roomId: saved.roomId,
      senderId: saved.sentBy,
      senderName: saved.senderName || senderName,
      senderAvatar: bcastSenderAvatar,
      parentMessageId: saved.parentMessageId ?? "",
      quoteData: bcastQuote,
      content: {
        text: saved.message ?? "",
        files: bcastFiles,
        ...(location ? { location } : {}),
        ...(contact ? { contact } : {}),
        ...(bcastSticker ? { sticker: bcastSticker } : {}),
      },
      reactions: [],
      message: saved.message ?? "",
      contentType: normalizeMessageType(saved.messageType),
      countInUnread:
        (saved as unknown as { countInUnread?: boolean | null })
          .countInUnread ?? true,
      clientMessageId,
      isForwarded: true,
      serverTs: sentAt,
      sentAt,
      sequenceNumber: saved.sequenceNumber,
      revision: (saved as unknown as { revision?: number }).revision ?? 0,
    };

    if (!alreadySent) {
      await this.redis.publish(
        `community:${params.targetCommunityId}`,
        JSON.stringify({ event: "community:message:new", data: wireEvent })
      );

      const preview = convertMessageToPreview(saved.messageType, {
        text: saved.message ?? "",
        files: attachments,
        ...(location ? { location } : {}),
        ...(contact ? { contact } : {}),
      });

      publishCommunityActivitySafe({
        communityId: params.targetCommunityId,
        lastMessageAt: new Date(sentAt).toISOString(),
        lastMessageId: saved.id,
        senderUserId: params.senderId,
        senderUsername: senderName,
        messagePreview: preview,
        clientMessageId,
        seq: saved.sequenceNumber ?? 0,
        contentType: normalizeMessageType(saved.messageType),
      });

      publishCommunityUpdatedSafe({
        redis: this.redis,
        communityId: params.targetCommunityId,
        roomId: saved.roomId,
        fetchMembers: () =>
          this.communityMessageService.getActiveMemberIds(params.targetRoomId),
        senderId: params.senderId,
        senderName,
        lastMessageId: saved.id,
        lastMessageAt: sentAt,
        preview: {
          contentType: normalizeMessageType(saved.messageType),
          text: preview,
          clientMessageId,
          seq: saved.sequenceNumber ?? 0,
          revision: (saved as unknown as { revision?: number }).revision ?? 0,
          createdAt: sentAt,
        },
      });

      publishMessageSentSafe({
        conversationId: params.targetCommunityId,
        conversationType: "COMMUNITY",
        communityId: params.targetCommunityId,
        messageId: saved.id,
        clientMessageId,
        senderId: params.senderId,
        senderName: senderName || "",
        senderAvatar: senderAvatar || "",
        preview: buildPushPreview(saved.messageType, saved.message ?? ""),
        messageType: normalizeMessageType(saved.messageType),
        sentAt,
        fetchRecipients: () =>
          this.communityMessageService.getActiveMemberIds(params.targetRoomId),
      });
    }

    return {
      messageId: saved.id,
      roomId: saved.roomId,
      sentAt,
      alreadySent,
      sequenceNumber: saved.sequenceNumber,
      message: wireEvent,
    };
  }

  /**
   * Delete a PRIVATE or GROUP message (for-me or for-everyone) and run the
   * identical post-write effects the REST delete controllers perform: canonical
   * tombstone broadcast (`message:delete` on `conv:<roomId>`) + best-effort
   * list-preview recalculation/bump. Single new entry point so the socket
   * `message:delete` handler (added for parity with community's
   * `community:message:delete` socket RPC) gets the SAME effects as REST instead
   * of a thinner duplicate. Authorization/business rules are enforced INSIDE the
   * called service — not duplicated here.
   */
  async deleteDirect(params: DeleteDirectParams): Promise<DeleteDirectResult> {
    const conversationType = resolveConversationType(
      params.roomId,
      params.conversationType
    );

    let result: {
      id: string;
      roomId: string;
      sequenceNumber: number;
      createdAt: Date;
      senderId?: string | null;
      receiverId?: string | null;
      deletedType?: string | null;
      revision?: number;
      clientMessageId?: string | null;
      deletedAt?: Date | null;
    } | null;

    if (conversationType === "GROUP") {
      result =
        params.scope === "forMe"
          ? await this.groupMessageService.deleteForMe(
              params.messageId,
              params.userId,
              params.roomId
            )
          : await this.groupMessageService.deleteMessage(
              params.messageId,
              params.userId,
              params.roomId,
              params.bySystem === true
            );
    } else {
      result =
        params.scope === "forMe"
          ? await this.privateMessageService.deleteForMe(
              params.messageId,
              params.userId
            )
          : await this.privateMessageService.deleteForEveryone(
              params.messageId,
              params.userId
            );
    }
    if (!result) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const tombstone = buildDeletePayload({
      conversationType,
      messageId: result.id,
      roomId: result.roomId,
      scope: params.scope,
      deletedBy: params.userId,
      sequenceNumber: result.sequenceNumber,
      revision: result.revision,
      clientMessageId: result.clientMessageId,
      deletedAt: result.deletedAt?.getTime() ?? Date.now(),
      deletedType:
        params.scope === "forMe"
          ? "SELF_DELETE"
          : (result.deletedType ?? "SELF_DELETE"),
    });

    if (result.roomId) {
      await this.redis.publish(
        `conv:${result.roomId}`,
        JSON.stringify({ event: "message:delete", data: tombstone })
      );
    }

    // Keep pin state consistent with the delete — the same hook the REST delete
    // controllers run, so the socket/gRPC path can't leave a pin behind that
    // REST would have cleared. forEveryone unpins for the whole room, forMe
    // only for the deleting user. See lib/pin-after-delete.
    if (result.roomId) {
      void unpinAfterDelete({
        redis: this.redis,
        pinService:
          conversationType === "GROUP"
            ? this.groupPinService
            : this.privatePinService,
        kind: "DIRECT",
        roomId: result.roomId,
        messageId: params.messageId,
        userId: params.userId,
        scope: params.scope,
      });
    }

    if (params.scope === "forEveryone" && result.roomId) {
      const rId = result.roomId;
      const recalcPromise =
        conversationType === "GROUP"
          ? this.groupMessageService.recalculateLastMessageAfterDelete(
              rId,
              params.messageId
            )
          : this.privateMessageService.recalculateLastMessageAfterDelete(
              rId,
              params.messageId
            );
      void recalcPromise
        .then((recalc) => {
          if (recalc === null) return; // not the last message — no-op
          const preview = buildMessagePreview(
            recalc.messageType,
            recalc.content
          );
          if (conversationType === "GROUP") {
            publishConvUpdatedSafe({
              redis: this.redis,
              type: "GROUP",
              roomId: rId,
              fetchRecipients: () =>
                this.groupMessageService.getActiveMemberIds(rId),
              resolveOverrides: (recipientIds) =>
                this.groupMessageService
                  .resolveForEveryoneOverrides(
                    rId,
                    recalc.prevMessageId,
                    recipientIds
                  )
                  .then((raw) => renderConvOverrides(raw)),
              // Absolute post-delete badges (counters already decremented by the
              // delete). Also covers the auto-delete sweeper, which routes here.
              resolveUnreadCounts: () =>
                this.groupMessageService.getUnreadCountsByUser(rId),
              // Without this the bump is discarded by the client's monotonic
              // list guard — it points BACKWARD at the previous visible message.
              deleteRecalc: true,
              // The DELETE's own room revision, not the surviving message's:
              // this projection update is newer than everything before it even
              // though its `lastMessageAt` is older. Lets a client order by one
              // monotonic number instead of special-casing `deleteRecalc`.
              projectionRevision: result.revision ?? 0,
              senderId: recalc.senderId ?? "",
              lastMessageId: recalc.prevMessageId ?? "",
              lastMessageAt: recalc.createdAt.getTime(),
              preview: {
                contentType: recalc.messageType,
                text: preview,
                clientMessageId: recalc.clientMessageId,
                seq: recalc.sequenceNumber,
                revision: recalc.revision,
                createdAt: recalc.createdAt.getTime(),
              },
            });
          } else {
            const participants = [
              result.senderId ?? params.userId,
              result.receiverId ?? "",
            ].filter(Boolean) as string[];
            publishConvUpdatedSafe({
              redis: this.redis,
              type: "PRIVATE",
              roomId: rId,
              recipientIds: participants,
              resolveOverrides: (recipientIds) =>
                this.privateMessageService
                  .resolveForEveryoneOverrides(
                    rId,
                    recalc.prevMessageId,
                    recipientIds
                  )
                  .then((raw) => renderConvOverrides(raw)),
              resolveUnreadCounts: () =>
                this.privateMessageService.getUnreadCountsByUser(rId),
              deleteRecalc: true,
              // See the GROUP branch above — the delete's revision, not the
              // surviving message's.
              projectionRevision: result.revision ?? 0,
              senderId: recalc.senderId ?? "",
              lastMessageId: recalc.prevMessageId ?? "",
              lastMessageAt: recalc.createdAt.getTime(),
              preview: {
                contentType: recalc.messageType,
                text: preview,
                clientMessageId: recalc.clientMessageId,
                seq: recalc.sequenceNumber,
                revision: recalc.revision,
                createdAt: recalc.createdAt.getTime(),
              },
              getIsOnline: this.getIsOnline(),
            });
          }
        })
        .catch(() => {
          // Best-effort: a preview recalculation failure must never surface to
          // the user. The list will self-correct on next load.
        });
    }

    if (params.scope === "forMe" && result.roomId) {
      const rId = result.roomId;
      const recalcPromise =
        conversationType === "GROUP"
          ? this.groupMessageService.recalculateLastMessageAfterDeleteForMe(
              rId,
              result.createdAt,
              params.userId
            )
          : this.privateMessageService.recalculateLastMessageAfterDeleteForMe(
              rId,
              result.createdAt,
              params.userId
            );
      void recalcPromise
        .then((recalc) => {
          if (recalc === null || !recalc.wasEffectiveLast) return;
          const preview = recalc.hasLastMessage
            ? buildMessagePreview(recalc.messageType, recalc.content)
            : "";
          publishConvUpdatedSafe({
            redis: this.redis,
            type: conversationType,
            roomId: rId,
            recipientIds: [params.userId],
            // Only the hiding user's own badge can move on a delete-for-me.
            resolveUnreadCounts: () =>
              conversationType === "GROUP"
                ? this.groupMessageService.getUnreadCountsByUser(rId)
                : this.privateMessageService.getUnreadCountsByUser(rId),
            deleteRecalc: true,
            senderId: recalc.senderId ?? "",
            lastMessageId: recalc.prevMessageId ?? "",
            // 0 = "this viewer has nothing visible left" (sorts to the bottom);
            // reusing the hidden row's time would pin it to the top.
            lastMessageAt: recalc.hasLastMessage
              ? recalc.createdAt.getTime()
              : 0,
            preview: {
              contentType: recalc.messageType,
              text: preview,
              clientMessageId: recalc.clientMessageId,
              seq: recalc.sequenceNumber,
              revision: recalc.revision,
              createdAt: recalc.createdAt.getTime(),
            },
          });
        })
        .catch(() => {});
    }

    return { tombstone };
  }

  /**
   * Pin/unpin a PRIVATE or GROUP message and broadcast `pin:updated` to
   * `conv:<roomId>` — identical effect to the REST pin/unpin controllers (which
   * are byte-for-byte identical between Private and Group). New entry point for
   * the socket `message:pin`/`message:unpin` handlers, added for parity with
   * community's `community:message:pin`/`unpin` socket RPCs.
   */
  async pinDirect(params: PinDirectParams): Promise<PinDirectResult> {
    const conversationType = resolveConversationType(
      params.roomId,
      params.conversationType
    );
    const pinArgs = {
      roomId: params.roomId,
      messageId: params.messageId,
      userId: params.userId,
    };
    const result =
      conversationType === "GROUP"
        ? await this.groupPinService.pin(pinArgs)
        : await this.privatePinService.pin(pinArgs);

    const pinnedAt =
      result.pin.pinnedAt instanceof Date
        ? result.pin.pinnedAt.getTime()
        : Date.now();
    await this.redis.publish(
      `conv:${params.roomId}`,
      JSON.stringify({
        event: "pin:updated",
        data: {
          roomId: params.roomId,
          conversationId: params.roomId,
          messageId: params.messageId,
          pinnedBy: params.userId,
          pinnedAt,
          action: "pinned",
          pinnedCount: result.pinnedCount,
          // Same snapshot text the REST pin path publishes — the socket and REST
          // pin entry points must produce byte-identical broadcasts.
          text:
            (result.pin.contentPinned as unknown as { text?: string } | null)
              ?.text ?? "",
        },
      })
    );

    return result as unknown as PinDirectResult;
  }

  async unpinDirect(params: PinDirectParams): Promise<UnpinDirectResult> {
    const conversationType = resolveConversationType(
      params.roomId,
      params.conversationType
    );
    const pinArgs = {
      roomId: params.roomId,
      messageId: params.messageId,
      userId: params.userId,
    };
    const result =
      conversationType === "GROUP"
        ? await this.groupPinService.unpin(pinArgs)
        : await this.privatePinService.unpin(pinArgs);

    await this.redis.publish(
      `conv:${params.roomId}`,
      JSON.stringify({
        event: "pin:updated",
        data: {
          roomId: params.roomId,
          conversationId: params.roomId,
          messageId: params.messageId,
          unpinnedBy: params.userId,
          action: "unpinned",
          pinnedCount: result.pinnedCount,
        },
      })
    );

    return result;
  }

  /**
   * Mark a PRIVATE or GROUP conversation read up to `upToMessageId` and run the
   * identical post-write effects the gRPC `markMessagesRead` handler performs:
   *   1. advance the reader's read high-water mark (private room read pointer or
   *      group-member read pointer);
   *   2. resolve the `read_to_seq` from the message's per-room sequenceNumber;
   *   3. broadcast `message:read` to conv:<roomId> (the other participant(s));
   *   4. fan out `read_sync` to user:<readerId> so the reader's OTHER devices
   *      clear their unread badge (fire-and-forget).
   * Mirrors the gRPC handler exactly so the REST and gRPC read paths produce the
   * SAME side-effects through ONE code path. (Community read is coarser and has
   * no socket broadcast today, so it intentionally does NOT route through here —
   * the community controller calls communityMessageService.bulkMarkRead directly.)
   */
  async markReadDirect(
    params: MarkReadDirectParams
  ): Promise<MarkReadDirectResult> {
    const conversationType = resolveConversationType(
      params.roomId,
      params.conversationType
    );

    // Assigned in both branches below before it's read — no initializer needed.
    let readToSeq: number;
    let unreadCount: number;
    // The room's CURRENT last-message seq, and every OTHER active
    // participant/member (the sender(s) whose OWN tick needs to flip to READ) —
    // mirrors the gRPC `markMessagesRead` handler exactly, see its comments.
    // Assigned in both branches below before read — no initializer needed.
    let lastMessageSeq: number;
    let otherUserIds: string[];
    // Started BEFORE the mark-read write — see the identical comment in the
    // gRPC `markMessagesRead` handler.
    const mayBroadcastPromise = mayBroadcastReadReceipts(params.readerId);
    if (conversationType === "GROUP") {
      const groupRead = await this.groupMessageService.markReadUpTo({
        roomId: params.roomId,
        userId: params.readerId,
        upToMessageId: params.upToMessageId,
      });
      readToSeq = groupRead.readToSeq;
      unreadCount = groupRead.remainingUnread;
      const [members, lastSeq] = await Promise.all([
        this.groupMessageService
          .getActiveMemberIds(params.roomId)
          .catch(() => [] as string[]),
        this.groupMessageService
          .getRoomLastMessageSeq(params.roomId)
          .catch(() => 0),
      ]);
      otherUserIds = members.filter((id) => id !== params.readerId);
      lastMessageSeq = lastSeq;
    } else {
      // Both branches are now self-guarding: `markReadUpTo` (group) resolves the
      // member row and returns seq 0 for a non-member, and `markRead` (private)
      // asserts participation and binds the target to the room before touching
      // anything. The participation check used to live HERE and only here, so
      // the gRPC `markMessagesRead` handler — a second copy of this flow —
      // reached the room write unguarded.
      const room = (await this.privateMessageService.markRead({
        roomId: params.roomId,
        userId: params.readerId,
        lastMessageId: params.upToMessageId,
      })) as {
        unreadCountByUser?: Record<string, number>;
        participants?: string[];
        lastMessageId?: string | null;
        lastReadMessageIdByUser?: Record<string, string>;
      } | null;
      // A target that is malformed, or belongs to another room, is REJECTED —
      // null result. Returning here is what makes "zero unread mutation, zero
      // socket fan-out" true: everything below this point publishes.
      if (!room) return { readToSeq: 0 };
      unreadCount = room?.unreadCountByUser?.[params.readerId] ?? 0;
      otherUserIds = (room?.participants ?? []).filter(
        (id) => id !== params.readerId
      );
      // read_to_seq is the PERSISTED watermark, never the requested target.
      // `markReadUpTo` is forward-only, so a stale/out-of-order request (a
      // second device catching up, a jump-to-message landing on old history)
      // leaves the pointer where it was — publishing the request's own seq
      // would broadcast a REGRESSION the DB never made, flipping the sender's
      // blue tick back to grey and re-inflating the reader's other devices'
      // badge until a refresh. Falls back to the request only for legacy rows
      // that have no pointer yet.
      const acceptedReadId =
        room?.lastReadMessageIdByUser?.[params.readerId] ??
        params.upToMessageId;
      // Independent lookups — run together, not one after the other.
      [readToSeq, lastMessageSeq] = await Promise.all([
        this.privateMessageService
          .getMessageSequence(acceptedReadId)
          .catch(() => 0),
        room?.lastMessageId
          ? this.privateMessageService
              .getMessageSequence(room.lastMessageId)
              .catch(() => 0)
          : Promise.resolve(0),
      ]);
    }

    // Authoritative "this reader has now read the room's current newest
    // message" — the single flag the sender's inbox row keys off, so it never
    // has to id-match a stale cached boundary.
    const readsLastMessage =
      readToSeq > 0 && lastMessageSeq > 0 && readToSeq >= lastMessageSeq;

    const readPayload = JSON.stringify({
      event: "message:read",
      data: {
        conversationId: params.roomId,
        readerId: params.readerId,
        upToMessageId: params.upToMessageId,
        read_to_seq: readToSeq,
        last_message_seq: lastMessageSeq,
        readsLastMessage,
      },
    });

    // Settings → Chat → Read Receipt, off: the read still happens (the reader's
    // own unread badge and `read_sync` below are unaffected) — only the OUTBOUND
    // receipt is withheld, so nobody learns this user read them.
    const mayBroadcast = await mayBroadcastPromise;

    // Read receipt to the conversation room. read_to_seq lets the peer flip EVERY own row at or
    // below the boundary to READ (watermark), not just the boundary message.
    if (mayBroadcast)
      await this.redis.publish(`conv:${params.roomId}`, readPayload);

    // ALSO publish directly to every other participant/member's own
    // `user:<id>` channel — the conversation-LIST view only joins `conv:*`
    // rooms it's currently rendering, so without this direct delivery a
    // sender's list row misses the READ tick whenever their sidebar socket
    // wasn't (yet) joined to this specific room. Mirrors the gRPC handler.
    for (const otherId of mayBroadcast ? otherUserIds : []) {
      void this.redis
        .publish(`user:${otherId}`, readPayload)
        .catch((e: unknown) =>
          logger.warn(
            `message:read direct publish failed userId=${otherId}: ${String(e)}`
          )
        );
    }

    // read_sync to the reader's OWN other devices so their unread badge clears
    // too. Published to user:<readerId> (every device of that user joins this
    // room on connect). Fire-and-forget — never blocks/rejects the read.
    void this.redis
      .publish(
        `user:${params.readerId}`,
        JSON.stringify({
          event: "read_sync",
          data: {
            conversationId: params.roomId,
            readerId: params.readerId,
            read_to_seq: readToSeq,
            unreadCount,
            conversationType,
          },
        })
      )
      .catch((e: unknown) =>
        logger.warn(`read_sync publish failed: ${String(e)}`)
      );

    // Nav-badge total changed for the reader — see unread-summary-bridge.ts.
    notifyUnreadChanged(params.readerId);

    // Dismiss this conversation's tray notification on the reader's other devices. read_sync
    // above only reaches live sockets; a backgrounded device needs a push to clear.
    publishConversationReadSafe({
      readerId: params.readerId,
      conversationId: params.roomId,
      conversationType,
      readAt: Date.now(),
    });

    return { readToSeq };
  }

  /**
   * React to / un-react from a PRIVATE or GROUP message over REST and run the
   * identical effect the gRPC `sendReaction` handler performs — broadcast the
   * full `ChatReactionGroup[]` (`message:reaction`) on conv:<roomId> with reactor
   * avatars resolved-on-read — so the REST and socket reaction paths produce the
   * SAME side-effect through ONE place.
   *
   * The underlying `service.react()` is a TOGGLE; this wrapper makes POST=add and
   * DELETE=remove IDEMPOTENT by first reading whether the caller already reacted
   * with `emoji` and only toggling when the op would actually change state:
   *   - op:"add"    && not present → react() (toggles ON)
   *   - op:"remove" && present     → react() (toggles OFF)
   *   - otherwise                  → NO-OP (no write, no re-read, no broadcast)
   *
   * On a true no-op the already-read `before` state is mapped to the SAME
   * ReactionGroup[] and returned (avatars resolved for the response), but NOTHING
   * is published — a duplicate tap returns 200 with the current reactions and
   * fans nothing out, instead of spamming an unchanged set to every subscriber.
   *
   * Authorization lives HERE at the REST boundary (participant for PRIVATE, active
   * member for GROUP) — NOT inside the shared `react()` primitive, which stays
   * un-guarded so the socket/gRPC path (pre-authorized at join) is unchanged.
   *
   * Idempotency note: idempotent under normal SEQUENTIAL use; best-effort under
   * concurrent races — `react()` is a non-transactional read-modify-write toggle,
   * so two concurrent same-user same-emoji POSTs can both observe `!already` and
   * double-toggle (net OFF). A true fix would be an atomic `$addToSet`/`$pull`
   * (out of scope here).
   */
  async reactDirect(params: ReactDirectParams): Promise<ReactDirectResult> {
    const conversationType = resolveConversationType(
      params.roomId,
      params.conversationType
    );

    // Authorize the caller at the REST boundary (same rule as the read paths).
    if (conversationType === "GROUP") {
      // Write boundary — also rejects a moderation-muted member.
      await this.groupMessageService.assertCanWrite(
        params.roomId,
        params.userId
      );
    } else {
      await this.privateMessageService.assertParticipant(
        params.roomId,
        params.userId
      );
    }

    const service =
      conversationType === "GROUP"
        ? this.groupMessageService
        : this.privateMessageService;

    // Bind the message to the room BEFORE any reaction read/write: react() and
    // getMessageReactions both address the row by id ALONE, so without this a
    // caller authorized for `roomId` could pass a messageId from a room they're
    // NOT in and mutate + broadcast that foreign message. Throws NotFound on
    // miss/mismatch (closes the cross-room IDOR).
    if (conversationType === "GROUP") {
      await this.groupMessageService.assertMessageInRoom(
        params.roomId,
        params.messageId
      );
    } else {
      await this.privateMessageService.assertMessageInRoom(
        params.roomId,
        params.messageId
      );
    }

    // Map a getMessageReactions result → canonical ChatReactionGroup[] with
    // reactor avatars resolved-on-read. Shared by the no-op return and the
    // post-toggle broadcast/return so both surfaces emit the identical shape.
    const toResolvedGroups = async (state: {
      reactions: Record<
        string,
        {
          count: number;
          users: { userId: string; displayName: string; avatar: string }[];
        }
      >;
    }): Promise<ReactionGroup[]> => {
      const groups = Object.entries(state.reactions).map(([emoji, d]) => ({
        emoji,
        count: d.count,
        users: d.users,
      }));
      const avatarMap = await resolveMediaUrlMap(
        groups.flatMap((g) => g.users.map((u) => u.avatar))
      );
      return groups.map((g) => ({
        emoji: g.emoji,
        count: g.count,
        users: g.users.map((u) => ({
          userId: u.userId,
          displayName: u.displayName,
          avatarUrl: urlFromMap(avatarMap, u.avatar),
        })),
      }));
    };

    // 1. Read current state to decide whether the toggle must fire (idempotency).
    const before = await service.getMessageReactions({
      messageId: params.messageId,
      roomId: params.roomId,
      requesterId: params.userId,
    });
    const already =
      before.reactions[params.emoji]?.selfReacted ??
      (before.reactions[params.emoji]?.users.some(
        (u) => u.userId === params.userId
      ) ||
        false);

    // 2. Decide whether the op would actually change state. "set" always writes:
    //    it must also clear whatever OTHER emoji the caller currently holds, which
    //    the `already` probe (single-emoji) cannot rule out.
    const shouldToggle =
      params.op === "set" ||
      (params.op === "add" && !already) ||
      (params.op === "remove" && already);

    // 3a. NO-OP (duplicate add / absent remove): return the already-read state,
    //     avatars resolved for the response — but DO NOT re-read or publish.
    if (!shouldToggle) {
      return { reactions: await toResolvedGroups(before) };
    }

    // 3b. State-changing op: CAS-toggle (see PrivateMessageService.reactCas /
    //     GroupMessageService.reactCas), re-read, then broadcast message:reaction
    //     exactly like the gRPC sendReaction handler. "set" lands the caller on
    //     exactly this emoji in ONE write, so no intermediate empty set is observed.
    const write =
      params.op === "set"
        ? service.setReactionDetailed.bind(service)
        : service.reactToMessage.bind(service);
    const toggled = await write({
      messageId: params.messageId,
      userId: params.userId,
      emoji: params.emoji,
    });
    const after = await service.getMessageReactions({
      messageId: params.messageId,
      roomId: params.roomId,
      requesterId: params.userId,
    });
    const resolvedGroups = await toResolvedGroups(after);

    await this.redis.publish(
      `conv:${params.roomId}`,
      JSON.stringify({
        event: "message:reaction",
        data: {
          messageId: params.messageId,
          conversationId: params.roomId,
          reactions: resolvedGroups,
        },
      })
    );

    // WhatsApp-style lastActivity bump/revert — fire-and-forget, never blocks
    // the reaction response (mirrors every other post-write side-effect here).
    void this.bumpReactionActivity({
      conversationType,
      roomId: params.roomId,
      messageId: params.messageId,
      emoji: params.emoji,
      actorId: params.userId,
      added: toggled.added,
      targetUserId: toggled.targetUserId,
      targetMessagePreview: toggled.targetMessagePreview,
    }).catch((err: unknown) =>
      logger.warn(`reactDirect activity bump failed: ${String(err)}`)
    );

    return { reactions: resolvedGroups };
  }

  /**
   * WhatsApp-style reaction lastActivity bump/revert — shared by REST
   * `reactDirect` and the gRPC `sendReaction` handler so both transports
   * produce the identical side-effect through ONE place. Mirrors
   * CommunityMessageService.reactToMessage's community:updated bump, but
   * scoped to chat-service's own PrivateRoom/GroupRoom (no cross-service RPC
   * needed — reaction and room live in the same service/DB here).
   *
   * On add: persists the reaction OVERLAY (self+target personalized text;
   * NEVER touches the canonical lastMessage/lastMessageAt columns) and
   * publishes `conv:updated` to ONLY the actor (+ target, if different) — the
   * overlay is invisible to every other participant/member, same as community.
   *
   * On remove: clears the overlay IFF it still identifies this exact reaction
   * (identity-gated, mirrors community), then re-publishes the room's
   * untouched canonical last message to the same [actor(+target)] pair so
   * their client reverts off the "reacted to" line.
   */
  async bumpReactionActivity(params: {
    conversationType: "PRIVATE" | "GROUP";
    roomId: string;
    messageId: string;
    emoji: string;
    actorId: string;
    added: boolean;
    targetUserId: string;
    targetMessagePreview: string;
  }): Promise<void> {
    const service =
      params.conversationType === "GROUP"
        ? this.groupMessageService
        : this.privateMessageService;
    const isSelfReaction =
      !params.targetUserId || params.targetUserId === params.actorId;
    const recipients = isSelfReaction
      ? [params.actorId]
      : [params.actorId, params.targetUserId];

    if (params.added) {
      const { senderName: actorName } = await this.resolveSenderIdentity(
        params.actorId
      );
      const reactedAt = new Date();
      const { selfPreview, targetPreview } = buildReactionActivityText({
        actorName,
        targetMessagePreview: params.targetMessagePreview,
        emoji: params.emoji,
        isSelfReaction,
      });

      await service.setReactionActivity(params.roomId, {
        messageId: params.messageId,
        emoji: params.emoji,
        actorId: params.actorId,
        actorPreview: selfPreview,
        targetId: isSelfReaction ? null : params.targetUserId,
        targetPreview: isSelfReaction ? null : targetPreview,
        reactedAt,
      });

      publishConvUpdatedSafe({
        redis: this.redis,
        type: params.conversationType,
        roomId: params.roomId,
        recipientIds: recipients,
        senderId: params.actorId,
        senderName: actorName,
        lastMessageId: params.messageId,
        lastMessageAt: reactedAt.getTime(),
        preview: { contentType: "SYSTEM", text: selfPreview },
        countInUnread: false,
        resolveOverrides: () =>
          Promise.resolve(
            isSelfReaction
              ? new Map()
              : new Map([
                  [
                    params.targetUserId,
                    {
                      lastMessageId: params.messageId,
                      lastMessageAt: reactedAt.getTime(),
                      senderId: params.actorId,
                      senderName: actorName,
                      preview: { contentType: "SYSTEM", text: targetPreview },
                    },
                  ],
                ])
          ),
      });
      return;
    }

    // Removed — clear the overlay IF this exact reaction is the one currently
    // shown (identity match; a no-op otherwise, mirrors community).
    await service.clearReactionActivityIfCurrent(params.roomId, {
      messageId: params.messageId,
      emoji: params.emoji,
      actorId: params.actorId,
    });

    // Revert bump: republish the room's own untouched canonical last message
    // so a client that applied the reaction-add bump reverts to reality. A
    // fresh Date.now() timestamp (not the real message's own older createdAt)
    // guarantees a client that only applies bumps newer than what it already
    // has doesn't silently drop this revert.
    const snapshot = (await service.getRoomBumpSnapshot(params.roomId)) as {
      lastMessageId: string | null;
      lastMessageAt: number;
      senderId: string;
      senderName?: string;
      content: unknown;
      messageType: string;
    } | null;
    const revertAt = Date.now();
    const revertSenderName = snapshot
      ? (snapshot.senderName ??
        (await this.resolveSenderIdentity(snapshot.senderId)).senderName)
      : "";
    publishConvUpdatedSafe({
      redis: this.redis,
      type: params.conversationType,
      roomId: params.roomId,
      recipientIds: recipients,
      senderId: snapshot?.senderId ?? "",
      senderName: revertSenderName,
      lastMessageId: snapshot?.lastMessageId ?? "",
      lastMessageAt: snapshot?.lastMessageAt ?? revertAt,
      preview: snapshot
        ? {
            contentType: normalizeMessageType(snapshot.messageType),
            text: convertMessageToPreview(
              snapshot.messageType,
              snapshot.content
            ),
          }
        : { contentType: "", text: "" },
      countInUnread: false,
    });
  }

  /**
   * Resolve a sender's display name + avatar from the user snapshot when the
   * caller did not already supply them. The snapshot keeps the RAW avatar object
   * key — callers/broadcasts resolve it to a download URL at the read boundary.
   * Best-effort: a snapshot miss yields empty strings (never throws).
   */
  private async resolveSenderIdentity(
    senderId: string,
    senderName?: string,
    senderAvatar?: string
  ): Promise<{ senderName: string; senderAvatar: string }> {
    return resolveSenderIdentity(
      this.userSnapshotService,
      this.cacheRepo,
      senderId,
      senderName,
      senderAvatar
    );
  }

  /**
   * Resolve attachment object-keys inside a message `content` blob to full,
   * presigned download URLs for a realtime broadcast. Resolve-on-read at the
   * publish boundary — the stored content keeps the raw object keys (presigned
   * URLs expire, so a resolved URL must never be persisted). Mirrors the gRPC
   * service-impl helper of the same name.
   */
  private async resolveBroadcastContent(content: unknown): Promise<unknown> {
    if (!content || typeof content !== "object") return content;
    const c = content as Record<string, unknown>;
    const hasFiles = Array.isArray(c.files) && c.files.length > 0;
    // `content.sticker` lives outside files[]; REST history already resolves it
    // (`resolveStickerField`), so the live broadcast must too.
    const sticker =
      c.sticker && typeof c.sticker === "object"
        ? (c.sticker as MediaFileLike)
        : null;
    if (!hasFiles && !sticker) return content;
    try {
      const [files, stickerUrl] = await Promise.all([
        hasFiles
          ? resolveContentFiles(c.files as MediaFileLike[])
          : Promise.resolve(null),
        sticker ? resolveMediaUrl(fileMediaKey(sticker)) : Promise.resolve(""),
      ]);
      return {
        ...c,
        ...(files ? { files } : {}),
        ...(sticker && stickerUrl
          ? { sticker: { ...sticker, url: stickerUrl } }
          : {}),
      };
    } catch (err) {
      logger.warn(
        `ChatMessageOrchestrator|resolveBroadcastContent failed: ${String(err)}`
      );
      return content;
    }
  }

  /**
   * Resolve a reply's `quoteData.thumbnail` object-key to a full download URL
   * for the send-ACK/broadcast payload — same resolve-on-read contract as
   * {@link resolveBroadcastContent}, applied via {@link buildCanonicalQuote}
   * (single canonical shape) then a single-key {@link resolveMediaUrl}.
   */
  private async resolveBroadcastQuote(
    raw: unknown
  ): Promise<CanonicalQuote | null> {
    const quote = buildCanonicalQuote(raw);
    if (!quote) return null;
    if (!quote.thumbnail) return quote;
    const urlMap = await resolveMediaUrlMap([quote.thumbnail]);
    return resolveQuoteThumbnail(quote, urlMap);
  }

  /**
   * Resolve-on-read for a `sticker` attachment pulled out via
   * {@link firstAttachmentOfType}: it lives outside `content.files[]`, so
   * unlike files it is never touched by `resolveContentFiles`. Without this,
   * the live broadcast would echo the sticker's raw stored value (an
   * internal objectKey OR, for GIF/Sticker providers like Giphy/Tenor, a
   * full external URL) with no `url` ever stamped.
   */
  private async resolveStickerAttachment(
    sticker: Record<string, unknown> | undefined
  ): Promise<Record<string, unknown> | undefined> {
    if (!sticker) return sticker;
    const url = await resolveMediaUrl(fileMediaKey(sticker as MediaFileLike));
    return url ? { ...sticker, url } : sticker;
  }

  /**
   * Pick the first attachment of a given structured `type` (location / contact /
   * sticker) from a community attachments array, returning it without the `type`
   * discriminator so the broadcast/preview shape matches the gRPC handler's
   * `parsed.location` / `parsed.contact` / `parsed.sticker` blobs.
   */
  private firstAttachmentOfType(
    attachments: Array<Record<string, unknown>> | undefined,
    type: string
  ): Record<string, unknown> | undefined {
    if (!Array.isArray(attachments)) return undefined;
    const hit = attachments.find(
      (a) => a && (a as { type?: string }).type === type
    );
    if (!hit) return undefined;
    const { type: _omit, ...rest } = hit as { type?: string } & Record<
      string,
      unknown
    >;
    void _omit;
    return rest;
  }
}
