import { logger } from "@aimess/logger";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from "@aimess/errors";
import { redis } from "../config/redis.js";
import { notifyUnreadChanged } from "../events/unread-summary-bridge.js";
import { mayBroadcastReadReceipts } from "../lib/account-chat-settings.js";
import {
  assertMaySeeReadReceipts,
  buildReadReceipts,
  readersAtOrPast,
  type ReadReceiptsPayload,
} from "../lib/read-receipts.js";

import {
  CHAT_EDIT_WINDOW_MS,
  CHAT_TEXT_MAX_CHARS,
  assertAttachmentsValid,
} from "../constants/media-limits.js";
import { assertAttachmentsVerified } from "../lib/attachment-guard.js";
import {
  DELETED_ACCOUNT_DISPLAY_NAME,
  buildCommunitySystemFallbackText,
  currentLocale,
  isCommunityContentType,
  sanitizeCommunitySystemMetadata,
  type CommunitySystemMessageType,
} from "@aimess/constants";
import {
  anonymizeSystemData,
  anonymizeWireSender,
  collectDeletedUserIds,
  collectRowUserIds,
} from "../lib/deleted-identity.js";
import { env } from "../config/env.js";

import type { GeneralRoomMessageRepository } from "../repositories/general-room-message.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type {
  GeneralRoomMessage,
  RoomMember,
} from "../generated/prisma/index.js";
import {
  normalizeMessageType,
  toggleStoredReaction,
  // setStoredReaction,
  reactionUserIdMap,
  buildReactionGroups,
  type ReactionGroup,
  type StoredReactor,
  toWireMessage,
  buildCanonicalQuote,
  tombstoneWireFields,
  buildReplyQuoteSnapshot,
  buildReplyPreviewText,
  type CanonicalQuote,
} from "../lib/chat-message.serializer.js";
import {
  convertMessageToPreview,
  buildReactionTargetPreview,
} from "./message-preview.service.js";
import {
  resolveVisibleLastBulk,
  resolveForEveryoneOverrides,
  deletedWasEffectiveLast,
  type VisibilitySource,
  type RecipientOverride,
} from "./last-visible-resolver.js";
import { communityVisibilitySource } from "./last-visible-adapters.js";
import type { CommunitySystemMessageService } from "./community-system-message.service.js";
import {
  assertCommunityMember,
  assertCommunityMemberNotMuted,
  assertCommunityReadAccess,
  assertCommunityRoomWritable,
  assertRoomMemberActive,
  getCommunityLiveRole,
  canDeleteOthersMessage,
} from "../lib/access-guard.js";
import {
  EMPTY_AROUND_CURSORS,
  type AroundCursors,
} from "../lib/around-cursors.js";
import {
  makeTimelineAdapter,
  type PaginationCursor,
} from "../lib/timeline-pagination.js";
import { isDuplicateKeyError } from "../lib/db-errors.js";
import {
  attachAlbumMessages,
  markAlbumIdempotentReplay,
  resolveParentMessageId,
  resolveReplyAttachmentCount,
} from "../lib/album-messages.js";
import { splitCommunityMediaAlbum } from "../lib/split-media-album.js";
import {
  resolveMediaUrlMap,
  urlFromMap,
  applyUrlMapToFiles,
  fileMediaKeys,
  resolveQuoteThumbnail,
  type MediaFileLike,
} from "../lib/media-resolve.js";
import { shouldCountInUnread } from "../lib/unread-count.js";

/**
 * Client-facing community message row: the raw Prisma entity with its
 * LOWER-CASE `messageType` dropped and replaced by an UPPER-CASE `contentType`
 * (§1 single client-facing casing). Used as the return element of every REST
 * read path so HTTP clients never see the internal `messageType` field.
 *
 * Intentionally has NO `readBy`/`deliveredTo` — the frontend no longer
 * consumes per-message delivery/read receipts on history reads (only the
 * lighter-weight `community:message:read` live event + room-level unread
 * counters are used), so `toWire` never computes or attaches them and they
 * are omitted from the JSON response entirely (not `null`/`[]`).
 */
type CommunityMessageWire = Omit<
  GeneralRoomMessage,
  "messageType" | "visibleToUserId"
> & {
  contentType: string;
  /** True for user-scoped SYSTEM messages (e.g. "You joined the community"). */
  isPersonal?: boolean;
  /** Canonical reaction shape — see `toWire`. */
  reactionGroups?: ReactionGroup[];
};

/** Per-community chat summary for the GET /communities/mine enrichment. */
export interface CommunityChatSummary {
  communityId: string;
  unreadMessageCount: number;
  /** Oldest unread message id, so the client can jump to it. Null iff unreadMessageCount === 0. */
  firstUnreadMessageId: string | null;
  /** false => the caller should render lastMessageActivity as null. */
  hasLastMessage: boolean;
  /**
   * True when the viewer has globally/personally HIDDEN the community-wide shared
   * last message, so `lastMessage` (or its absence) is an AUTHORITATIVE per-viewer
   * resolution — community-service must use it directly, NOT merely overlay it
   * when newer. When false, `lastMessage` is the plain shared snapshot and the
   * denormalized column wins on ties (only a strictly-newer chat message overrides,
   * which repairs lost-`community.activity`-event missed-ADD staleness).
   */
  perUserResolved: boolean;
  /**
   * The latest message visible to THIS viewer (community-wide last, or — when the
   * viewer hid it — their previous-visible fallback). Carries its REAL timestamp;
   * `isSystem` selects sender-less rendering; `userId` is the sender for the
   * "username: message" message shape. Absent when no visible message remains.
   */
  lastMessage?: {
    username: string;
    message: string;
    /** epoch ms */
    dateTime: number;
    isSystem: boolean;
    userId: string;
  };
  /**
   * The viewer's latest PERSONAL system line (e.g. "You joined the community"),
   * visible only to this user. community-service overlays it onto the per-viewer
   * /communities/mine lastActivity when it is newer than the community-wide
   * activity, so the joiner sees their own join line while others do not. Absent
   * when the viewer has no personal line in that community. Always sender-less.
   */
  personalLastMessage?: {
    message: string;
    /** epoch ms */
    dateTime: number;
  };
}

/** A viewer is an active member when their loaded RoomMember row is "active".
 *  Drives the membership-session read guard (`viewerIsActiveMember`) — a left /
 *  non-member (PUBLIC) reader must not see their own prior-session join line. */
function isActiveMember(
  member: { status?: string | null } | null | undefined
): boolean {
  return member?.status === "active";
}

/** Denormalized last-message JSON stored on a GeneralRoom. */
interface RoomLastMessageJson {
  content?: string;
  senderId?: string;
  senderName?: string;
  messageType?: string;
  createdAt?: string | Date;
}

export class CommunityMessageService {
  constructor(
    private readonly messageRepo: GeneralRoomMessageRepository,
    private readonly roomRepo: GeneralRoomRepository,
    private readonly memberRepo: RoomMemberRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    /**
     * Optional — when provided, pin/unpin emit PINNED_MESSAGE / UNPINNED_MESSAGE
     * SYSTEM lines. Optional so the many 5-arg construction sites (tests,
     * app-factory) keep working untouched; production wires it in server.ts.
     */
    private readonly systemMessageService?: CommunitySystemMessageService
  ) {}

  /**
   * Idempotently provision (or re-activate) a community's chat room
   * (GeneralRoom, id === communityId). Invoked synchronously by community-service
   * at creation time via gRPC so a member's first send can't race ahead of the
   * async `community.created` event (which remains a backstop). Delegates to the
   * same repository upsert the event consumer and boot reconciler use, so all
   * three provisioning paths produce identical rows.
   */
  async provisionRoom(params: {
    communityId: string;
    name: string;
    owner?: string | null;
    logo?: string | null;
  }): Promise<void> {
    await this.roomRepo.provisionForCommunity(params.communityId, {
      name: params.name,
      owner: params.owner ?? null,
      logo: params.logo ?? null,
    });
  }

  /**
   * Moderation snapshot of a single community message — for the report card.
   * Reads the RAW row (no URL resolution) so the caller persists RAW object
   * keys and resolves them to presigned URLs on read. Scoped by roomId as an
   * IDOR guard; `found:false` for a missing / cross-room / deleted-for-all id.
   */
  async getModerationSnapshot(params: {
    roomId: string;
    messageId: string;
  }): Promise<{
    found: boolean;
    message: string;
    contentType: string;
    sentAt: number;
    senderId: string;
    media: {
      objectKey: string;
      contentType: string;
      fileName: string;
      size: number;
    }[];
  }> {
    const empty = {
      found: false,
      message: "",
      contentType: "",
      sentAt: 0,
      senderId: "",
      media: [] as {
        objectKey: string;
        contentType: string;
        fileName: string;
        size: number;
      }[],
    };
    const msg = await this.messageRepo.findById(params.messageId);
    if (!msg || msg.roomId !== params.roomId || msg.deletedForAll) {
      return empty;
    }
    const atts = Array.isArray(msg.attachments)
      ? (msg.attachments as Record<string, unknown>[])
      : [];
    const media = atts
      .map((a) => ({
        objectKey: String(a.objectKey ?? ""),
        contentType: String(a.contentType ?? a.mimeType ?? ""),
        fileName: String(a.fileName ?? a.name ?? ""),
        size: typeof a.size === "number" ? a.size : 0,
      }))
      .filter((m) => m.objectKey);
    return {
      found: true,
      message: msg.message ?? "",
      contentType: normalizeMessageType(msg.messageType),
      sentAt:
        msg.createdAt instanceof Date ? msg.createdAt.getTime() : Date.now(),
      senderId: msg.sentBy,
      media,
    };
  }

  /** Community display name, mirrored locally on GeneralRoom.name. Empty string on a miss. */
  async getRoomName(roomId: string): Promise<string> {
    const room = await this.roomRepo.findRoomById(roomId);
    return room?.name ?? "";
  }

  async sendMessage(params: {
    roomId: string;
    sentBy: string;
    senderName: string;
    senderAvatar: string;
    message: string;
    messageType: string;
    parentMessageId?: string | null;
    clientMessageId?: string | null;
    attachments?: Array<Record<string, unknown>>;
    /** Set by `forwardMessage` so the row keeps forward provenance, matching
     * Private/Group's `isForwarded`/`forwardData` — never set on a regular send. */
    forwardData?: Record<string, unknown> | null;
  }): Promise<GeneralRoomMessage> {
    // Defensive caps (the gRPC/socket send path doesn't run the Zod validators,
    // including the `.refine(isCommunityContentType)` the REST schema carries
    // — mirror it here so an unrecognized type is rejected the same way on
    // every send path, not just REST).
    if ((params.message?.length ?? 0) > CHAT_TEXT_MAX_CHARS) {
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    }
    if (!isCommunityContentType(params.messageType || "")) {
      throw new BadRequestError("CHAT_UNSUPPORTED_CONTENT_TYPE");
    }
    assertAttachmentsValid(params.messageType, params.attachments);
    // See private-message.service.ts — this verifies the OBJECT (scan verdict,
    // uploader, room scope), not just the client-declared size/duration.
    await assertAttachmentsVerified({
      resourceId: params.roomId,
      senderId: params.sentBy,
      files: params.attachments,
    });

    // Guard: block sends to suspended or deactivated rooms. "suspended" means
    // the community was closed (owner status=CLOSED or platform SUSPENDED);
    // "inactive" means it was deleted. This check runs before idempotency so a
    // closed-community retry never returns a previously-cached message as if the
    // send succeeded. Single source of truth for community write-ability.
    const room = await this.roomRepo.findRoomById(params.roomId);
    assertCommunityRoomWritable(room);

    // Sender must be an ACTIVE community member. A BANNED (or LEFT) member's
    // RoomMember row is mirrored as non-"active" by the community sync consumer,
    // so this rejects banned users with CHAT_NOT_A_MEMBER. Read/edit/delete/
    // react/pin paths already guard this way; send is the write chokepoint.
    const sender = await assertCommunityMember(
      this.memberRepo,
      params.roomId,
      params.sentBy
    );
    // …and not moderation-muted. Reuses the row just loaded (no extra I/O); the
    // mute is mirrored from community-service, so this blocks every send path
    // (gateway socket → gRPC, REST orchestrator, direct gRPC) including media,
    // GIF, sticker, voice and file messages (all funnel through here).
    assertCommunityMemberNotMuted(sender);

    // Check idempotency (album batches use `base:N` sibling clientMessageIds).
    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.sentBy}:${params.clientMessageId}`;
      const cachedId = await this.cacheRepo.getMessageIdempotency(idemKey);
      if (cachedId) {
        const cached = await this.messageRepo.findById(cachedId);
        if (cached) {
          const batch = await this.messageRepo.findAlbumBatchByClientMessageId(
            params.roomId,
            params.sentBy,
            params.clientMessageId
          );
          const messages = batch.length > 0 ? batch : [cached];
          return markAlbumIdempotentReplay(
            messages[messages.length - 1]!,
            messages
          );
        }
      }
      const existing = await this.messageRepo.findOne({
        roomId: params.roomId,
        sentBy: params.sentBy,
        clientMessageId: params.clientMessageId,
      });
      if (existing) {
        this.cacheRepo
          .setMessageIdempotency(idemKey, existing.id)
          .catch(() => {});
        const batch = await this.messageRepo.findAlbumBatchByClientMessageId(
          params.roomId,
          params.sentBy,
          params.clientMessageId
        );
        const messages = batch.length > 0 ? batch : [existing];
        return markAlbumIdempotentReplay(
          messages[messages.length - 1]!,
          messages
        );
      }
    }

    const parts = splitCommunityMediaAlbum(
      params.messageType,
      params.message || "",
      params.attachments,
      params.clientMessageId ?? null
    );

    // Validate BEFORE the lookup query (not just before persistence) — an
    // invalid/foreign-shaped id (albumId/mediaId/attachmentId/clientMessageId,
    // anything not a 24-hex ObjectId) must never reach `findById`.
    const resolvedParentId = resolveParentMessageId(params.parentMessageId);
    let quoteData: CanonicalQuote | undefined;
    if (resolvedParentId) {
      const originalMsg = await this.messageRepo.findById(resolvedParentId);
      if (originalMsg) {
        // Album sends are split one-row-per-file (lib/split-media-album.ts),
        // so the parent row's own attachments can never reveal the true
        // album size — look up its sibling batch for IMAGE/VIDEO parents.
        const attachmentCountOverride = ["IMAGE", "VIDEO"].includes(
          normalizeMessageType(originalMsg.messageType)
        )
          ? await resolveReplyAttachmentCount(
              this.messageRepo,
              params.roomId,
              originalMsg.sentBy,
              originalMsg
            )
          : undefined;
        quoteData = buildReplyQuoteSnapshot({
          messageId: originalMsg.id,
          senderId: originalMsg.sentBy,
          senderName: originalMsg.senderName ?? "",
          messageType: originalMsg.messageType,
          content: this.messagePreviewContent(originalMsg),
          isDeleted: Boolean(originalMsg.deletedForAll),
          attachmentCountOverride,
        });
      }
    }

    const created: GeneralRoomMessage[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      // Single atomic $inc for BOTH counters — bursty concurrent sends to one
      // room otherwise contend TWICE on the same GeneralRoom doc (sequence,
      // then revision) and blow past the write-conflict retry budget → the
      // intermittent SERVICE_ERROR ack. Insert bumps the room CHANGE revision
      // too (zero-loss changes feed).
      const { sequenceNumber, revision } =
        await this.roomRepo.allocateSequenceAndRevision(params.roomId);
      const entity: Record<string, unknown> = {
        roomId: params.roomId,
        sentBy: params.sentBy,
        senderName: params.senderName,
        senderAvatar: params.senderAvatar,
        message: part.message,
        messageType: normalizeMessageType(part.messageType),
        parentMessageId: resolvedParentId,
        clientMessageId: part.clientMessageId || null,
        sequenceNumber,
        revision,
        ...(part.attachments.length ? { attachments: part.attachments } : {}),
        ...(i === 0 && quoteData ? { quoteData } : {}),
        ...(params.forwardData
          ? { isForwarded: true, forwardData: params.forwardData }
          : {}),
      };

      try {
        const row = await this.messageRepo.save(
          entity as Parameters<typeof this.messageRepo.save>[0]
        );
        created.push(row);
      } catch (err) {
        if (isDuplicateKeyError(err) && part.clientMessageId) {
          const dup = await this.messageRepo.findOne({
            roomId: params.roomId,
            sentBy: params.sentBy,
            clientMessageId: part.clientMessageId,
          });
          if (dup) {
            const batch =
              params.clientMessageId && i === 0
                ? await this.messageRepo.findAlbumBatchByClientMessageId(
                    params.roomId,
                    params.sentBy,
                    params.clientMessageId
                  )
                : [];
            const messages = batch.length > 0 ? batch : [dup];
            return markAlbumIdempotentReplay(
              messages[messages.length - 1]!,
              messages
            );
          }
        }
        throw err;
      }
    }

    const message = created[created.length - 1]!;

    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.sentBy}:${params.clientMessageId}`;
      this.cacheRepo.setMessageIdempotency(idemKey, message.id).catch(() => {});
    }

    this.roomRepo
      .addLastestMessageToRoom(params.roomId, {
        _id: message.id,
        sentBy: message.sentBy,
        senderName: message.senderName || "",
        message: message.message || "",
        messageType: message.messageType,
        createdAt: message.createdAt,
        clientMessageId: message.clientMessageId,
        sequenceNumber: message.sequenceNumber,
        revision: message.revision,
      })
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|addLastestMessageToRoom failed: ${String(err)}`
        );
      });
    return attachAlbumMessages(message, created);
  }

  /**
   * Offline catch-up: returns missed messages for a community room.
   *
   * Two modes (mutually exclusive — sinceTs takes precedence when both supplied):
   *
   *   sinceTs > 0  — updatedAt-based sweep. Queries via `findUpdatedAtSince`,
   *                  which includes tombstones, edits, and reaction changes.
   *                  Returns `nextTs` (epoch-ms of last event's updatedAt) for
   *                  continued paging.
   *
   *   sinceId      — ObjectId insertion-order query via `findSinceId`.  Includes
   *                  tombstones (deletedForAll=true) so clients can reconcile
   *                  offline deletes.  nextTs is 0 in this mode.
   *
   * Authorizes that the requesting user is an active member before querying.
   */
  async catchup(params: {
    roomId: string;
    userId: string;
    sinceId: string;
    sinceTs?: Date;
    /**
     * ZERO-LOSS revision mode (highest precedence). When set, returns every
     * message whose room CHANGE `revision > sinceRevision` — inserts AND
     * mutations (edits/deletes/reactions) — via the same core as the REST
     * `/changes` feed. `lastRevision`/`roomRevision`/`resetRequired` are then
     * meaningful; id/ts modes leave them at 0/false.
     */
    sinceRevision?: number;
    limit: number;
  }): Promise<{
    events: GeneralRoomMessage[];
    hasMore: boolean;
    lastId: string;
    nextTs: number;
    authorized: boolean;
    lastRevision: number;
    roomRevision: number;
    resetRequired: boolean;
  }> {
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active") {
      return {
        events: [],
        hasMore: false,
        lastId: params.sinceId,
        nextTs: 0,
        authorized: false,
        lastRevision: 0,
        roomRevision: 0,
        resetRequired: false,
      };
    }

    // P2 §13: max 100 events per room per catchup to prevent oversized payloads.
    const limit = Math.min(Math.max(params.limit || 100, 1), 100);

    // Revision mode — the mutation-aware, gap-safe catch-up axis (preferred).
    if (params.sinceRevision != null) {
      const changes = await this.resolveChanges({
        roomId: params.roomId,
        userId: params.userId,
        sinceRevision: params.sinceRevision,
        limit,
        viewerIsActiveMember: true,
        readCutoff: null,
      });
      return {
        events: changes.messages,
        hasMore: changes.hasMore,
        lastId:
          changes.messages.length > 0
            ? changes.messages[changes.messages.length - 1]!.id
            : params.sinceId,
        nextTs: 0,
        authorized: true,
        lastRevision: changes.nextRevision ?? params.sinceRevision,
        roomRevision: changes.roomRevision,
        resetRequired: changes.resetRequired,
      };
    }

    // since_ts mode: updatedAt-based query that catches all mutation types.
    if (params.sinceTs && !Number.isNaN(params.sinceTs.getTime())) {
      const { messages: tsMessages, hasMore } =
        await this.messageRepo.findUpdatedAtSince({
          roomId: params.roomId,
          userId: params.userId,
          fromTs: params.sinceTs,
          limit,
        });
      const lastMsg =
        tsMessages.length > 0 ? tsMessages[tsMessages.length - 1]! : null;
      const lastId = lastMsg?.id ?? params.sinceId;
      const nextTs =
        lastMsg?.updatedAt instanceof Date ? lastMsg.updatedAt.getTime() : 0;
      return {
        events: tsMessages,
        hasMore,
        lastId,
        nextTs,
        authorized: true,
        lastRevision: 0,
        roomRevision: 0,
        resetRequired: false,
      };
    }

    // since_id mode: ObjectId ordering (insertion-order). Tombstones included.
    const { messages, hasMore } = await this.messageRepo.findSinceId({
      roomId: params.roomId,
      userId: params.userId,
      sinceId: params.sinceId,
      limit,
    });
    const lastId =
      messages.length > 0 ? messages[messages.length - 1]!.id : params.sinceId;
    return {
      events: messages,
      hasMore,
      lastId,
      nextTs: 0,
      authorized: true,
      lastRevision: 0,
      roomRevision: 0,
      resetRequired: false,
    };
  }

  /** Deep-gap horizon: a `since_revision` more than this far below the room's
   *  current revision triggers a bounded re-baseline instead of replaying the
   *  full backlog (§7). Rows are never deleted, so we CAN serve older cursors;
   *  this bound just caps a cold client's catch-up to one newest page. */
  private readonly REVISION_RESET_HORIZON = 10_000;

  /**
   * Shared core for the zero-loss changes feed — used by BOTH the REST
   * `/changes` endpoint and the socket `community:catchup(sinceRevision)` path.
   * Resolves the room's current revision, decides `resetRequired`, and (unless
   * reset) returns the page of changed messages via `findByRoomIdRevisionSince`.
   * Serialization + `pinnedMessage` are added by the caller.
   */
  private async resolveChanges(params: {
    roomId: string;
    userId: string;
    sinceRevision: number;
    limit: number;
    viewerIsActiveMember: boolean;
    readCutoff: Date | null;
  }): Promise<{
    roomRevision: number;
    resetRequired: boolean;
    hasMore: boolean;
    nextRevision: number | null;
    messages: GeneralRoomMessage[];
  }> {
    const roomRevision = await this.messageRepo.getRoomRevision(params.roomId);

    // Deep gap: cursor below the retained horizon ⇒ tell the client to drop local
    // state and re-baseline from the newest page (bounded catch-up). since=0 (cold
    // start) is NOT a reset — it drains from the beginning within the horizon.
    const resetRequired =
      params.sinceRevision > 0 &&
      roomRevision - params.sinceRevision > this.REVISION_RESET_HORIZON;
    if (resetRequired) {
      return {
        roomRevision,
        resetRequired: true,
        hasMore: false,
        nextRevision: null,
        messages: [],
      };
    }

    const { messages, hasMore, nextRevision } =
      await this.messageRepo.findByRoomIdRevisionSince({
        roomId: params.roomId,
        userId: params.userId,
        sinceRevision: params.sinceRevision,
        limit: params.limit,
        viewerIsActiveMember: params.viewerIsActiveMember,
        readCutoff: params.readCutoff,
      });

    return {
      roomRevision,
      resetRequired: false,
      hasMore,
      nextRevision,
      messages,
    };
  }

  /**
   * Current room CHANGE high-water (`lastRevision`). Surfaced on the V2 history
   * response so a cold-start client can set its per-room revision cursor from a
   * plain history load (no separate `/changes` round-trip).
   */
  async getRoomRevision(roomId: string): Promise<number> {
    return this.messageRepo.getRoomRevision(roomId);
  }

  /**
   * ZERO-LOSS CHANGES FEED (REST). Returns every message whose room CHANGE
   * `revision > sinceRevision`, current state, serialized like V2 history +
   * `revision`. Inserts AND mutations (edit/delete/reaction) regardless of how
   * old the message's `sequenceNumber` is. Drains via `nextRevisionCursor` until
   * `hasMore=false`. Access is the same PUBLIC-or-member rule as V2 reads.
   */
  async getChanges(params: {
    roomId: string;
    userId: string;
    sinceRevision: number;
    limit: number;
  }): Promise<{
    roomRevision: number;
    resetRequired: boolean;
    hasMore: boolean;
    nextRevisionCursor: string | null;
    items: CommunityMessageWire[];
  }> {
    const { member, bannedAtCutoff } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      params.roomId,
      params.userId,
      { allowBannedReadCutoff: true }
    );
    const viewerIsActiveMember = isActiveMember(member);
    const changes = await this.resolveChanges({
      roomId: params.roomId,
      userId: params.userId,
      sinceRevision: params.sinceRevision,
      limit: params.limit,
      viewerIsActiveMember,
      readCutoff: bannedAtCutoff ?? null,
    });

    const items = await this.enrichTimelinePage(
      changes.messages,
      params.userId
    );
    return {
      roomRevision: changes.roomRevision,
      resetRequired: changes.resetRequired,
      hasMore: changes.hasMore,
      nextRevisionCursor:
        changes.hasMore && changes.nextRevision != null
          ? String(changes.nextRevision)
          : null,
      items,
    };
  }

  /**
   * Active member userIds for a community room — the recipient list for the
   * community list "bump-to-top" (`community:updated`) fan-out.
   */
  async getActiveMemberIds(roomId: string): Promise<string[]> {
    const members = await this.memberRepo.findActiveByRoom(roomId);
    return members.map((m) => m.userId);
  }

  /**
   * Authoritative per-member unread adjustment for a message that was just
   * removed — the answer to "did this message actually contribute to THIS
   * member's badge", decided server-side so the client never has to guess.
   *
   * Community unread is DERIVED from `RoomMember.lastReadAt` rather than stored
   * as a counter, so the post-delete DB state is already correct (the count
   * query excludes `deletedForAll` and `deletedBy`) — what was missing is any
   * event telling a client that its cached row badge is now one too high. An
   * absolute per-member count would cost one aggregation PER MEMBER per delete;
   * the delta needs a single member fetch and is exact.
   *
   * Returns only the members whose badge actually moves; everyone else is
   * absent from the map (treated as 0 by the publisher).
   *
   * ponytail: delta rather than an absolute count — if concurrent-delete
   * ordering ever proves to matter more than the per-member aggregation cost,
   * swap the body for `countUnreadAfter` per affected member; the wire field is
   * already per-member so only this function and the client's apply-step change.
   */
  async resolveUnreadDeltasAfterDelete(params: {
    roomId: string;
    memberIds: string[];
    deletedMessage: {
      sentBy: string;
      createdAt: Date;
      messageType?: string | null;
      systemMessageType?: string | null;
      countInUnread?: boolean | null;
      visibleToUserId?: string | null;
      deletedBy?: unknown;
    };
    /** delete-for-me: only this member's own view changed. */
    onlyUserId?: string;
  }): Promise<Record<string, number>> {
    const msg = params.deletedMessage;

    // Never counted toward anyone's badge in the first place → nothing to undo.
    // Same policy object the write path and the count queries use.
    if (
      !shouldCountInUnread({
        messageType: msg.messageType,
        systemMessageType: msg.systemMessageType,
        explicit: msg.countInUnread,
      })
    ) {
      return {};
    }
    // Personal system rows ("You joined the community") are excluded from
    // countUnreadBulk/countUnreadAfter, so they can't have inflated a badge.
    if (msg.visibleToUserId != null) return {};

    // Members who had ALREADY hidden this message for themselves never had it
    // in their derived count — decrementing them would push the badge BELOW the
    // real number of unread messages.
    const alreadyHidden = new Set(
      Array.isArray(msg.deletedBy) ? (msg.deletedBy as string[]) : []
    );

    const eligible = params.onlyUserId
      ? params.memberIds.filter((id) => id === params.onlyUserId)
      : params.memberIds;
    if (eligible.length === 0) return {};

    const members = await this.memberRepo.findActiveByRoom(params.roomId);
    const lastReadByUser = new Map(
      members.map((m) => [m.userId, m.lastReadAt ?? null])
    );

    const deltas: Record<string, number> = {};
    for (const memberId of eligible) {
      // Own messages never counted toward own unread (parity with the count
      // queries' `sentBy: { $ne: userId }`).
      if (memberId === msg.sentBy) continue;
      if (alreadyHidden.has(memberId)) continue;
      if (!lastReadByUser.has(memberId)) continue; // not an active member
      const lastReadAt = lastReadByUser.get(memberId) ?? null;
      // Read strictly before the message was sent ⇒ it was still unread.
      // A never-read member (null) has everything unread.
      const wasUnread = lastReadAt === null || lastReadAt < msg.createdAt;
      if (wasUnread) deltas[memberId] = -1;
    }
    return deltas;
  }

  /**
   * Adapter exposing the community-message deletion shape (deletedForAll +
   * deletedBy ARRAY) to the shared LastVisibleResolver. The repo's
   * findPreviousVisibleForUser already excludes globally-deleted, the viewer's
   * own deletedBy hides, foreign personal (visibleToUserId) rows AND hidden
   * lifecycle system types — so the normalized VisibleLast is safe to surface.
   */
  private visibilitySource(): VisibilitySource {
    return communityVisibilitySource(this.messageRepo);
  }

  /**
   * Per-recipient list-preview overrides for a delete-for-everyone fan-out: of the
   * given recipients, the ones who have personally hidden `sharedPrevMessageId`
   * (the new shared previous-visible) get THEIR own visible preview instead.
   * Empty map when nobody hid it (the common case). Exposed for the controller +
   * gRPC delete paths.
   */
  async resolveForEveryoneOverrides(
    roomId: string,
    sharedPrevMessageId: string | null,
    recipientIds: string[]
  ): Promise<Map<string, RecipientOverride | null>> {
    return resolveForEveryoneOverrides(
      this.visibilitySource(),
      roomId,
      sharedPrevMessageId,
      recipientIds
    );
  }

  /**
   * Bulk community-chat summaries for GET /communities/mine. For each requested
   * communityId (roomId === communityId): unread count + last-message preview,
   * but ONLY for communities the user is an ACTIVE or BANNED member of
   * (member-only previews). Non-member communities get `unreadMessageCount: 0` +
   * `hasLastMessage: false`. A BANNED member gets the same READ CUTOFF as every
   * other read path (see {@link assertCommunityReadAccess}'s
   * `allowBannedReadCutoff`): unread count and last-message are clamped to
   * `createdAt <= bannedAt`, so nothing that happened after the ban leaks into
   * the community-service list (which otherwise falls back to its unfiltered
   * denormalized column whenever this returns `hasLastMessage: false`). Single
   * bulk query per concern — no N+1 (banned rooms' cutoff resolution is the one
   * per-room exception, batched concurrently).
   */
  /**
   * Total unread community messages across every community the user's an
   * ACTIVE member of — for the Community nav badge. Reuses the same
   * countUnreadBulk primitive getChatSummaries already uses per-community,
   * just summed instead of returned per-room; no banned-cutoff clamping
   * since a banned member doesn't contribute to the badge (see
   * RoomMemberRepository.findActiveByUser).
   */
  async sumUnreadForUser(userId: string): Promise<number> {
    const members = await this.memberRepo.findActiveByUser(userId);
    if (!members.length) return 0;
    const unreadMap = await this.messageRepo.countUnreadBulk({
      userId,
      thresholds: members.map((m) => ({
        roomId: m.roomId,
        afterDate: m.lastReadAt ?? new Date(0),
        beforeDate: null,
      })),
    });
    return Object.values(unreadMap).reduce((sum, u) => sum + u.count, 0);
  }

  async getChatSummaries(params: {
    userId: string;
    communityIds: string[];
  }): Promise<CommunityChatSummary[]> {
    const ids = [...new Set(params.communityIds.filter(Boolean))];
    if (!ids.length) return [];

    // 1. Active + banned membership rows → member roomIds + per-room read
    // threshold + (banned only) read cutoff.
    const members = await this.memberRepo.findVisibleByUserAndRooms(
      params.userId,
      ids
    );
    const readMap = new Map<string, Date | null>(
      members.map((m) => [m.roomId, m.lastReadAt])
    );
    const cutoffMap = new Map<string, Date | null>(
      members.map((m) => [
        m.roomId,
        m.status === "banned" ? (m.bannedAt ?? new Date(0)) : null,
      ])
    );
    const memberRoomIds = members.map((m) => m.roomId);
    const bannedRoomIds = memberRoomIds.filter((roomId) =>
      cutoffMap.get(roomId)
    );

    // 2/3/4/5. In parallel: member rooms (lastMessage JSON) + bulk unread counts
    // (banned rooms capped at their cutoff) + the viewer's latest PERSONAL line
    // per room (e.g. "You joined the community") + banned rooms' as-of-ban last
    // visible message (bypasses the shared/overrides path below entirely).
    const [rooms, unreadMap, personalMap, bannedLastEntries] =
      await Promise.all([
        this.roomRepo.findManyByIds(memberRoomIds),
        memberRoomIds.length
          ? this.messageRepo.countUnreadBulk({
              userId: params.userId,
              thresholds: memberRoomIds.map((roomId) => ({
                roomId,
                afterDate: readMap.get(roomId) ?? new Date(0),
                beforeDate: cutoffMap.get(roomId),
              })),
            })
          : Promise.resolve<
              Record<string, { count: number; firstUnreadMessageId: string }>
            >({}),
        memberRoomIds.length
          ? this.messageRepo.findLatestPersonalByRooms({
              userId: params.userId,
              roomIds: memberRoomIds,
            })
          : Promise.resolve(
              new Map<string, { message: string; createdAt: Date }>()
            ),
        Promise.all(
          bannedRoomIds.map(
            async (roomId) =>
              [
                roomId,
                await this.messageRepo.findPreviousVisibleForUser(
                  roomId,
                  params.userId,
                  cutoffMap.get(roomId)
                ),
              ] as const
          )
        ),
      ]);
    const roomById = new Map(rooms.map((r) => [r.id, r]));
    const bannedLastMap = new Map(bannedLastEntries);

    // A personal line created AFTER the ban (e.g. a role change that landed
    // post-ban) is not visible to a banned viewer either — drop it.
    for (const roomId of bannedRoomIds) {
      const cutoff = cutoffMap.get(roomId);
      const personal = personalMap.get(roomId);
      if (
        cutoff &&
        personal &&
        personal.createdAt.getTime() > cutoff.getTime()
      ) {
        personalMap.delete(roomId);
      }
    }

    // Per-user lastMessage visibility pass (shared LastVisibleResolver):
    // For each room whose shared lastMessageId is hidden from this viewer
    // (globally deleted OR in their personal deletedBy array), resolve the
    // previous message they CAN see. The result is surfaced as the per-user
    // `lastMessage` below — authoritative, so community-service can override the
    // denormalized column for this viewer (fixing both the per-user delete-for-me
    // preview AND lost community.activity-event staleness).
    const overrides = await resolveVisibleLastBulk(
      this.visibilitySource(),
      rooms.map((r) => ({
        roomId: r.id,
        sharedLastMessageId: r.lastMessageId,
      })),
      params.userId
    );

    // 4. Build a summary for EVERY requested community.
    return ids.map((communityId) => {
      if (!readMap.has(communityId)) {
        // Not an active member → no preview, zero unread (member-only previews).
        return {
          communityId,
          unreadMessageCount: 0,
          firstUnreadMessageId: null,
          hasLastMessage: false,
          perUserResolved: false,
        };
      }

      const room = roomById.get(communityId);
      const unread = unreadMap[communityId];
      const unreadMessageCount = unread?.count ?? 0;
      const firstUnreadMessageId =
        unreadMessageCount > 0 ? (unread?.firstUnreadMessageId ?? null) : null;

      // The viewer's own personal line (e.g. "You joined the community"). Carried
      // SEPARATELY from lastMessage so community-service can pick the newer of the
      // two per-viewer — they no longer collide in one overlay slot.
      const personal = personalMap.get(communityId);
      const personalLastMessage =
        personal && personal.message
          ? {
              message: personal.message,
              dateTime: personal.createdAt.getTime(),
            }
          : undefined;

      let lastMessage: CommunityChatSummary["lastMessage"] | undefined;
      let hasLastMessage = false;
      const cutoff = cutoffMap.get(communityId);
      let perUserResolved = room ? overrides.has(communityId) : false;

      if (cutoff) {
        // BANNED viewer: the shared last / hidden-set overrides are IRRELEVANT —
        // re-resolve straight from the as-of-ban query (findPreviousVisibleForUser
        // already excludes deletedForAll/deletedBy, so delete-for-me still applies).
        // perUserResolved forces TRUE so community-service treats this as
        // AUTHORITATIVE and never falls back to its unfiltered denormalized column.
        perUserResolved = true;
        const prev = bannedLastMap.get(communityId) ?? null;
        if (prev) {
          const isSystem = prev.systemMessageType != null;
          lastMessage = {
            username: isSystem ? "" : (prev.senderName ?? ""),
            message: convertMessageToPreview(prev.messageType, prev.message),
            dateTime: prev.createdAt.getTime(),
            isSystem,
            userId: isSystem ? "" : (prev.sentBy ?? ""),
          };
          hasLastMessage = true;
        }
      } else if (perUserResolved) {
        // Shared last is HIDDEN for this viewer → AUTHORITATIVE per-viewer
        // resolution: substitute their previous-visible (with its REAL timestamp,
        // no +1ms hack — community-service treats perUserResolved as authoritative,
        // not timestamp-gated), or NONE when they have hidden every message.
        const prev = overrides.get(communityId) ?? null;
        if (prev) {
          const isSystem = prev.messageType.toUpperCase() === "SYSTEM";
          lastMessage = {
            username: isSystem ? "" : prev.senderName,
            message: convertMessageToPreview(prev.messageType, prev.content),
            dateTime: prev.createdAt.getTime(),
            isSystem,
            userId: isSystem ? "" : prev.senderId,
          };
          hasLastMessage = true;
        }
        // prev === null → no visible message remains; hasLastMessage false +
        // lastMessage undefined, but perUserResolved stays TRUE so community-service
        // CLEARS the (now stale-for-this-viewer) community-wide column preview.
      } else {
        // Shared last is VISIBLE (common path) — the plain shared snapshot.
        const last = (room?.lastMessage ?? null) as RoomLastMessageJson | null;
        if (last && last.createdAt) {
          const createdAt =
            last.createdAt instanceof Date
              ? last.createdAt
              : new Date(last.createdAt);
          // SYSTEM messages are sender-less: the preview is a complete sentence
          // (e.g. "John joined the community"), so the list must NEVER prefix it
          // with a sender name — force username/userId empty for SYSTEM.
          const messageType = last.messageType ?? "";
          const isSystem = messageType.toUpperCase() === "SYSTEM";
          lastMessage = {
            username: isSystem ? "" : (last.senderName ?? ""),
            message: convertMessageToPreview(messageType, last.content),
            dateTime: Number.isNaN(createdAt.getTime())
              ? 0
              : createdAt.getTime(),
            isSystem,
            userId: isSystem ? "" : (last.senderId ?? ""),
          };
          hasLastMessage = true;
        }
      }

      return {
        communityId,
        unreadMessageCount,
        firstUnreadMessageId,
        hasLastMessage,
        perUserResolved,
        ...(lastMessage ? { lastMessage } : {}),
        ...(personalLastMessage ? { personalLastMessage } : {}),
      };
    });
  }

  /**
   * Zero the caller's unread on many communities at once (the sidebar's
   * multi-select "Mark all as read").
   *
   * The write is only half the job: the post-read effects have to match the
   * single-message path ({@link markMessageRead}) or the bulk call silently
   * drops them —
   *
   *   1. `community:read_sync` on `user:<userId>` so the caller's OTHER tabs /
   *      devices clear their list badges (the list query is cached, nothing
   *      else would tell them).
   *   2. `notifyUnreadChanged` so the Community nav-badge total is recomputed
   *      from the DB and pushed as `chat:unread_summary` — that badge is fed
   *      exclusively by that event, so without this it kept the pre-read count
   *      until a reconnect.
   *
   * `unreadCount` per community is recounted AFTER the write against the same
   * boundary that was persisted, so a message that lands mid-operation reports
   * a non-zero count and receivers leave that row's badge alone (see the
   * `read_sync` handler) instead of blanket-zeroing a genuinely unread row.
   */
  async bulkMarkRead(userId: string, communityIds: string[]): Promise<number> {
    const ids = [...new Set(communityIds.filter(Boolean))];
    if (!ids.length) return 0;

    const readAt = new Date();
    const updatedCount = await this.memberRepo.bulkAdvanceReadToNow(
      userId,
      ids,
      readAt
    );
    if (!updatedCount) return 0;

    let unreadAfter: Record<string, { count: number }> = {};
    try {
      unreadAfter = await this.messageRepo.countUnreadBulk({
        userId,
        thresholds: ids.map((roomId) => ({ roomId, afterDate: readAt })),
      });
    } catch (err: unknown) {
      logger.warn(
        `CommunityMessageService|bulkMarkRead|countUnread failed: ${String(err)}`
      );
    }

    for (const communityId of ids) {
      redis
        .publish(
          `user:${userId}`,
          JSON.stringify({
            event: "community:read_sync",
            data: {
              communityId,
              readerId: userId,
              unreadCount: unreadAfter[communityId]?.count ?? 0,
              readAt: readAt.getTime(),
            },
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `CommunityMessageService|bulkMarkRead|redis publish user failed: ${String(err)}`
          );
        });
    }

    notifyUnreadChanged(userId);

    return updatedCount;
  }

  /**
   * Map a raw Prisma message to the client wire shape: drop the LOWER-CASE
   * `messageType` and add an UPPER-CASE `contentType` (§1). Every other field
   * (id, roomId, sentBy, senderName, senderAvatar, message, attachments,
   * reactions, deletedForAll, editedAt, createdAt, updatedAt, parentMessageId,
   * …) is preserved unchanged. Applied at the RETURN site of REST read paths
   * only — internal logic continues to read the raw rows.
   */
  /**
   * Collect every stored media key on a page of community rows (sender avatars +
   * attachment object keys) and resolve them ONCE to full download URLs. Pass
   * the returned map to {@link toWire} so each row serializes synchronously and
   * the FE never receives a raw object key.
   */
  private resolveRowsMedia(
    rows: GeneralRoomMessage[]
  ): Promise<Map<string, string>> {
    const keys: string[] = [];
    for (const m of rows) {
      if (m.senderAvatar) keys.push(m.senderAvatar);
      const attachments = m.attachments;
      if (Array.isArray(attachments)) {
        for (const attachment of attachments) {
          keys.push(...fileMediaKeys(attachment as MediaFileLike));
        }
      }
      const quote = m.quoteData as Record<string, unknown> | null;
      if (typeof quote?.thumbnail === "string" && quote.thumbnail) {
        keys.push(quote.thumbnail);
      }
    }
    return resolveMediaUrlMap(keys);
  }

  /**
   * The two per-page lookups every community read path needs before it can
   * serialize a row: the resolved media URLs, and which of the page's
   * participants have deleted their account.
   *
   * The second one exists because community rows denormalize
   * `senderName`/`senderAvatar` (and the system line's actor/target names) at
   * write time and never re-read a profile, so without it a deleted account's
   * old name stays frozen into community history forever. It is one batched,
   * Redis-cached snapshot lookup, run in parallel with the media resolution.
   */
  private async resolveRowsWireContext(rows: GeneralRoomMessage[]): Promise<{
    urlMap: Map<string, string>;
    deletedUserIds: Set<string>;
  }> {
    const [urlMap, deletedUserIds] = await Promise.all([
      this.resolveRowsMedia(rows),
      collectDeletedUserIds(
        rows.flatMap((row) =>
          collectRowUserIds(row as unknown as Record<string, unknown>)
        ),
        this.userSnapshotService,
        this.cacheRepo
      ),
    ]);
    return { urlMap, deletedUserIds };
  }

  /** Extract every unique reactor userId from a batch of message rows. */
  private collectReactionUserIds(rows: GeneralRoomMessage[]): string[] {
    const ids = new Set<string>();
    for (const row of rows) {
      const reactions = row.reactions as Record<string, unknown> | null;
      if (!reactions || typeof reactions !== "object") continue;
      for (const list of Object.values(reactions)) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          const uid =
            typeof entry === "string"
              ? entry
              : (entry as Record<string, unknown>)?.userId;
          if (typeof uid === "string" && uid) ids.add(uid);
        }
      }
    }
    return [...ids];
  }

  /**
   * Personalize a SYSTEM line's third-person text for one viewer ("You joined
   * the community", "You are now a moderator"), or return it unchanged. Single
   * source of truth shared by the history wire (`toWire`) and the sync mapper
   * (`getMessagesSince`) so the metadata extraction isn't duplicated. Returns the
   * input text untouched when there is no viewer or no system subtype.
   */
  private personalizeSystemText(
    systemMessageType: string | null | undefined,
    systemMetadata: unknown,
    storedText: string,
    viewerUserId: string | undefined,
    deletedUserIds: Set<string> = new Set()
  ): string {
    if (!systemMessageType) return storedText;
    // Names are baked into the metadata at write time; the text is rebuilt from
    // them below on every read, so swapping the names of deleted participants
    // here is enough to keep "X removed Y" from naming a deleted account —
    // no stored row is touched.
    const metadata = anonymizeSystemData(
      (systemMetadata ?? {}) as Record<string, unknown>,
      deletedUserIds
    );

    // Always rebuild from the canonical builder. This achieves three things:
    //
    //  1. CANONICAL UPGRADE — stale stored rows written by old code (e.g.
    //     "Jim Methews created the community") are transparently upgraded to the
    //     current text ("Community created") with no DB migration required.
    //
    //  2. PERSONALIZATION — when the viewer is the actor or target of the
    //     event, the builder switches to the "You …" first-person form
    //     ("You are now a moderator" vs "John Doe is now a moderator").
    //
    //  3. SSoT — Chat Room / Sync / Socket read paths all produce the same
    //     text because they all run through this single rebuild gate.
    //
    // storedText is only used as a final fallback in the impossible case that
    // the builder returns empty (the default case in the switch never fires,
    // so this guard is purely defensive).
    const rebuilt = buildCommunitySystemFallbackText(
      systemMessageType as CommunitySystemMessageType,
      metadata,
      String(metadata.actorName ?? ""),
      String(metadata.targetName ?? ""),
      viewerUserId ?? "",
      currentLocale()
    );
    return rebuilt || storedText;
  }

  private toWire(
    m: GeneralRoomMessage,
    urlMap?: Map<string, string>,
    resolveReactionUser?: (
      userId: string
    ) => { displayName: string; avatarUrl: string } | undefined,
    viewerUserId?: string,
    deletedUserIds: Set<string> = new Set()
  ): CommunityMessageWire {
    const wire = toWireMessage(m) as Record<string, unknown>;
    // Normalize to the same CanonicalQuote shape the community socket
    // broadcast already uses (`community:message:new`), so REST history/
    // pagination/search/sync are byte-identical to the live event.
    const canonicalQuote = buildCanonicalQuote(wire.quoteData);
    wire.quoteData = urlMap
      ? resolveQuoteThumbnail(canonicalQuote, urlMap)
      : canonicalQuote;
    wire.countInUnread = shouldCountInUnread({
      messageType: m.messageType,
      systemMessageType: m.systemMessageType,
      explicit: (m as unknown as { countInUnread?: boolean | null })
        .countInUnread,
    });

    // Resolve raw object keys → full download URLs on read (never persisted, so
    // CDN/presign rotation keeps working). Internal logic still reads raw rows.
    if (urlMap) {
      if (typeof wire.senderAvatar === "string") {
        wire.senderAvatar = urlFromMap(urlMap, wire.senderAvatar);
      }
      if (Array.isArray(wire.attachments)) {
        wire.attachments = applyUrlMapToFiles(
          wire.attachments as MediaFileLike[],
          urlMap
        );
      }
    }

    // Rename avatar → avatarUrl and resolve S3 object-keys to full presigned
    // download URLs inside the stored reactions map. No new field is added.
    if (wire.reactions && typeof wire.reactions === "object") {
      const raw = wire.reactions as Record<string, unknown>;
      const out: Record<string, unknown[]> = {};
      for (const [emoji, list] of Object.entries(raw)) {
        if (!Array.isArray(list)) continue;
        out[emoji] = list.map((r) => {
          const reactor = (r ?? {}) as Record<string, unknown>;
          const { avatar, ...rest } = reactor;
          const snap = resolveReactionUser?.(reactor.userId as string);
          return {
            ...rest,
            avatarUrl:
              snap?.avatarUrl ||
              (urlMap ? urlFromMap(urlMap, (avatar as string) || "") : "") ||
              "",
          };
        });
      }
      wire.reactions = out;
    }

    // Canonical client-facing reaction shape (FE reads `reactionGroups[]`,
    // matching the live `community:message:reaction` broadcast) — history reads
    // were only renaming the raw `reactions` map's avatar key, never emitting
    // this, so a reaction applied live vanished on the next history fetch/reload.
    wire.reactionGroups = buildReactionGroups(
      m.reactions,
      (key) => (urlMap ? urlFromMap(urlMap, key) : ""),
      resolveReactionUser
    );

    // Normalize editedAt → epoch ms and derive isEdited so all list/timeline
    // surfaces are consistent with the edit socket event and sync API.
    const editedMs =
      m.editedAt instanceof Date ? m.editedAt.getTime() : (m.editedAt ?? null);
    wire.isEdited = editedMs !== null && editedMs > 0;
    wire.editedAt = editedMs;

    // Zero-loss CHANGE cursor — present on every serialized message so the client
    // tracks its per-room high-water and gap-checks live events. Additive; V1/V2
    // clients ignore it.
    wire.revision = m.revision ?? 0;

    // Normalized tombstone (one shape across private/group/community) — the raw
    // deletedForAll/deletedForAllAt columns stay on the wire untouched.
    Object.assign(wire, tombstoneWireFields(m));

    // Surface a clean `isPersonal` flag for the client (e.g. "You joined this
    // community") and DROP the raw `visibleToUserId` targeting column from the
    // wire — it is an internal access-control field, not a client contract.
    const isPersonal = Boolean(
      (wire as Record<string, unknown>).visibleToUserId
    );
    delete (wire as Record<string, unknown>).visibleToUserId;
    wire.isPersonal = isPersonal;

    // SYSTEM messages are SENDER-LESS (Telegram-style): never expose
    // senderId/senderName/senderAvatar — the actor lives in systemMetadata only.
    // Also blank the internal idempotency token we stash in `clientMessageId`
    // (the system-event dedup key); it is not part of the client contract.
    if (String(wire.contentType).toUpperCase() === "SYSTEM") {
      wire.senderId = "";
      wire.sentBy = "";
      wire.senderName = "";
      wire.senderAvatar = "";
      wire.clientMessageId = "";

      const thirdPersonText = String(wire.message ?? "");
      const personalized = this.personalizeSystemText(
        m.systemMessageType,
        m.systemMetadata,
        thirdPersonText,
        viewerUserId,
        deletedUserIds
      );
      if (personalized !== thirdPersonText) {
        wire.message = personalized;
        const content = wire.content as Record<string, unknown> | null;
        if (content && typeof content === "object") {
          wire.content = { ...content, text: personalized };
        }
      }

      // ACTOR-LESS lifecycle lines must not leak actor identity to the client
      // (which localizes from systemMetadata). Strip actor/target keys so a
      // legacy row that stored creatorName/actorName can never render
      // "{name} created the community". No-op for actor-bearing types.
      const sanitized = sanitizeCommunitySystemMetadata(
        m.systemMessageType,
        wire.systemMetadata as Record<string, unknown> | null | undefined
      );
      // The client re-localizes system lines from this metadata, so the names
      // it carries are a second copy of the identity scrubbed out of the text
      // above and must get the same treatment — otherwise a localized client
      // renders the deleted user's old name while an English one does not.
      wire.systemMetadata = sanitized
        ? anonymizeSystemData(sanitized, deletedUserIds)
        : sanitized;
    }

    // Community rows freeze senderName/senderAvatar at write time; swap in the
    // deleted-account identity for senders (and quoted senders) whose account
    // is gone, and stamp `isDeletedUser` on every row.
    anonymizeWireSender(wire, deletedUserIds);

    return wire as CommunityMessageWire;
  }

  async getMessages(params: {
    roomId: string;
    userId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<CommunityMessageWire[]> {
    // For community messages, allow reads if:
    // 1. User is an active member, OR
    // 2. The community is PUBLIC (non-members can read history)
    const { member, bannedAtCutoff } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      params.roomId,
      params.userId,
      { allowBannedReadCutoff: true }
    );
    const viewerIsActiveMember = isActiveMember(member);
    const beforeTimestamp = params.cursor || new Date().toISOString();
    const rows = await this.messageRepo.findByRoomIdWithTime(
      params.roomId,
      beforeTimestamp,
      "older",
      params.limit,
      params.userId,
      viewerIsActiveMember,
      bannedAtCutoff
    );
    const { urlMap, deletedUserIds } = await this.resolveRowsWireContext(rows);
    return rows.map((m) =>
      this.toWire(m, urlMap, undefined, params.userId, deletedUserIds)
    );
  }

  /**
   * Keyset history page (before_ts scroll). The repo filters hidden/personal/
   * deleted rows in the DB and returns exactly `limit` visible rows plus an exact
   * `hasMore`, so a hidden row in the window can no longer make pagination
   * terminate early. `nextCursor` is a COMPOUND `"<createdAtMs>_<id>"` keyset
   * cursor (not a bare millisecond): the `_id` tiebreaker is what keeps messages
   * sharing one millisecond reachable. The client feeds it back verbatim as the
   * next `before_ts`.
   */
  async getMessagesTimeline(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    ts: Date;
    /** Keyset tiebreaker parsed from a compound before_ts ("<ms>_<id>"). */
    boundaryId?: string | null;
    /** True for the first page (no cursor) so the newest message is included. */
    inclusive?: boolean;
    limit: number;
  }): Promise<{
    items: CommunityMessageWire[];
    hasMore: boolean;
    nextCursor: string | null;
    total: number;
    cursors: AroundCursors;
    roomRevision: number;
  }> {
    return this.getTimelinePageShared({
      roomId: params.roomId,
      userId: params.userId,
      direction: params.direction,
      limit: params.limit,
      cursor: {
        strategy: "TIMESTAMP",
        ts: params.ts,
        boundaryId: params.boundaryId ?? null,
        inclusive: params.inclusive ?? false,
      },
    });
  }

  /**
   * The `before_seq`/`after_seq` sequence timeline page of
   * `GET /chat/community/rooms/:roomId/messages`. Gap-safe monotonic
   * `sequenceNumber` keyset — the SAME shared core as the timestamp path
   * ({@link getTimelinePageShared}); only the cursor axis differs, so a
   * same-millisecond burst can never split across a page boundary. `seq === null`
   * → newest page; `nextCursor` is the plain seq string the client feeds back as
   * `before_seq` (older) / `after_seq` (newer).
   */
  async getMessagesSeqKeyset(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    seq: number | null;
    limit: number;
  }): Promise<{
    items: CommunityMessageWire[];
    hasMore: boolean;
    nextCursor: string | null;
    total: number;
    cursors: AroundCursors;
    roomRevision: number;
  }> {
    return this.getTimelinePageShared({
      roomId: params.roomId,
      userId: params.userId,
      direction: params.direction,
      limit: params.limit,
      cursor: { strategy: "SEQUENCE", seq: params.seq },
    });
  }

  /**
   * Shared community-timeline page core for BOTH pagination axes of
   * `GET /chat/community/rooms/:roomId/messages`. The ONLY thing that differs
   * between them is the axis, fully encapsulated in the {@link PaginationCursor}
   * + its adapter (fetch the page, stringify the `nextCursor`). Access guards,
   * membership/ban resolution, the history-visible `total`, ordering,
   * reaction-snapshot enrichment, media URL resolution and serialization are
   * identical and live here once — so both axes return byte-identical message
   * objects and envelopes. `before_ts`/`after_ts` pass a TIMESTAMP cursor;
   * `before_seq`/`after_seq` a SEQUENCE cursor.
   */
  private async getTimelinePageShared(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    limit: number;
    cursor: PaginationCursor;
  }): Promise<{
    items: CommunityMessageWire[];
    hasMore: boolean;
    nextCursor: string | null;
    total: number;
    cursors: AroundCursors;
    roomRevision: number;
  }> {
    // For community messages, allow reads if:
    // 1. User is an active member, OR
    // 2. The community is PUBLIC (non-members can read history), OR
    // 3. The caller is banned — capped to messages created at/before their ban
    //    (read cutoff, not a hard block; see `assertCommunityReadAccess`).
    const { member, bannedAtCutoff } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      params.roomId,
      params.userId,
      { allowBannedReadCutoff: true }
    );
    const viewerIsActiveMember = isActiveMember(member);
    const adapter = makeTimelineAdapter(this.messageRepo, params.cursor);
    const [{ messages: pageRows, hasMore }, total, roomRevision] =
      await Promise.all([
        adapter.timeline({
          roomId: params.roomId,
          userId: params.userId,
          direction: params.direction,
          limit: params.limit,
          viewerIsActiveMember,
          readCutoff: bannedAtCutoff,
        }),
        this.messageRepo.countTimeline({
          roomId: params.roomId,
          userId: params.userId,
          viewerIsActiveMember,
          readCutoff: bannedAtCutoff,
        }),
        // Room change high-water on EVERY page — the client seeds its
        // localMaxRevision from this on cold start (frontend guide §3).
        this.messageRepo.getRoomRevision(params.roomId),
      ]);

    // Boundary = last DB-order row; the adapter stringifies the axis-correct
    // nextCursor (compound "<ms>_<id>" for TIMESTAMP, plain seq for SEQUENCE).
    // For "before" the DB returns newest-first, so the boundary for the next
    // (older) page is the tail — reverse so every surface is oldest→newest.
    const boundary = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && boundary ? adapter.nextCursor(boundary) : null;

    const orderedItems =
      params.direction === "before" ? [...pageRows].reverse() : pageRows;

    // Bidirectional continuation on EVERY page (not just ?around=): probes one
    // row beyond each edge so the client always knows whether a newer seam
    // exists and how to page it — the jump-to-message scroll-down fix (Gap B).
    const [cursors, items] = await Promise.all([
      adapter.cursors(
        {
          roomId: params.roomId,
          userId: params.userId,
          viewerIsActiveMember,
          readCutoff: bannedAtCutoff,
        },
        orderedItems
      ),
      this.enrichTimelinePage(orderedItems, params.userId),
    ]);
    return { items, hasMore, nextCursor, total, cursors, roomRevision };
  }

  /**
   * Reaction-snapshot-rich enrichment shared by the V1 + V2 timeline pages:
   * fetch reactor snapshots, resolve their avatars alongside every message's
   * media in one batch, then serialize each row to the canonical wire shape.
   * Extracted from {@link getTimelinePageShared} so both pagination axes produce
   * byte-identical message objects.
   */
  private async enrichTimelinePage(
    orderedItems: GeneralRoomMessage[],
    userId: string
  ): Promise<CommunityMessageWire[]> {
    // Fetch reactor snapshots first so we can collect their avatar object-keys
    // and resolve them to full presigned download URLs in the same batch as the
    // rest of the message media.
    const snapsMap = await this.userSnapshotService.getUserSnapshotsMap(
      this.collectReactionUserIds(orderedItems),
      this.cacheRepo
    );
    const snapAvatarKeys = [...snapsMap.values()]
      .map((s) => (s.avatar as string) || "")
      .filter(Boolean);

    const [{ urlMap: msgUrlMap, deletedUserIds }, snapAvatarUrlMap] =
      await Promise.all([
        this.resolveRowsWireContext(orderedItems),
        resolveMediaUrlMap(snapAvatarKeys),
      ]);
    // Merge so toWire can resolve any avatar object-key (snap or legacy stored)
    // with a single urlMap lookup, with no separate map needed in the caller.
    const urlMap = new Map([...msgUrlMap, ...snapAvatarUrlMap]);

    const resolveReactionUser = (reactorId: string) => {
      const snap = snapsMap.get(reactorId);
      return snap
        ? {
            displayName: (snap.displayName as string) || "",
            avatarUrl:
              urlFromMap(snapAvatarUrlMap, (snap.avatar as string) || "") || "",
          }
        : undefined;
    };

    return orderedItems.map((m) =>
      this.toWire(m, urlMap, resolveReactionUser, userId, deletedUserIds)
    );
  }

  /**
   * Incremental sync (`after_ts` mode) — returns every message (new, edited,
   * reacted, deleted tombstone) whose `updatedAt >= fromTs`. Designed for
   * offline-first mobile clients catching up after a background period.
   *
   * Key differences from `getMessagesTimeline` (`before_ts` / scroll mode):
   * - Queries by `updatedAt` so edits, reaction changes, and deletes are
   *   included alongside new messages.
   * - Tombstones (`deletedForAll=true`) ARE returned — client reconciles.
   * - Each item carries grouped reactions ready for direct rendering.
   * - `nextCursor` is the epoch-ms `updatedAt` of the last item; the client
   *   stores it and sends it back as the next `after_ts`.
   */
  async getMessagesSince(params: {
    roomId: string;
    userId: string;
    fromTs: Date;
    limit: number;
  }): Promise<{
    items: Array<{
      id: string;
      roomId: string;
      sentBy: string;
      senderName: string | null;
      senderAvatar: string | null;
      message: string | null;
      contentType: string;
      attachments: unknown;
      reactions: Array<{
        emoji: string;
        count: number;
        users: Array<{
          userId: string;
          displayName: string;
          avatarUrl: string;
        }>;
      }>;
      deletedForAll: boolean;
      isEdited: boolean;
      editedAt: number | null;
      createdAt: number;
      updatedAt: number;
      revision: number;
      syncEventType: "new" | "edited" | "deleted" | "reacted";
    }>;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    // For community messages, allow reads if:
    // 1. User is an active member, OR
    // 2. The community is PUBLIC (non-members can read history), OR
    // 3. The caller is banned — capped to messages at/before their ban (read
    //    cutoff, not a hard block; same policy as `getMessagesTimeline`).
    // Note: sync path is typically members-only (offline-first mobile), but we enforce
    // the same rules for consistency.
    const { member, bannedAtCutoff } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      params.roomId,
      params.userId,
      { allowBannedReadCutoff: true }
    );

    if (Number.isNaN(params.fromTs.getTime())) {
      throw new BadRequestError("CHAT_INVALID_SINCE_TS");
    }
    const { messages, hasMore } = await this.messageRepo.findUpdatedAtSince({
      roomId: params.roomId,
      userId: params.userId,
      fromTs: params.fromTs,
      limit: params.limit,
      viewerIsActiveMember: member?.status === "active",
      readCutoff: bannedAtCutoff,
    });

    const last = messages[messages.length - 1];
    const nextCursor =
      hasMore && last ? String(last.updatedAt.getTime()) : null;

    // Resolve sender avatars, attachment keys, and reaction-user avatars on read
    // so the incremental-sync payload never carries a raw object key.
    const mediaKeys: string[] = [];
    for (const msg of messages) {
      if (msg.senderAvatar) mediaKeys.push(msg.senderAvatar);
      if (Array.isArray(msg.attachments)) {
        for (const attachment of msg.attachments) {
          mediaKeys.push(...fileMediaKeys(attachment as MediaFileLike));
        }
      }
    }
    const syncSnapsMap = await this.userSnapshotService.getUserSnapshotsMap(
      this.collectReactionUserIds(messages),
      this.cacheRepo
    );
    const syncSnapAvatarKeys = [...syncSnapsMap.values()]
      .map((s) => (s.avatar as string) || "")
      .filter(Boolean);

    const [urlMap, syncAvatarUrlMap, deletedUserIds] = await Promise.all([
      resolveMediaUrlMap(mediaKeys),
      resolveMediaUrlMap(syncSnapAvatarKeys),
      // Incremental sync replays rows the client will merge into its cache, so
      // it needs the same deleted-account scrubbing the history reads get —
      // otherwise a resync re-seeds the old name the history read just removed.
      collectDeletedUserIds(
        messages.flatMap((msg) =>
          collectRowUserIds(msg as unknown as Record<string, unknown>)
        ),
        this.userSnapshotService,
        this.cacheRepo
      ),
    ]);

    const items = messages.map((msg) => {
      const createdMs = msg.createdAt.getTime();
      const updatedMs = msg.updatedAt.getTime();
      const editedMs =
        msg.editedAt instanceof Date ? msg.editedAt.getTime() : null;

      // Derive what kind of mutation this update represents.
      let syncEventType: "new" | "edited" | "deleted" | "reacted";
      if (msg.deletedForAll) {
        syncEventType = "deleted";
      } else if (editedMs !== null) {
        syncEventType = "edited";
      } else if (updatedMs - createdMs > 2000) {
        // updatedAt is more than 2 s after createdAt — something mutated it
        // after creation (most likely a reaction, since edits set editedAt).
        syncEventType = "reacted";
      } else {
        syncEventType = "new";
      }

      // Transform stored reactions: rename avatar → avatarUrl, resolve S3 keys.
      const rawReactions = msg.reactions as Record<string, unknown> | null;
      const transformedReactions: Record<string, unknown[]> = {};
      if (rawReactions && typeof rawReactions === "object") {
        for (const [emoji, list] of Object.entries(rawReactions)) {
          if (!Array.isArray(list)) continue;
          transformedReactions[emoji] = list.map((r) => {
            const reactor = (r ?? {}) as Record<string, unknown>;
            const { avatar, ...rest } = reactor;
            const snap = syncSnapsMap.get(reactor.userId as string);
            return {
              ...rest,
              avatarUrl: snap
                ? urlFromMap(syncAvatarUrlMap, (snap.avatar as string) || "") ||
                  ""
                : urlFromMap(urlMap, (avatar as string) || "") || "",
            };
          });
        }
      }

      let messageText = msg.message ?? null;
      const contentType = normalizeMessageType(msg.messageType);
      if (contentType === "SYSTEM") {
        messageText = this.personalizeSystemText(
          msg.systemMessageType,
          msg.systemMetadata,
          messageText ?? "",
          params.userId,
          deletedUserIds
        );
      }

      return {
        id: msg.id,
        roomId: msg.roomId,
        sentBy: contentType === "SYSTEM" ? "" : msg.sentBy,
        senderName:
          contentType === "SYSTEM"
            ? null
            : deletedUserIds.has(msg.sentBy)
              ? DELETED_ACCOUNT_DISPLAY_NAME
              : (msg.senderName ?? null),
        senderAvatar:
          contentType === "SYSTEM" || deletedUserIds.has(msg.sentBy)
            ? null
            : urlFromMap(urlMap, msg.senderAvatar) || null,
        isDeletedUser:
          contentType !== "SYSTEM" && deletedUserIds.has(msg.sentBy),
        message: messageText,
        contentType,
        attachments: Array.isArray(msg.attachments)
          ? applyUrlMapToFiles(msg.attachments as MediaFileLike[], urlMap)
          : msg.attachments,
        reactions: Object.entries(transformedReactions).map(
          ([emoji, users]) => ({
            emoji,
            count: users.length,
            users: users as Array<{
              userId: string;
              displayName: string;
              avatarUrl: string;
            }>,
          })
        ),
        deletedForAll: msg.deletedForAll,
        isEdited: editedMs !== null,
        editedAt: editedMs,
        createdAt: createdMs,
        updatedAt: updatedMs,
        revision: msg.revision ?? 0,
        syncEventType,
        systemMessageType:
          (msg as Record<string, unknown>).systemMessageType ?? null,
        systemMetadata: (() => {
          const sanitized = sanitizeCommunitySystemMetadata(
            msg.systemMessageType,
            (msg as Record<string, unknown>).systemMetadata as
              | Record<string, unknown>
              | null
              | undefined
          );
          return sanitized
            ? anonymizeSystemData(sanitized, deletedUserIds)
            : null;
        })(),
      };
    });

    return { items, hasMore, nextCursor };
  }

  /**
   * Jump-to-message window: resolves the anchor's createdAt, then fetches a
   * window of `limit` messages centered around it.
   */
  async getMessagesAround(params: {
    roomId: string;
    userId: string;
    messageId: string;
    limit: number;
  }): Promise<
    { items: CommunityMessageWire[]; total: number } & AroundCursors
  > {
    return this.getAroundWindowShared({ ...params, strategy: "TIMESTAMP" });
  }

  /**
   * Shared jump-to-message window core for the date-anchored and seq-anchored
   * `around` reads. The window anchors on the message row itself;
   * the adapter reads only the cursor's STRATEGY (not its boundary), so a
   * strategy-tagged placeholder cursor selects the seq-vs-date window query AND
   * the matching continuation-cursor format. Access guard, `total`, media
   * resolution and serialization are identical for both axes.
   */
  private async getAroundWindowShared(params: {
    roomId: string;
    userId: string;
    messageId: string;
    limit: number;
    strategy: PaginationCursor["strategy"];
  }): Promise<
    { items: CommunityMessageWire[]; total: number } & AroundCursors
  > {
    const { member, bannedAtCutoff } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      params.roomId,
      params.userId,
      { allowBannedReadCutoff: true }
    );
    const viewerIsActiveMember = isActiveMember(member);
    const anchor = await this.messageRepo.findById(params.messageId);
    if (!anchor) {
      return { items: [], total: 0, ...EMPTY_AROUND_CURSORS };
    }
    const cursor: PaginationCursor =
      params.strategy === "SEQUENCE"
        ? { strategy: "SEQUENCE", seq: null }
        : {
            strategy: "TIMESTAMP",
            ts: new Date(0),
            boundaryId: null,
            inclusive: false,
          };
    const adapter = makeTimelineAdapter(this.messageRepo, cursor);
    const [{ rows, cursors }, total] = await Promise.all([
      adapter.around({
        roomId: params.roomId,
        userId: params.userId,
        anchor,
        limit: params.limit,
        viewerIsActiveMember,
        readCutoff: bannedAtCutoff,
      }),
      // Use the history-visible count (same filter as the timeline) so `total`
      // matches what the client can actually page through — not countByRoom's
      // raw total (which includes hidden/personal/deleted-for-me rows).
      this.messageRepo.countTimeline({
        roomId: params.roomId,
        userId: params.userId,
        viewerIsActiveMember,
        readCutoff: bannedAtCutoff,
      }),
    ]);
    const { urlMap, deletedUserIds } = await this.resolveRowsWireContext(rows);
    return {
      items: rows.map((m) =>
        this.toWire(m, urlMap, undefined, params.userId, deletedUserIds)
      ),
      total,
      ...cursors,
    };
  }

  /**
   * Paginated conversation page for a community room + mark-as-read side effect.
   * Enforces read access (active member, banned member capped at their ban
   * timestamp, or PUBLIC non-member — see `assertCommunityReadAccess`), fetches
   * the offset page (createdAt < timestamp, newest first), then advances the
   * caller's read pointer to the newest returned message (forward-only, ACTIVE
   * members only — a banned member has nothing new to mark read).
   */
  async getConversation(params: {
    roomId: string;
    userId: string;
    pageNumber: number;
    limit: number;
    timestamp?: number;
  }): Promise<{ messages: CommunityMessageWire[]; total: number }> {
    const { member, bannedAtCutoff } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      params.roomId,
      params.userId,
      { allowBannedReadCutoff: true }
    );

    const requestedBeforeMs = params.timestamp ?? Date.now();
    // A banned member's page is capped at their ban timestamp so nothing sent
    // after the ban is ever returned (Telegram-parity read-only history).
    const beforeMs = bannedAtCutoff
      ? Math.min(requestedBeforeMs, bannedAtCutoff.getTime())
      : requestedBeforeMs;
    const skip = (params.pageNumber - 1) * params.limit;

    const [messages, total] = await Promise.all([
      this.messageRepo.listConversationMessages({
        roomId: params.roomId,
        userId: params.userId,
        beforeMs,
        skip,
        take: params.limit,
      }),
      // Count must match the page's filter (createdAt < beforeMs + per-user
      // deletion exclusion), not the boundary-less countByRoom.
      this.messageRepo.countConversation({
        roomId: params.roomId,
        userId: params.userId,
        beforeMs,
      }),
    ]);

    // Mark-as-read: advance to the newest message in the page (index 0, since
    // the page is createdAt DESC). Forward-only; skip when the page is empty.
    // Runs on the RAW rows (needs id/createdAt) before we map to the wire shape.
    // Skipped entirely for a non-active viewer (banned/PUBLIC-non-member) — read
    // state is a member-only concept.
    const newest = messages[0];
    if (newest && isActiveMember(member)) {
      await this.memberRepo
        .advanceReadPointer(
          params.roomId,
          params.userId,
          newest.id,
          newest.createdAt
        )
        .then(() => {
          // Opening the transcript advances lastReadAt — push a fresh nav-badge
          // summary so communityUnread drops without waiting for an explicit
          // mark-read REST call (which does notifyUnreadChanged).
          notifyUnreadChanged(params.userId);
        })
        .catch((err: unknown) => {
          logger.warn(
            `CommunityMessageService|getConversation|advanceReadPointer failed: ${String(err)}`
          );
        });
    }

    const { urlMap, deletedUserIds } =
      await this.resolveRowsWireContext(messages);
    return {
      messages: messages.map((m) =>
        this.toWire(m, urlMap, undefined, params.userId, deletedUserIds)
      ),
      total,
    };
  }

  async searchMessages(params: {
    roomId: string;
    userId: string;
    query: string;
    limit: number;
    cursor?: string | null;
  }): Promise<{
    messages: CommunityMessageWire[];
    scores: Map<string, number>;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const { member, bannedAtCutoff } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      params.roomId,
      params.userId,
      { allowBannedReadCutoff: true }
    );
    const result = await this.messageRepo.searchByText({
      roomId: params.roomId,
      query: params.query,
      limit: params.limit,
      userId: params.userId,
      viewerIsActiveMember: isActiveMember(member),
      cursor: params.cursor,
      readCutoff: bannedAtCutoff,
    });
    const { urlMap, deletedUserIds } = await this.resolveRowsWireContext(
      result.messages
    );
    return {
      messages: result.messages.map((m) =>
        this.toWire(m, urlMap, undefined, params.userId, deletedUserIds)
      ),
      scores: result.scores,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
    };
  }

  async countMessages(roomId: string): Promise<number> {
    return this.messageRepo.countByRoom(roomId);
  }

  async countSearchResults(
    roomId: string,
    query: string,
    userId: string
  ): Promise<number> {
    const { member, bannedAtCutoff } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      roomId,
      userId,
      { allowBannedReadCutoff: true }
    );
    return this.messageRepo.countSearchResults(
      roomId,
      query,
      userId,
      isActiveMember(member),
      bannedAtCutoff
    );
  }

  async listMedia(params: {
    roomId: string;
    userId: string;
    type?: string;
    cursor?: string | null;
    limit: number;
  }): Promise<CommunityMessageWire[]> {
    const { bannedAtCutoff } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      params.roomId,
      params.userId,
      { allowBannedReadCutoff: true }
    );

    const rows = await this.messageRepo.listMedia({
      roomId: params.roomId,
      userId: params.userId,
      type: params.type,
      cursor: params.cursor,
      limit: params.limit,
      readCutoff: bannedAtCutoff,
    });
    const { urlMap, deletedUserIds } = await this.resolveRowsWireContext(rows);
    return rows.map((m) =>
      this.toWire(m, urlMap, undefined, params.userId, deletedUserIds)
    );
  }

  /** Bind a loaded message to its OWN room (never a body-supplied communityId)
   * and require the caller to be an ACTIVE member of that room. Returns the
   * member so callers needing the role (deleteForAll) avoid a second query.
   * NotFound — never Forbidden — so a foreign message's existence isn't leaked.
   * (cross-room IDOR guard for routes that carry no roomId.) */
  private async assertActiveMemberOfMessageRoom(
    message: GeneralRoomMessage,
    userId: string
  ): Promise<RoomMember> {
    const member = await this.memberRepo.findByRoomAndUser(
      message.roomId,
      userId
    );
    // Membership check FIRST so non-members get NotFound (no foreign-message
    // existence leak; a BANNED member gets USER_BANNED — their ban is not a
    // secret to them), THEN the write-ability gate so only real members learn
    // a room is closed/suspended.
    assertRoomMemberActive(
      member,
      () => new NotFoundError("CHAT_MESSAGE_NOT_FOUND")
    );
    assertCommunityRoomWritable(
      await this.roomRepo.findRoomById(message.roomId)
    );
    return member;
  }

  async editMessage(params: {
    messageId: string;
    userId: string;
    content: { text: string };
  }): Promise<GeneralRoomMessage> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // Authorize against the message's OWN room (never a body-supplied communityId):
    // the caller must be an ACTIVE member of the room the message lives in BEFORE
    // any sender/type/window check. Mirrors reactToMessage/listMedia; NotFound so
    // foreign-message existence isn't leaked. (cross-room IDOR)
    const editor = await this.assertActiveMemberOfMessageRoom(
      message,
      params.userId
    );
    // A muted member cannot mutate room content (Telegram: editing needs send).
    assertCommunityMemberNotMuted(editor);
    if (message.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (message.sentBy !== params.userId)
      throw new BadRequestError("CHAT_EDIT_OWN_MESSAGES_ONLY");
    // Community messages are persisted with the canonical UPPER-CASE type
    // ("TEXT"), so the guard must compare against UPPER — comparing to the old
    // lower-case "text" rejected every edit (→ SERVICE_ERROR). normalizeMessageType
    // also tolerates any legacy lower-case rows. Mirrors private/group (!== "TEXT").
    if (normalizeMessageType(message.messageType) !== "TEXT")
      throw new BadRequestError("CHAT_EDIT_TEXT_ONLY");
    if ((params.content?.text?.length ?? 0) > CHAT_TEXT_MAX_CHARS)
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    if (Date.now() - message.createdAt.getTime() > CHAT_EDIT_WINDOW_MS)
      throw new GoneError("CHAT_EDIT_WINDOW_EXPIRED");
    // Edit bumps the room CHANGE revision so the changes feed replays the new
    // content to offline clients even though the message's sequenceNumber is old.
    const revision = await this.roomRepo.allocateRevision(message.roomId);
    const updated = await this.messageRepo.editMessage(
      params.messageId,
      params.content.text,
      revision
    );
    // Best-effort: keep every existing reply's `quoteData.preview` in sync with
    // the new text (edits are TEXT-only, so preview === the new text verbatim).
    this.messageRepo
      .refreshReplyQuotes(params.messageId, {
        preview: buildReplyPreviewText(
          "TEXT",
          { text: params.content.text },
          0
        ),
      })
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|refreshReplyQuotes(edit) failed: ${String(err)}`
        );
      });
    return updated;
  }

  /**
   * Reconstruct the `{text, files, location, contact}` content shape
   * `convertMessageToPreview`/`buildReactionTargetPreview` expect, from a raw
   * stored message row. Mirrors `ChatMessageOrchestrator`'s
   * `firstAttachmentOfType` extraction so a reaction's target preview matches
   * EXACTLY what that message's own send-time list/push preview showed
   * (filename / place name / contact name included), instead of falling back
   * to the type's generic label.
   */
  private messagePreviewContent(message: {
    message: string | null;
    attachments: unknown;
  }): {
    text: string;
    files: Array<Record<string, unknown>>;
    location?: Record<string, unknown>;
    contact?: Record<string, unknown>;
  } {
    const attachments = Array.isArray(message.attachments)
      ? (message.attachments as Array<Record<string, unknown>>)
      : [];
    const byType = (type: string): Record<string, unknown> | undefined => {
      const hit = attachments.find(
        (a) => a && (a as { type?: string }).type === type
      );
      if (!hit) return undefined;
      const { type: _omit, ...rest } = hit;
      void _omit;
      return rest;
    };
    const location = byType("location");
    const contact = byType("contact");
    return {
      text: message.message ?? "",
      files: attachments,
      ...(location ? { location } : {}),
      ...(contact ? { contact } : {}),
    };
  }

  async reactToMessage(params: {
    messageId: string;
    userId: string;
    emoji: string;
    /** "set" => caller ends up with exactly `emoji` (re-sending the same one clears it), so a
     *  reaction CHANGE is ONE call instead of remove-then-add — no intermediate empty broadcast.
     *  Default/absent keeps the legacy per-emoji toggle. */
    mode?: string;
  }): Promise<{
    messageId: string;
    roomId: string;
    /** Room CHANGE revision assigned to this reaction mutation (zero-loss feed). */
    revision: number;
    reactions: Array<{
      emoji: string;
      count: number;
      users: Array<{ userId: string; displayName: string; avatarUrl: string }>;
    }>;
    /** True when this call ADDED the reactor to the bucket; false when it REMOVED them (toggle-off). */
    added: boolean;
    /** Reactor's display name (resolved from the same snapshot fetch used to enrich the stored reactors). */
    actorName: string;
    /** The reacted-to message's owner — the OTHER personalized viewer besides the actor. */
    targetUserId: string;
    /** The reacted-to message's own preview text (quoted text or media label). */
    targetMessagePreview: string;
  }> {
    const first = await this.messageRepo.findById(params.messageId);
    if (!first) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (first.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (normalizeMessageType(first.messageType) === "SYSTEM")
      throw new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE");

    // Guard: only active members may react (banned → USER_BANNED).
    const member = await this.memberRepo.findByRoomAndUser(
      first.roomId,
      params.userId
    );
    assertRoomMemberActive(member);
    // A muted member can neither add NOR remove a reaction (this path toggles).
    assertCommunityMemberNotMuted(member);
    // ...and only when the community room is open (closed/suspended → read-only).
    assertCommunityRoomWritable(await this.roomRepo.findRoomById(first.roomId));

    // Compare-and-swap loop: two concurrent reacts on the same message would
    // otherwise both read the same stale `reactions` map and each write back
    // an independently-computed result, silently dropping one of them (lost
    // update). `revision` is bumped on EVERY state change to this message, so
    // matching it in the write's WHERE clause turns the write into a CAS —
    // a losing racer's write affects 0 rows and retries against fresh state.
    const MAX_ATTEMPTS = 5;
    let message = first;
    let added = false;
    let enrichedReactions: Record<string, StoredReactor[]> = {};
    let revision = message.revision;
    let snaps = new Map<string, Record<string, unknown>>();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const refetched = await this.messageRepo.findById(params.messageId);
        if (!refetched) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
        message = refetched;
      }

      // Determine add vs remove BEFORE toggling — the lastActivity preview must
      // only bump on add (Telegram never shows a "removed their reaction" line).
      const wasReactedByUser = (
        reactionUserIdMap(message.reactions)[params.emoji] ?? []
      ).includes(params.userId);
      added = !wasReactedByUser;

      // Toggle the reactor in/out of the emoji bucket (shared with private/group).
      const updatedReactions = toggleStoredReaction(
        message.reactions,
        params.userId,
        params.emoji
      );

      // Fetch snapshots BEFORE persisting so the stored document carries real
      // userName / avatar / memberId (fixes the raw `reactions` field on read).
      const allUserIds = [
        ...new Set(
          Object.values(updatedReactions)
            .flat()
            .map((e) => e.userId)
            .filter(Boolean)
        ),
      ];

      snaps =
        allUserIds.length > 0
          ? await this.userSnapshotService.getUserSnapshotsMap(
              allUserIds,
              this.cacheRepo
            )
          : new Map<string, Record<string, unknown>>();

      // Enrich stored reactor objects with live profile data.
      enrichedReactions = {};
      for (const [emoji, reactors] of Object.entries(updatedReactions)) {
        enrichedReactions[emoji] = reactors.map((r) => {
          const snap = snaps.get(r.userId);
          return {
            userId: r.userId,
            userName: (snap?.displayName as string) || r.userName || "",
            avatar: (snap?.avatar as string) || r.avatar || "",
            memberId: (snap?.memberId as string) || r.memberId || "",
          };
        });
      }

      // Reaction change bumps the room CHANGE revision so the changes feed
      // replays the message's current aggregate to offline clients.
      revision = await this.roomRepo.allocateRevision(message.roomId);
      const applied = await this.messageRepo.updateReactionsCas(
        params.messageId,
        enrichedReactions,
        message.revision,
        revision
      );
      if (applied) break;
      if (attempt === MAX_ATTEMPTS - 1)
        throw new ConflictError("CHAT_REACTION_CONFLICT");
    }

    // Resolve the stored avatar object-keys to full presigned download URLs so
    // both the REST response and the socket broadcast carry real URLs.
    const allAvatarKeys = Object.values(enrichedReactions)
      .flat()
      .map((r) => r.avatar)
      .filter(Boolean);
    const avatarUrlMap = await resolveMediaUrlMap(allAvatarKeys);

    const reactionGroups = Object.entries(enrichedReactions)
      .filter(([, users]) => users.length > 0)
      .map(([emoji, users]) => ({
        emoji,
        count: users.length,
        users: users.map((u) => ({
          userId: u.userId,
          displayName: u.userName,
          avatarUrl: urlFromMap(avatarUrlMap, u.avatar) || "",
        })),
      }));

    return {
      messageId: params.messageId,
      roomId: message.roomId,
      revision,
      reactions: reactionGroups,
      added,
      // Only guaranteed present in `snaps` when added===true (the actor was just
      // pushed into the bucket); callers only need this in that case.
      actorName: (snaps.get(params.userId)?.displayName as string) || "",
      targetUserId: message.sentBy,
      targetMessagePreview: buildReactionTargetPreview(
        normalizeMessageType(message.messageType),
        this.messagePreviewContent(message)
      ),
    };
  }

  /**
   * Best-effort LIVE nudge after a reaction is removed — NOT the source of
   * truth for whether the reaction overlay actually cleared (that's
   * community-service's `clearReactionActivityIfCurrent`, gated by an
   * identity match on messageId+emoji+actorId). This just gives the reaction's
   * former actor/target an immediate refresh to the room's real latest
   * activity over the socket; if the removed reaction wasn't the one being
   * displayed to them, this resends the same value they already see (a safe
   * no-op), so no identity check is needed here at all.
   */
  async getLatestRealActivityForLiveBump(roomId: string): Promise<{
    prevMessageId: string | null;
    preview: string;
    messageType: string;
    sentBy: string;
    senderName: string;
    createdAt: Date;
    hasLastMessage: boolean;
  }> {
    const prev = await this.messageRepo.findPreviousVisibleMessage(roomId);
    if (!prev) {
      return {
        prevMessageId: null,
        preview: "",
        messageType: "",
        sentBy: "",
        senderName: "",
        createdAt: new Date(0),
        hasLastMessage: false,
      };
    }
    return {
      prevMessageId: prev.id,
      preview: convertMessageToPreview(
        prev.messageType,
        this.messagePreviewContent(prev)
      ),
      messageType: prev.messageType,
      sentBy: prev.sentBy,
      senderName: prev.senderName ?? "",
      createdAt: prev.createdAt,
      hasLastMessage: true,
    };
  }

  async deleteForMe(
    messageId: string,
    userId: string
  ): Promise<GeneralRoomMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // Authorize against the message's OWN room (never a body-supplied communityId):
    // only an ACTIVE member of the room the message lives in may hide it. Mirrors
    // reactToMessage; NotFound so foreign-message existence isn't leaked.
    const delForMeMember = await this.assertActiveMemberOfMessageRoom(
      message,
      userId
    );
    assertCommunityMemberNotMuted(delForMeMember);

    if (normalizeMessageType(message.messageType) === "SYSTEM")
      throw new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE");

    await this.messageRepo.deleteForUser(messageId, userId);
    return this.messageRepo.findById(messageId);
  }

  async deleteForAll(
    messageId: string,
    userId: string
  ): Promise<GeneralRoomMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    // Authorize against the message's OWN room (never a body-supplied communityId):
    // the caller must be an ACTIVE member of the room the message lives in. NotFound
    // so foreign-message existence isn't leaked. (cross-room IDOR)
    const member = await this.assertActiveMemberOfMessageRoom(message, userId);

    // Mirrors editMessage/pinMessage/reactToMessage: a message already tombstoned
    // for everyone cannot be deleted-for-everyone again (idempotent no-op would
    // hide a genuine "this was already handled" signal from the client).
    if (message.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");

    if (normalizeMessageType(message.messageType) === "SYSTEM")
      throw new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE");

    // Sender can always delete their own message for everyone.
    // Others need admin or moderator role — checked LIVE against
    // community-service (source of truth), not the possibly-stale
    // RoomMember.role `member` carries. roomId === communityId for community
    // general rooms.
    let deletedType: "SELF_DELETE" | "ADMIN_DELETE";
    if (message.sentBy !== userId) {
      const liveRole = await getCommunityLiveRole(message.roomId, userId);
      // A MODERATOR may not delete an ADMIN's (or a peer MODERATOR's) message —
      // the sender's role is resolved from the SAME live source, and only in the
      // moderator branch so an admin delete still costs one lookup.
      const senderRole =
        liveRole === "moderator" && message.sentBy
          ? await getCommunityLiveRole(message.roomId, message.sentBy)
          : "";
      if (!canDeleteOthersMessage(liveRole, senderRole)) {
        throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
      }
      // Admin/mod deleting someone else's message is moderation — not gated by mute.
      deletedType = "ADMIN_DELETE";
    } else {
      // Muted member cannot delete their own messages.
      assertCommunityMemberNotMuted(member);
      deletedType = "SELF_DELETE";
    }

    // Audit trail (deletedForAllType/At/By) mirrors GroupMessage's tombstone —
    // previously this was a bare boolean with no record of who deleted it or
    // when, unlike Group's fully-audited equivalent.
    // Delete-for-everyone bumps the room CHANGE revision so the changes feed
    // replays the tombstone (row kept, content neutralized) to offline clients.
    const revision = await this.roomRepo.allocateRevision(message.roomId);
    const deleted = await this.messageRepo.deleteForAll(messageId, {
      deletedType,
      deletedBy: userId,
      revision,
    });
    // Best-effort: flip `quoteData.isDeleted` on every existing reply to this
    // message so "Message deleted" shows up everywhere, not just for replies
    // sent after this delete.
    this.messageRepo
      .refreshReplyQuotes(messageId, { isDeleted: true })
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|refreshReplyQuotes(delete) failed: ${String(err)}`
        );
      });
    return deleted;
  }

  /**
   * After a delete-for-everyone, if the deleted message was the room's current
   * last message, recalculate and persist the new last message from the previous
   * visible community-wide message.
   *
   * Returns the recalculated data so the caller can broadcast it via sockets and
   * the community.activity queue, OR null when the deleted message was NOT the
   * last (no-op: callers must not broadcast any update in that case).
   */
  async recalculateLastMessageAfterDelete(
    roomId: string,
    deletedMessageId: string
  ): Promise<{
    prevMessageId: string | null;
    preview: string;
    messageType: string;
    sentBy: string;
    senderName: string;
    createdAt: Date;
    hasLastMessage: boolean;
    /** Offline-first list identity of the new previous-visible last message. */
    clientMessageId: string | null;
    sequenceNumber: number;
    revision: number;
  } | null> {
    // Run both queries in parallel — we need prev regardless of which message
    // was the current last. The classic check (room.lastMessageId === deletedId)
    // has a race: if a prior delete's fire-and-forget setLastMessage hasn't
    // landed yet, lastMessageId is stale and the check incorrectly returns null.
    // Instead we skip only when the visible-last genuinely hasn't changed.
    const [room, prev] = await Promise.all([
      this.roomRepo.findRoomById(roomId),
      this.messageRepo.findPreviousVisibleMessage(roomId),
    ]);
    if (!room) return null;
    // Skip if the deleted message wasn't the current last AND the visible-last
    // is still the same as what's stored (i.e. nothing actually changed).
    if (
      room.lastMessageId !== deletedMessageId &&
      room.lastMessageId === (prev?.id ?? null)
    ) {
      return null;
    }
    if (prev) {
      await this.roomRepo.setLastMessage(roomId, {
        id: prev.id,
        sentBy: prev.sentBy,
        senderName: prev.senderName ?? "",
        content: prev.message ?? "",
        messageType: prev.messageType,
        createdAt: prev.createdAt,
        clientMessageId: prev.clientMessageId,
        sequenceNumber: prev.sequenceNumber,
        revision: prev.revision,
      });
      return {
        prevMessageId: prev.id,
        preview: convertMessageToPreview(
          prev.messageType,
          this.messagePreviewContent(prev)
        ),
        messageType: prev.messageType,
        sentBy: prev.sentBy,
        senderName: prev.senderName ?? "",
        createdAt: prev.createdAt,
        hasLastMessage: true,
        clientMessageId: prev.clientMessageId ?? null,
        sequenceNumber: prev.sequenceNumber,
        revision: prev.revision,
      };
    }

    await this.roomRepo.setLastMessage(roomId, null);
    return {
      prevMessageId: null,
      preview: "",
      messageType: "",
      sentBy: "",
      senderName: "",
      createdAt: new Date(0),
      hasLastMessage: false,
      clientMessageId: null,
      sequenceNumber: 0,
      revision: 0,
    };
  }

  /**
   * After a delete-for-me on the last message, finds the previous message
   * visible to that specific member (skipping globally-deleted messages,
   * messages they personally hid, personal system messages, and hidden
   * lifecycle lines). Returns data for a targeted community:updated socket
   * broadcast to that user only — does NOT touch the shared GeneralRoom
   * lastMessage snapshot or the community-service lastActivityPreview.
   * Returns null when the deleted message was not the room's current last.
   */
  async recalculateLastMessageAfterDeleteForMe(
    roomId: string,
    deletedMessageCreatedAt: Date,
    userId: string
  ): Promise<{
    prevMessageId: string | null;
    preview: string;
    messageType: string;
    sentBy: string;
    senderName: string;
    createdAt: Date;
    hasLastMessage: boolean;
    /** True iff the deleted message was the viewer's last visible message — the
     *  ONLY case where a targeted list bump is warranted (else it is a no-op). */
    /** Offline-first list identity of the new previous-visible last message. */
    clientMessageId: string | null;
    sequenceNumber: number;
    revision: number;
    wasEffectiveLast: boolean;
  } | null> {
    const room = await this.roomRepo.findRoomById(roomId);
    if (!room) return null;
    // No early-return on lastMessageId check: the deleted message may not be
    // the globally-last but could still be the user's effective last visible.
    const prev = await this.messageRepo.findPreviousVisibleForUser(
      roomId,
      userId
    );
    // The deleted (now-hidden) message was the viewer's last iff nothing still
    // visible is newer than it (single source of truth: deletedWasEffectiveLast).
    const wasEffectiveLast = deletedWasEffectiveLast(
      prev?.createdAt ?? null,
      deletedMessageCreatedAt
    );
    if (prev) {
      return {
        prevMessageId: prev.id,
        preview: convertMessageToPreview(
          prev.messageType,
          this.messagePreviewContent(prev)
        ),
        messageType: prev.messageType,
        sentBy: prev.sentBy,
        senderName: prev.senderName ?? "",
        createdAt: prev.createdAt,
        hasLastMessage: true,
        wasEffectiveLast,
        clientMessageId: prev.clientMessageId ?? null,
        sequenceNumber: prev.sequenceNumber,
        revision: prev.revision,
      };
    }
    return {
      prevMessageId: null,
      preview: "",
      messageType: "",
      sentBy: "",
      senderName: "",
      createdAt: new Date(0),
      hasLastMessage: false,
      wasEffectiveLast: true,
      clientMessageId: null,
      sequenceNumber: 0,
      revision: 0,
    };
  }

  async report(params: {
    messageId: string;
    reporterId: string;
    reportReason: string;
  }): Promise<GeneralRoomMessage | null> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    const member = await this.memberRepo.findByRoomAndUser(
      message.roomId,
      params.reporterId
    );
    assertRoomMemberActive(
      member,
      () => new NotFoundError("CHAT_MESSAGE_NOT_FOUND")
    );
    return this.messageRepo.addReport(params.messageId, {
      userReportId: params.reporterId,
      userReportReason: params.reportReason,
    });
  }

  async pinMessage(params: {
    messageId: string;
    userId: string;
    roomId: string;
    communityId: string;
  }): Promise<{ pinnedIds: string[]; pinnedCount: number; pinnedAt: number }> {
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    assertRoomMemberActive(member);
    if (!["admin", "moderator"].includes(member.role))
      throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");

    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.roomId !== params.roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (normalizeMessageType(message.messageType) === "SYSTEM")
      throw new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE");

    const room = await this.roomRepo.findRoomById(params.roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    assertCommunityRoomWritable(room);
    const pinnedIds: string[] = Array.isArray(room.listPinedMessage)
      ? (room.listPinedMessage as string[])
      : [];

    if (pinnedIds.length >= env.PIN_LIMIT_PER_ROOM)
      throw new BadRequestError("CHAT_PIN_LIMIT_REACHED");

    if (pinnedIds.includes(params.messageId)) {
      return { pinnedIds, pinnedCount: pinnedIds.length, pinnedAt: Date.now() };
    }

    const newPinnedIds = [...pinnedIds, params.messageId];
    await this.roomRepo.updatePinnedMessages(params.roomId, newPinnedIds);

    // Telegram-style "{actor} pinned a message" SYSTEM line (best-effort).
    void this.systemMessageService?.post({
      communityId: params.communityId,
      systemMessageType: "PINNED_MESSAGE",
      metadata: { pinnedMessageId: params.messageId },
      triggeredByUserId: params.userId,
    });

    return {
      pinnedIds: newPinnedIds,
      pinnedCount: newPinnedIds.length,
      pinnedAt: Date.now(),
    };
  }

  /**
   * Per-message read receipt: advance the reader's read pointer to
   * `upToMessageId` and publish two Redis events:
   *   1. `community:<communityId>` → `community:message:read`  (room broadcast)
   *   2. `user:<readerId>`         → `community:read_sync`      (own-device sync)
   */
  async markMessageRead(params: {
    communityId: string;
    roomId: string;
    readerId: string;
    upToMessageId: string;
  }): Promise<{ ok: boolean; communityId: string; readAt: number }> {
    // Validate active membership.
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.readerId
    );
    assertRoomMemberActive(member);

    // Fetch the message to get its createdAt (advanceReadPointer is forward-only).
    const message = await this.messageRepo.findById(params.upToMessageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const now = new Date();
    // Advance read pointer (forward-only — noop if already at/past this message).
    await this.memberRepo
      .advanceReadPointer(
        params.roomId,
        params.readerId,
        params.upToMessageId,
        now
      )
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|markMessageRead|advanceReadPointer failed: ${String(err)}`
        );
      });

    const readAt = now.getTime();
    const readPayload = {
      communityId: params.communityId,
      readerId: params.readerId,
      upToMessageId: params.upToMessageId,
      readAt,
    };

    // Broadcast to all community room members — but only if the READER still
    // shows read receipts (Settings → Chat). Same sender-side gate private and
    // group already apply in ChatMessageOrchestrator.markReadDirect; community
    // was publishing the reader's identity to the whole room regardless.
    // Gates the room broadcast ONLY: the pointer above, `community:read_sync`
    // below, the unread recount and the nav badge are the reader's own state
    // and must keep working with the switch off.
    if (await mayBroadcastReadReceipts(params.readerId)) {
      redis
        .publish(
          `community:${params.communityId}`,
          JSON.stringify({ event: "community:message:read", data: readPayload })
        )
        .catch((err: unknown) => {
          logger.warn(
            `CommunityMessageService|markMessageRead|redis publish community failed: ${String(err)}`
          );
        });
    }

    // Sync to reader's own other devices. `readerId` + `unreadCount` are what let a SECOND device
    // actually clear its badge — without them the receiver knows a read happened but not whose or
    // what the new count is, so the badge never cleared. Private/group have carried both since
    // day one (see ChatMessageOrchestrator.markRead); community silently omitted them.
    // try/catch, not .catch() — marking read must never fail because the badge count did, and a
    // rejected promise is only half the risk (an absent repo method throws synchronously).
    let unreadAfterRead = 0;
    try {
      const counts = await this.messageRepo.countUnreadBulk({
        userId: params.readerId,
        thresholds: [{ roomId: params.communityId, afterDate: now }],
      });
      unreadAfterRead = counts[params.communityId]?.count ?? 0;
    } catch (err: unknown) {
      logger.warn(
        `CommunityMessageService|markMessageRead|countUnread failed: ${String(err)}`
      );
    }

    redis
      .publish(
        `user:${params.readerId}`,
        JSON.stringify({
          event: "community:read_sync",
          data: {
            communityId: params.communityId,
            readerId: params.readerId,
            upToMessageId: params.upToMessageId,
            unreadCount: unreadAfterRead,
            readAt,
          },
        })
      )
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|markMessageRead|redis publish user failed: ${String(err)}`
        );
      });

    // Nav-badge total changed for the reader — see unread-summary-bridge.ts.
    notifyUnreadChanged(params.readerId);

    return { ok: true, communityId: params.communityId, readAt };
  }

  /**
   * Delivery receipt: validates that the recipient is an active member, then
   * broadcasts `community:message:delivered` on the community Redis channel so
   * connected clients (especially the sender) can update their delivery indicator.
   *
   * Community delivery state is inferred from RoomMember.joinedAt (no per-message
   * DB write — the GeneralRoomMessage schema has no deliveredTo column), so this
   * handler is purely a signal: "recipient has received up to this message".
   */
  async markMessageDelivered(params: {
    communityId: string;
    roomId: string;
    recipientId: string;
    upToMessageId: string;
  }): Promise<{ ok: boolean; communityId: string; deliveredAt: number }> {
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.recipientId
    );
    assertRoomMemberActive(member);

    const deliveredAt = Date.now();

    redis
      .publish(
        `community:${params.communityId}`,
        JSON.stringify({
          event: "community:message:delivered",
          data: {
            communityId: params.communityId,
            recipientId: params.recipientId,
            upToMessageId: params.upToMessageId,
            deliveredAt,
          },
        })
      )
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|markMessageDelivered|redis publish failed: ${String(err)}`
        );
      });

    return { ok: true, communityId: params.communityId, deliveredAt };
  }

  /**
   * Return the full grouped reaction list for a message. Validates active
   * membership and resolves avatar object-keys to presigned URLs.
   */
  async getMessageReactions(params: {
    messageId: string;
    communityId: string;
    requesterId: string;
  }): Promise<{
    messageId: string;
    communityId: string;
    reactions: Array<{
      emoji: string;
      count: number;
      users: Array<{ userId: string; displayName: string; avatar: string }>;
    }>;
  }> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    // Validate active membership.
    const member = await this.memberRepo.findByRoomAndUser(
      message.roomId,
      params.requesterId
    );
    assertRoomMemberActive(member);

    const raw = (message.reactions ?? {}) as Record<string, unknown>;
    const allAvatarKeys: string[] = [];
    const grouped: Array<{
      emoji: string;
      count: number;
      users: Array<{ userId: string; displayName: string; avatar: string }>;
    }> = [];

    for (const [emoji, list] of Object.entries(raw)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      const users = list.map((r) => {
        const reactor = (r ?? {}) as Record<string, unknown>;
        const avatar = (reactor.avatar as string) || "";
        if (avatar) allAvatarKeys.push(avatar);
        return {
          userId: (reactor.userId as string) || "",
          displayName:
            (reactor.userName as string) ||
            (reactor.displayName as string) ||
            "",
          avatar,
        };
      });
      grouped.push({ emoji, count: users.length, users });
    }

    // Refresh displayNames from live snapshots so renames are reflected.
    const allUserIds = [
      ...new Set(
        grouped.flatMap((g) => g.users.map((u) => u.userId).filter(Boolean))
      ),
    ];
    const snaps =
      allUserIds.length > 0
        ? await this.userSnapshotService.getUserSnapshotsMap(
            allUserIds,
            this.cacheRepo
          )
        : new Map<string, Record<string, unknown>>();

    const urlMap = await resolveMediaUrlMap(allAvatarKeys);
    const resolved = grouped.map((g) => ({
      ...g,
      users: g.users.map((u) => {
        const snap = snaps.get(u.userId);
        return {
          ...u,
          displayName: (snap?.displayName as string) || u.displayName,
          avatar: urlFromMap(urlMap, u.avatar) || u.avatar,
        };
      }),
    }));

    return {
      messageId: params.messageId,
      communityId: params.communityId,
      reactions: resolved,
    };
  }

  /**
   * Forward a community message to another community room. Fetches the source
   * message, verifies the sender is an ACTIVE member of the target room, then
   * delegates to `sendMessage` so all live effects (broadcast, push, bump-to-top)
   * run automatically via the existing send path.
   */
  async forwardMessage(params: {
    sourceMessageId: string;
    sourceCommunityId: string;
    targetCommunityId: string;
    targetRoomId: string;
    senderId: string;
    clientMessageId: string;
  }): Promise<
    GeneralRoomMessage & { messageId: string; roomId: string; sentAt: number }
  > {
    const source = await this.messageRepo.findById(params.sourceMessageId);
    if (!source) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (source.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");

    // The caller's asserted source room must match the message's actual room,
    // and the caller must be an ACTIVE member of THAT room — without this, a
    // caller could exfiltrate any community message by claiming an arbitrary
    // sourceCommunityId. Mirrors private/group's `assertCallerInMessageRoom`,
    // closing the cross-community forward read-IDOR.
    if (source.roomId !== params.sourceCommunityId) {
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    }
    await assertCommunityMember(
      this.memberRepo,
      source.roomId,
      params.senderId
    );

    // Validate sender is ACTIVE member of the target room.
    const targetMember = await this.memberRepo.findByRoomAndUser(
      params.targetRoomId,
      params.senderId
    );
    assertRoomMemberActive(targetMember);

    // Fetch sender snapshot for display name + avatar.
    const snaps = await this.userSnapshotService.getUserSnapshotsMap(
      [params.senderId],
      this.cacheRepo
    );
    const snap = snaps.get(params.senderId);
    const senderName = (snap?.displayName as string) || "";
    const senderAvatar = (snap?.avatar as string) || "";

    const saved = await this.sendMessage({
      roomId: params.targetRoomId,
      sentBy: params.senderId,
      senderName,
      senderAvatar,
      message: source.message ?? "",
      messageType: normalizeMessageType(source.messageType),
      clientMessageId: params.clientMessageId,
      attachments: Array.isArray(source.attachments)
        ? (source.attachments as Array<Record<string, unknown>>)
        : undefined,
      forwardData: {
        originalMessageId: source.id,
        originalRoomId: source.roomId,
        originalSenderId: source.sentBy ?? "",
        originalCreatedAt: source.createdAt.toISOString(),
        originalMessageType: source.messageType,
      },
    });

    const sentAt =
      saved.createdAt instanceof Date ? saved.createdAt.getTime() : Date.now();

    return { ...saved, messageId: saved.id, roomId: saved.roomId, sentAt };
  }

  async unpinMessage(params: {
    messageId: string;
    userId: string;
    roomId: string;
    communityId: string;
  }): Promise<{ pinnedIds: string[]; pinnedCount: number }> {
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    assertRoomMemberActive(member);
    if (!["admin", "moderator"].includes(member.role))
      throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");

    const room = await this.roomRepo.findRoomById(params.roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    assertCommunityRoomWritable(room);
    const pinnedIds: string[] = Array.isArray(room.listPinedMessage)
      ? (room.listPinedMessage as string[])
      : [];

    if (!pinnedIds.includes(params.messageId))
      throw new NotFoundError("CHAT_PIN_NOT_FOUND");

    const targetMsg = await this.messageRepo.findById(params.messageId);
    if (targetMsg && normalizeMessageType(targetMsg.messageType) === "SYSTEM")
      throw new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE");

    const newPinnedIds = pinnedIds.filter((id) => id !== params.messageId);
    await this.roomRepo.updatePinnedMessages(params.roomId, newPinnedIds);

    // Telegram-style "{actor} unpinned a message" SYSTEM line (best-effort).
    void this.systemMessageService?.post({
      communityId: params.communityId,
      systemMessageType: "UNPINNED_MESSAGE",
      metadata: { pinnedMessageId: params.messageId },
      triggeredByUserId: params.userId,
    });

    return { pinnedIds: newPinnedIds, pinnedCount: newPinnedIds.length };
  }

  /** Fetch a single message by ID, checking it belongs to the given room. */
  async findMessageById(
    messageId: string,
    roomId: string
  ): Promise<GeneralRoomMessage | null> {
    const msg = await this.messageRepo.findById(messageId);
    if (!msg || msg.roomId !== roomId) return null;
    return msg;
  }

  /**
   * Assert the caller is an active member of this community room.
   * Used by REST endpoints that don't need write access (e.g. context navigation).
   */
  async assertMember(roomId: string, userId: string): Promise<void> {
    await assertCommunityMember(this.memberRepo, roomId, userId);
  }

  /**
   * Per-message "Viewed by" sheet for a COMMUNITY message. Sender-only.
   *
   * The candidate set comes from `findActiveReadersSince(createdAt)`, NOT from
   * the roster: a 5 000-member community is answered by loading only the members
   * whose read pointer moved after this message existed. Banned and departed
   * members are excluded by that query's status filter.
   */
  async getReadReceipts(
    roomId: string,
    messageId: string,
    userId: string
  ): Promise<ReadReceiptsPayload> {
    await assertCommunityMember(this.memberRepo, roomId, userId);
    const message = await this.findMessageById(messageId, roomId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.deletedForAll) throw new GoneError("CHAT_MESSAGE_DELETED");
    if (message.sentBy !== userId)
      throw new ForbiddenError("CHAT_NOT_MESSAGE_SENDER");
    await assertMaySeeReadReceipts(userId);

    const members = (
      await this.memberRepo.findActiveReadersSince(roomId, message.createdAt)
    ).filter((m) => m.userId !== userId && m.lastReadMessageId);
    const uniqueReadIds = [
      ...new Set(members.map((m) => m.lastReadMessageId as string)),
    ];
    const seqById = new Map(
      (await this.messageRepo.findSequencesByIds(uniqueReadIds)).map((m) => [
        m.id,
        m.sequenceNumber ?? 0,
      ])
    );

    return buildReadReceipts({
      messageId,
      candidates: readersAtOrPast(
        members,
        seqById,
        message.sequenceNumber ?? 0
      ),
      userSnapshotService: this.userSnapshotService,
      cacheRepo: this.cacheRepo,
    });
  }
}
