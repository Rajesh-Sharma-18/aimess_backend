import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from "@aimess/errors";
import { logger } from "@aimess/logger";

import {
  CHAT_EDIT_WINDOW_MS,
  CHAT_TEXT_MAX_CHARS,
  assertAttachmentsValid,
} from "../constants/media-limits.js";
import { publishAdminReportIngestSafe } from "../events/publish-admin-report.js";
import { buildReactionTargetPreview } from "./message-preview.service.js";
import {
  normalizeMessageType,
  buildCanonicalQuote,
  tombstoneWireFields,
  buildReplyQuoteSnapshot,
  buildReplyPreviewText,
  buildReactionGroups,
  reactionUserIdMap,
  toggleStoredReaction,
  setStoredReaction,
  toWireMessage,
  isCommunityInvitationMessage,
  buildCommunityInvitationAction,
  isGroupInvitationMessage,
  buildGroupInvitationAction,
  type CanonicalQuote,
} from "../lib/chat-message.serializer.js";
import { assertPrivateParticipant } from "../lib/access-guard.js";
import {
  computeAutoDeleteStamp,
  readRoomAutoDelete,
  AUTO_DELETE_NONE,
  AUTO_DELETE_AFTER_VIEW_GRACE_SEC,
  type AutoDeleteStamp,
} from "../lib/auto-delete.js";
import { getPrivateDeletionCutoff } from "../lib/deletion-cutoff.js";
import {
  computeSeqAroundCursors,
  type AroundCursors,
  computeSeqPageCursors,
} from "../lib/around-cursors.js";
import { isDuplicateKeyError } from "../lib/db-errors.js";
import { markIdempotentReplay } from "../lib/idempotency.js";
import {
  attachAlbumMessages,
  markAlbumIdempotentReplay,
  resolveParentMessageId,
  resolveReplyAttachmentCount,
} from "../lib/album-messages.js";
import { splitDirectMediaAlbum } from "../lib/split-media-album.js";
import {
  resolveForEveryoneOverrides,
  deletedWasEffectiveLast,
  type RecipientOverride,
} from "./last-visible-resolver.js";
import { privateVisibilitySource } from "./last-visible-adapters.js";
import {
  resolveMediaUrl,
  resolveMediaUrlMap,
  urlFromMap,
  applyUrlMapToFiles,
  fileMediaKey,
  fileMediaKeys,
  resolveQuoteThumbnail,
  resolveStickerField,
  type MediaFileLike,
} from "../lib/media-resolve.js";
import { shouldCountInUnread } from "../lib/unread-count.js";

import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { PrivateMessageReportRepository } from "../repositories/private-message-report.repository.js";
import type { UserServiceClient } from "../grpc/user.client.js";
import type { CommunityReconcileClient } from "../grpc/community.client.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { GroupInviteLinkRepository } from "../repositories/group-invite-link.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import {
  currentLocale,
  personalizePrivateSystemMessageForViewer,
} from "@aimess/constants";
import { allocateRoomSlot } from "../lib/room-lock.js";
import type { PresenceService } from "./presence.service.js";
import type { Redis, Cluster } from "ioredis";
import type {
  PrivateMessage,
  PrivateMessageReport,
} from "../generated/prisma/index.js";

export class PrivateMessageService {
  constructor(
    private readonly messageRepo: PrivateMessageRepository,
    private readonly roomRepo: PrivateRoomRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly userServiceClient: UserServiceClient,
    private readonly reportRepo: PrivateMessageReportRepository,
    // ponytail: optional — omitted in existing unit tests; COMMUNITY_INVITE
    // messages just fall back to "assume the invite is still usable" (see
    // enrichMessages) when no client is wired, same fail-open policy as an
    // actual gRPC/community-service outage.
    private readonly communityClient?: CommunityReconcileClient,
    // Presence-aware delivery: when injected, sendMessage checks the peer's
    // live socket status and — if online — persists deliveredTo + publishes
    // `message:delivered` immediately, so the sender's tick flips to ✓✓ without
    // depending on the client-triggered `message:delivered` ack ever arriving.
    // Optional so existing unit tests that construct the service without these
    // keep working (delivery just stays "sent" until the client ack lands).
    private readonly presenceService?: PresenceService,
    private readonly redis?: Redis | Cluster | null,
    // Optional — GROUP_INVITE cards resolve membership/link state directly via
    // these repos (unlike COMMUNITY_INVITE, group data lives in this same
    // service, so no gRPC round-trip is needed). Omitted callers just fall
    // back to the message's own stored data (see enrichMessages).
    private readonly groupRoomRepo?: GroupRoomRepository,
    private readonly groupMemberRepo?: GroupMemberRepository,
    private readonly groupInviteLinkRepo?: GroupInviteLinkRepository
  ) {}

  async sendMessage(params: {
    roomId: string;
    senderId: string;
    receiverId: string;
    content: {
      text: string;
      urls?: string[];
      files?: Array<Record<string, unknown>>;
    };
    messageType: string;
    parentMessageId?: string | null;
    clientMessageId?: string | null;
    /** Client compose time (epoch ms) — display only; never overwrites serverTs. */
    clientTs?: number | null;
  }): Promise<PrivateMessage> {
    // Defensive caps (the gRPC/socket send path doesn't run the Zod validators).
    if ((params.content?.text?.length ?? 0) > CHAT_TEXT_MAX_CHARS) {
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    }
    assertAttachmentsValid(params.messageType, params.content?.files);

    const [friends, blocked] = await Promise.all([
      this.userServiceClient.checkFriendship(
        params.senderId,
        params.receiverId
      ),
      this.userServiceClient.isFriendshipBlocked(
        params.senderId,
        params.receiverId
      ),
    ]);
    if (blocked) {
      throw new ForbiddenError("CHAT_BLOCKED");
    }
    if (!friends) {
      throw new ForbiddenError("CHAT_FRIENDSHIP_REQUIRED");
    }

    // Idempotency: if clientMessageId provided, check for existing message (album
    // batch includes `base:N` sibling rows).
    if (params.clientMessageId) {
      const existing = await this.messageRepo.findByClientMessageId(
        params.roomId,
        params.senderId,
        params.clientMessageId
      );
      if (existing) {
        const batch = await this.messageRepo.findAlbumBatchByClientMessageId(
          params.roomId,
          params.senderId,
          params.clientMessageId
        );
        const messages = (batch?.length ?? 0) > 0 ? batch : [existing];
        return markAlbumIdempotentReplay(
          messages[messages.length - 1]!,
          messages
        );
      }
    }

    const parts = splitDirectMediaAlbum(
      params.messageType,
      params.content,
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
        const originSenderId = originalMsg.senderId || "";
        const snapshots = await this.userSnapshotService.getUserSnapshotsMap(
          [originSenderId],
          this.cacheRepo
        );
        const senderSnap =
          (snapshots.get(originSenderId) as Record<string, unknown>) || {};
        // Album sends are split one-row-per-file (lib/split-media-album.ts),
        // so the parent row's own content.files can never reveal the true
        // album size — look up its sibling batch for IMAGE/VIDEO parents.
        const attachmentCountOverride = ["IMAGE", "VIDEO"].includes(
          normalizeMessageType(originalMsg.messageType)
        )
          ? await resolveReplyAttachmentCount(
              this.messageRepo,
              params.roomId,
              originSenderId,
              originalMsg
            )
          : undefined;
        quoteData = buildReplyQuoteSnapshot({
          messageId: originalMsg.id,
          senderId: originSenderId,
          senderName:
            (senderSnap.displayName as string) ||
            (senderSnap.memberId as string) ||
            "",
          messageType: originalMsg.messageType,
          content: originalMsg.content,
          isDeleted: Boolean(originalMsg.isDeleted),
          attachmentCountOverride,
        });
      }
    }

    // One round trip for three answers: the first row's sequence number, the
    // room's auto-delete settings, and the pre-send `lastMessageAt` that tells
    // us whether this is the conversation's first message. Reading the room
    // separately for each of those tripled the remote Mongo hops per send.
    //
    // Auto-delete: which timer THIS message gets is decided once, here, from the
    // room's per-user settings (see lib/auto-delete.ts). Resolved before the
    // insert loop so every album row of one send shares the same deadline.
    const firstAllocation = await allocateRoomSlot(params.roomId, (id, count) =>
      this.roomRepo.allocateSequenceBlock(id, count)
    );
    const roomBefore = firstAllocation.room;
    const autoDelete = this.autoDeleteStampFromRoom(roomBefore);

    const created: PrivateMessage[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const entity: Record<string, unknown> = {
        autoDeleteAt: autoDelete.autoDeleteAt,
        autoDeleteAfterView: autoDelete.autoDeleteAfterView,
        roomId: params.roomId,
        senderId: params.senderId,
        receiverId: params.receiverId,
        content: part.content,
        messageType: normalizeMessageType(part.messageType),
        parentMessageId: resolvedParentId,
        clientMessageId: part.clientMessageId ?? null,
        ...(i === 0 && params.clientTs
          ? { clientInfo: { clientTs: params.clientTs } }
          : {}),
        ...(i === 0 && quoteData ? { quoteData } : {}),
      };

      if (i === 0) {
        entity.sequenceNumber = firstAllocation.sequenceNumber;
        entity.revision = firstAllocation.revision;
      } else {
        const next = await allocateRoomSlot(params.roomId, (id, count) =>
          this.roomRepo.allocateSequenceBlock(id, count)
        );
        entity.sequenceNumber = next.sequenceNumber;
        entity.revision = next.revision;
      }

      try {
        const row = await this.messageRepo.createMessage(
          entity as Parameters<PrivateMessageRepository["createMessage"]>[0]
        );
        created.push(row);
      } catch (err) {
        if (part.clientMessageId && isDuplicateKeyError(err)) {
          const dup = await this.messageRepo.findByClientMessageId(
            params.roomId,
            params.senderId,
            part.clientMessageId
          );
          if (dup) {
            const batch =
              params.clientMessageId && i === 0
                ? await this.messageRepo.findAlbumBatchByClientMessageId(
                    params.roomId,
                    params.senderId,
                    params.clientMessageId
                  )
                : [];
            const messages = (batch?.length ?? 0) > 0 ? batch : [dup];
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
    const unreadIncrement = created.filter((m) =>
      shouldCountInUnread({
        messageType: m.messageType,
        systemEvent: m.systemEvent,
        explicit: (m as unknown as { countInUnread?: boolean | null })
          .countInUnread,
      })
    ).length;

    // The room row is pre-provisioned (empty, no lastMessageAt) as soon as two
    // users become friends (see PrivateRoomService.getOrCreateRoom), so THIS is
    // the actual "conversation just became visible" moment for both clients —
    // not room creation, which already fired its own `conv:created` too early
    // (before either client's friend-suggestion/inbox UI had anything to react
    // to). Snapshot the pre-update state so we can tell the very first message
    // apart from every later one.
    const isFirstMessage = !roomBefore?.lastMessageAt;

    // Update room with last message; unread += one per persisted row.
    // MUST await before the caller publishes conv:updated / chat:unread_summary —
    // a fire-and-forget race left the nav badge reading a STALE sum (list +1,
    // summary still old → private/group badge mismatch).
    try {
      await this.roomRepo.updateRoomOnNewMessage({
        roomId: params.roomId,
        message: {
          _id: message.id,
          content: message.content,
          senderId: message.senderId || "",
          messageType: message.messageType,
          systemEvent: message.systemEvent,
          systemData: message.systemData,
          createdAt: message.createdAt,
          clientMessageId: message.clientMessageId,
          sequenceNumber: message.sequenceNumber,
          revision: message.revision,
        },
        receiverId: params.receiverId,
        unreadIncrement,
      });
      if (isFirstMessage && this.redis) {
        // Tell both participants a real conversation now exists — lets the
        // frontend drop the "friend suggestion" placeholder and insert the
        // room into the conversation list without a manual refresh.
        const payload = JSON.stringify({
          event: "conv:created",
          data: {
            roomId: params.roomId,
            participants: [params.senderId, params.receiverId],
          },
        });
        this.redis.publish(`user:${params.senderId}`, payload).catch(() => {});
        this.redis
          .publish(`user:${params.receiverId}`, payload)
          .catch(() => {});
      }
    } catch (err: unknown) {
      logger.warn(`PrivateMessageService|updateRoom failed: ${String(err)}`);
    }

    // Presence-aware delivery: if the peer has ANY authenticated socket right
    // now, the message is DELIVERED the moment it's persisted (Telegram/WhatsApp
    // parity: ✓✓ means "the recipient device holds it", not "the recipient
    // opened the chat"). Fire-and-forget so the send path returns promptly.
    void this.markDeliveredForOnlinePeer({
      roomId: params.roomId,
      peerId: params.receiverId,
      senderId: params.senderId,
      messages: created,
    });

    return attachAlbumMessages(message, created);
  }

  /**
   * The OTHER participant in a private room, given either side's own id.
   * Mirrors the peer-resolution `getPeerReadSeq` already does inline — pulled
   * out as a public helper so gRPC handlers (markDelivered) can resolve "who
   * needs to know" without duplicating the room lookup.
   */
  async getPeerId(roomId: string, userId: string): Promise<string | null> {
    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room) return null;
    return (room.participants ?? []).find((id) => id !== userId) ?? null;
  }

  /**
   * Persist deliveredTo + publish `message:delivered` for a peer we already
   * know (or just discovered) is online. Idempotent under retries — callers
   * that resubmit an already-delivered messageId simply produce a no-op event
   * because `markDeliveredUpTo` filters candidates by `senderId != recipient`
   * and skips docs where the entry already exists.
   */
  private async markDeliveredForOnlinePeer(params: {
    roomId: string;
    peerId: string;
    senderId: string;
    messages: PrivateMessage[];
  }): Promise<void> {
    if (!this.presenceService || !this.redis || params.messages.length === 0)
      return;
    try {
      const isOnline = await this.presenceService.getIsOnline(params.peerId);
      if (!isOnline) return;
      const last = params.messages[params.messages.length - 1]!;
      const { count, messageIds } = await this.messageRepo.markDeliveredUpTo(
        params.roomId,
        params.peerId,
        last.id
      );
      if (count === 0) return;
      const payload = JSON.stringify({
        event: "message:delivered",
        data: {
          conversationId: params.roomId,
          recipientId: params.peerId,
          upToMessageId: last.id,
          messageIds,
        },
      });
      await this.redis.publish(`conv:${params.roomId}`, payload);
      // ALSO direct to the sender's own `user:<id>` channel — see the identical
      // comment on service-impl.ts's markMessagesRead. Guarantees the sender's
      // conversation-list row updates even if their sidebar socket hasn't (yet)
      // joined this specific `conv:<roomId>` room.
      void this.redis
        .publish(`user:${params.senderId}`, payload)
        .catch((e: unknown) =>
          logger.warn(
            `PrivateMessageService|markDeliveredForOnlinePeer direct publish failed sender=${params.senderId}: ${String(e)}`
          )
        );
    } catch (err) {
      logger.warn(
        `PrivateMessageService|markDeliveredForOnlinePeer failed roomId=${params.roomId} peer=${params.peerId}: ${String(err)}`
      );
    }
  }

  /**
   * Presence-connect backfill entry point — called by PresenceService when a
   * user transitions offline→online. Walks every private room the user is a
   * participant in and marks their pending inbox as delivered (single Mongo
   * update per room, capped batch inside `markDeliveredUpTo`). Publishes one
   * `message:delivered` per room so every sender's tick catches up live.
   *
   * Safe on cold rooms (no unread messages) — `markDeliveredUpTo` returns
   * count:0 and nothing is published.
   */
  async backfillDeliveredOnPresenceConnect(userId: string): Promise<void> {
    if (!this.redis) return;
    let rooms: Array<{
      roomId: string;
      lastMessageId: string | null;
      participants: string[];
    }>;
    try {
      rooms = await this.roomRepo.findParticipatingRoomHeads(userId);
    } catch (err) {
      logger.warn(
        `PrivateMessageService|backfill|findParticipatingRoomHeads failed userId=${userId}: ${String(err)}`
      );
      return;
    }
    for (const room of rooms) {
      if (!room.lastMessageId) continue;
      try {
        const { count, messageIds } = await this.messageRepo.markDeliveredUpTo(
          room.roomId,
          userId,
          room.lastMessageId
        );
        if (count === 0) continue;
        const payload = JSON.stringify({
          event: "message:delivered",
          data: {
            conversationId: room.roomId,
            recipientId: userId,
            upToMessageId: room.lastMessageId,
            messageIds,
          },
        });
        await this.redis.publish(`conv:${room.roomId}`, payload);
        const senderId = room.participants.find((id) => id !== userId);
        if (senderId) {
          await this.redis
            .publish(`user:${senderId}`, payload)
            .catch((e: unknown) =>
              logger.warn(
                `PrivateMessageService|backfill direct publish failed sender=${senderId}: ${String(e)}`
              )
            );
        }
      } catch (err) {
        logger.warn(
          `PrivateMessageService|backfill|room=${room.roomId} userId=${userId}: ${String(err)}`
        );
      }
    }
  }

  async getMessages(params: {
    roomId: string;
    userId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<PrivateMessage[]> {
    const room = await assertPrivateParticipant(
      this.roomRepo,
      params.roomId,
      params.userId
    );

    const beforeTimestamp = params.cursor || new Date().toISOString();
    return this.messageRepo.findByRoomIdWithTime(
      params.userId,
      { roomId: room.roomId },
      beforeTimestamp,
      params.limit,
      getPrivateDeletionCutoff(room, params.userId)
    );
  }

  /**
   * Timestamp-paginated message page (before_ts / after_ts). Over-fetches one
   * extra row in the repo so `hasMore` is exact; `nextCursor` is the boundary
   * message's createdAt as epoch-ms (feed back as the next before_ts/after_ts).
   */
  async getMessagesTimeline(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    ts: Date;
    /** Keyset tiebreaker parsed from a compound before_ts/after_ts ("<ms>_<id>"). */
    boundaryId?: string | null;
    /** True for the first page (no cursor) so the boundary message is included. */
    inclusive?: boolean;
    limit: number;
  }): Promise<{
    items: PrivateMessage[];
    hasMore: boolean;
    nextCursor: string | null;
    total: number;
    cursors: AroundCursors;
    roomRevision: number;
  }> {
    const room = await assertPrivateParticipant(
      this.roomRepo,
      params.roomId,
      params.userId
    );
    const cutoff = getPrivateDeletionCutoff(room, params.userId);

    const [{ messages: items, hasMore }, total, roomRevision] =
      await Promise.all([
        this.messageRepo.findByRoomIdTimeline({
          userId: params.userId,
          roomId: room.roomId,
          direction: params.direction,
          ts: params.ts,
          boundaryId: params.boundaryId ?? null,
          inclusive: params.inclusive ?? false,
          limit: params.limit,
          cutoff,
        }),
        this.messageRepo.countTimeline({
          roomId: room.roomId,
          userId: params.userId,
          cutoff,
        }),
        this.roomRepo.getRoomRevision(room.roomId),
      ]);

    const cursors = await this.seqPageCursors(
      items,
      room.roomId,
      params.userId,
      cutoff
    );

    // The repo returns the page in DB order (before → newest-first, after →
    // oldest-first); the boundary for the next page is the LAST row either way.
    // nextCursor is a COMPOUND "<createdAtMs>_<id>" keyset cursor — the _id
    // tiebreaker is what keeps same-millisecond messages reachable. The client
    // feeds it back verbatim as the next before_ts/after_ts.
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last ? `${last.createdAt.getTime()}_${last.id}` : null;

    return { items, hasMore, nextCursor, total, cursors, roomRevision };
  }

  /**
   * Bidirectional continuation for any page — probes one visible row strictly
   * beyond each seq edge through the same keyset query the page itself used.
   */
  private seqPageCursors(
    page: PrivateMessage[],
    roomId: string,
    userId: string,
    cutoff: Date | undefined
  ): Promise<AroundCursors> {
    return computeSeqPageCursors(page, (direction, seq) =>
      this.messageRepo.findByRoomIdSeq({
        userId,
        roomId,
        direction,
        seq,
        limit: 1,
        cutoff,
      })
    );
  }

  /**
   * V2 §3.2: seq-keyset page. `nextCursor` is the boundary `sequenceNumber`
   * (feed back as before_seq when paging older, after_seq when paging newer).
   */
  async getMessagesSeq(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    /** null = newest page. */
    seq: number | null;
    limit: number;
  }): Promise<{
    items: PrivateMessage[];
    hasMore: boolean;
    nextCursor: string | null;
    cursors: AroundCursors;
    roomRevision: number;
  }> {
    const room = await assertPrivateParticipant(
      this.roomRepo,
      params.roomId,
      params.userId
    );
    const cutoff = getPrivateDeletionCutoff(room, params.userId);

    const [rows, roomRevision] = await Promise.all([
      this.messageRepo.findByRoomIdSeq({
        userId: params.userId,
        roomId: room.roomId,
        direction: params.direction,
        seq: params.seq,
        limit: params.limit,
        cutoff,
      }),
      this.roomRepo.getRoomRevision(room.roomId),
    ]);
    const hasMore = rows.length > params.limit;
    const items = rows.slice(0, params.limit);
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? String(last.sequenceNumber) : null;
    const cursors = await this.seqPageCursors(
      items,
      room.roomId,
      params.userId,
      cutoff
    );
    return { items, hasMore, nextCursor, cursors, roomRevision };
  }

  /** Raw message lookup — the path-param react route resolves its room from the message. */
  findMessageById(messageId: string): Promise<PrivateMessage | null> {
    return this.messageRepo.findById(messageId);
  }

  /**
   * V2 §3.2: jump-to-message window centered on a message id (reply-tap, search
   * navigation). Resolves the anchor's sequenceNumber, then fetches the window.
   */
  async getMessagesAround(params: {
    roomId: string;
    userId: string;
    messageId: string;
    limit: number;
  }): Promise<{ items: PrivateMessage[]; anchorSeq: number } & AroundCursors> {
    const room = await assertPrivateParticipant(
      this.roomRepo,
      params.roomId,
      params.userId
    );
    const anchor = await this.messageRepo.findById(params.messageId);
    if (!anchor) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    const cutoff = getPrivateDeletionCutoff(room, params.userId);
    const items = await this.messageRepo.findAroundSeq({
      userId: params.userId,
      roomId: room.roomId,
      anchorSeq: anchor.sequenceNumber,
      limit: params.limit,
      cutoff,
    });
    // Bidirectional continuation: probe one row strictly beyond each window edge
    // (reusing the seq keyset paging query), so the client can page up AND down.
    const cursors = await computeSeqAroundCursors(items, (direction, seq) =>
      this.messageRepo.findByRoomIdSeq({
        userId: params.userId,
        roomId: room.roomId,
        direction,
        seq,
        limit: 1,
        cutoff,
      })
    );
    return { items, anchorSeq: anchor.sequenceNumber, ...cursors };
  }

  async searchMessages(params: {
    roomId: string;
    userId: string;
    query: string;
    limit: number;
    cursor?: string | null;
  }): Promise<{
    messages: PrivateMessage[];
    scores: Map<string, number>;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const room = await assertPrivateParticipant(
      this.roomRepo,
      params.roomId,
      params.userId
    );
    return this.messageRepo.searchByText({
      roomId: params.roomId,
      query: params.query,
      limit: params.limit,
      userId: params.userId,
      cursor: params.cursor,
      cutoff: getPrivateDeletionCutoff(room, params.userId),
    });
  }

  async listMedia(params: {
    roomId: string;
    userId: string;
    type?: string;
    cursor?: string | null;
    limit: number;
  }): Promise<PrivateMessage[]> {
    // Enforce participation first.
    const room = await this.roomRepo.findByRoomId(params.roomId, {
      projection: { roomId: 1, participants: 1 },
    });
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    if (!room.participants?.includes(params.userId))
      throw new ForbiddenError("CHAT_NOT_PARTICIPANT");

    return this.messageRepo.listMedia({
      roomId: room.roomId,
      userId: params.userId,
      type: params.type,
      cursor: params.cursor,
      limit: params.limit,
      cutoff: getPrivateDeletionCutoff(room, params.userId),
    });
  }

  /**
   * The auto-delete columns a new message in `roomId` must carry: THE
   * conversation's timer, which both participants share (see lib/auto-delete.ts).
   * Read from the room row the caller already loaded, so a setting changed a
   * moment ago is in force for the very next send — there is no cached copy to
   * go stale. Fails OPEN — a lookup error must never block a send, it just
   * means no timer on that message.
   */
  private autoDeleteStampFromRoom(room: {
    autoDelete?: unknown;
    autoDeleteBy?: unknown;
    roomId?: string;
  }): AutoDeleteStamp {
    try {
      return computeAutoDeleteStamp(readRoomAutoDelete(room), new Date());
    } catch (err) {
      logger.warn(
        `PrivateMessageService|autoDeleteStampFromRoom failed room=${room.roomId}: ${String(err)}`
      );
      return AUTO_DELETE_NONE;
    }
  }

  /**
   * Auto-delete "After Viewing": start the countdown on every such message this
   * reader RECEIVED in this room (§3.4 — the deadline only exists once the
   * recipient has actually seen it; §8.7 — never before the receipt lands).
   * Idempotent, so every mark-read can call it unconditionally. Returns the
   * number of messages armed.
   */
  async armAfterViewingMessages(
    roomId: string,
    readerId: string
  ): Promise<number> {
    return this.messageRepo.armAfterViewing(
      roomId,
      readerId,
      new Date(Date.now() + AUTO_DELETE_AFTER_VIEW_GRACE_SEC * 1000)
    );
  }

  async markRead(params: {
    roomId: string;
    userId: string;
    lastMessageId: string;
  }): Promise<unknown> {
    // Auto-delete "After Viewing" arms HERE — the single point every read path
    // (REST via the orchestrator, socket/gRPC via markMessagesRead) funnels
    // through — so no caller can forget it. Fire-and-forget: the sweeper still
    // owns the deletion, a failure here only delays it to the next read.
    void this.armAfterViewingMessages(params.roomId, params.userId).catch(
      (err: unknown) => {
        logger.warn(
          `PrivateMessageService|armAfterViewingMessages failed room=${params.roomId}: ${String(err)}`
        );
      }
    );
    return this.roomRepo.markReadUpTo({
      roomId: params.roomId,
      userId: params.userId,
      upToMessageId: params.lastMessageId,
    });
  }

  /**
   * Resolve a message's per-room `sequenceNumber` from its id (O(1) indexed PK
   * lookup). Used by the read_sync fan-out to publish a `read_to_seq` high-water
   * mark to the reader's other devices. Returns 0 if the message is missing.
   */
  async getMessageSequence(messageId: string): Promise<number> {
    if (!messageId) return 0;
    const msg = await this.messageRepo.findById(messageId);
    const seq = (msg as { sequenceNumber?: number } | null)?.sequenceNumber;
    return typeof seq === "number" ? seq : 0;
  }

  /** Absolute per-user unread for a private room — used on conv:updated. */
  async getUnreadCountsByUser(roomId: string): Promise<Record<string, number>> {
    const room = await this.roomRepo.findByRoomId(roomId).catch(() => null);
    const map = (room?.unreadCountByUser ?? {}) as Record<string, number>;
    return { ...map };
  }

  /**
   * The PEER's (other participant's) current read high-water mark, as a
   * sequenceNumber. Used to hydrate each of MY OWN messages' "seen"/"delivered"
   * tick on the INITIAL page load/refresh/reconnect — without this, every tick
   * resets to "sent" until a live `message:read` arrives, because per-message
   * read state isn't otherwise persisted on the wire (see `PrivateMessage.readBy`,
   * which is dead/never populated — this cursor is the real source of truth).
   * Returns 0 if the room/peer/read-pointer can't be resolved.
   */
  async getPeerReadSeq(roomId: string, userId: string): Promise<number> {
    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room) return 0;
    const peerId = (room.participants ?? []).find((id) => id !== userId);
    if (!peerId) return 0;
    const lastReadMessageIdByUser = (room.lastReadMessageIdByUser ??
      {}) as Record<string, string>;
    const peerReadMessageId = lastReadMessageIdByUser[peerId];
    if (!peerReadMessageId) return 0;
    return this.getMessageSequence(peerReadMessageId);
  }

  /**
   * The high-water mark for messages the peer has been marked delivered on,
   * as a `sequenceNumber`. Mirrors `getPeerReadSeq` — used to hydrate the
   * DELIVERED (✓✓, not blue) tick on the initial page load, so a refresh
   * while the peer is online-but-hasn't-opened-the-chat correctly shows
   * double ticks instead of resetting to single. Derived from the sender-
   * indexed newest message the peer appears in `deliveredTo` on — one indexed
   * query, bounded to the room's own messages.
   */
  async getPeerDeliveredSeq(roomId: string, userId: string): Promise<number> {
    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room) return 0;
    const peerId = (room.participants ?? []).find((id) => id !== userId);
    if (!peerId) return 0;
    return this.messageRepo.getNewestDeliveredSeq(roomId, userId, peerId);
  }

  async deleteForMe(
    messageId: string,
    userId: string
  ): Promise<PrivateMessage> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // The route carries no roomId. Derive the room from the message and authorize
    // the caller as a participant of THAT room BEFORE any mutation — otherwise any
    // authed user could delete-for-me a message in a DM they're not in (IDOR).
    await this.assertCallerInMessageRoom(message, userId);
    // isDeleted=true means already deleted for everyone — can't delete for me again
    if (message.isDeleted)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    // Check if this user already deleted it for themselves
    const deletedFor = (message.deletedFor ?? {}) as Record<string, unknown>;
    if (userId in deletedFor)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    return this.messageRepo.deleteForMe(messageId, userId);
  }

  /**
   * After a delete-for-everyone, if the deleted message was the room's current
   * last message, finds the previous visible message and updates the room preview.
   * Returns data for the conv:updated broadcast, or null when the deleted message
   * was not the last (no-op).
   */
  async recalculateLastMessageAfterDelete(
    roomId: string,
    deletedMessageId: string
  ): Promise<{
    prevMessageId: string | null;
    messageType: string;
    content: unknown;
    senderId: string;
    createdAt: Date;
    hasLastMessage: boolean;
    /** Offline-first list identity of the new previous-visible last message. */
    clientMessageId: string | null;
    sequenceNumber: number;
    revision: number;
  } | null> {
    const [room, prev] = await Promise.all([
      this.roomRepo.findByRoomId(roomId),
      this.messageRepo.findPreviousVisible(roomId),
    ]);
    if (!room) return null;
    if (
      room.lastMessageId !== deletedMessageId &&
      room.lastMessageId === (prev?.id ?? null)
    ) {
      return null;
    }
    if (prev) {
      await this.roomRepo.setLastMessage(roomId, {
        id: prev.id,
        senderId: prev.senderId ?? "",
        content: prev.content,
        messageType: prev.messageType,
        createdAt: prev.createdAt,
        clientMessageId: prev.clientMessageId,
        sequenceNumber: prev.sequenceNumber,
        revision: prev.revision,
      });
      return {
        prevMessageId: prev.id,
        messageType: prev.messageType,
        content: prev.content,
        senderId: prev.senderId ?? "",
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
      messageType: "",
      content: null,
      senderId: "",
      createdAt: new Date(0),
      hasLastMessage: false,
      clientMessageId: null,
      sequenceNumber: 0,
      revision: 0,
    };
  }

  /**
   * After a delete-for-me on the last message, finds the previous message
   * visible to that specific user (skipping both globally-deleted and
   * personally-deleted messages). Returns data for a targeted conv:updated
   * broadcast to that user only, or null when the deleted message was not the
   * room's current last (no-op).
   * Does NOT update the shared room snapshot — the other participant's view is
   * unchanged.
   */
  /**
   * Per-recipient list-preview overrides for a delete-for-everyone fan-out: the
   * participant who has personally hidden `sharedPrevMessageId` gets their own
   * visible preview instead of the shared one. Empty map in the common case.
   */
  async resolveForEveryoneOverrides(
    roomId: string,
    sharedPrevMessageId: string | null,
    recipientIds: string[]
  ): Promise<Map<string, RecipientOverride | null>> {
    return resolveForEveryoneOverrides(
      privateVisibilitySource(this.messageRepo),
      roomId,
      sharedPrevMessageId,
      recipientIds
    );
  }

  async recalculateLastMessageAfterDeleteForMe(
    roomId: string,
    deletedMessageCreatedAt: Date,
    userId: string
  ): Promise<{
    prevMessageId: string | null;
    messageType: string;
    content: unknown;
    senderId: string;
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
    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room) return null;
    // No early-return on lastMessageId check: the deleted message may not be
    // the globally-last but could still be the user's effective last visible.
    const prev = await this.messageRepo.findPreviousVisibleForUser(
      roomId,
      userId,
      getPrivateDeletionCutoff(room, userId)
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
        messageType: prev.messageType,
        content: prev.content,
        senderId: prev.senderId ?? "",
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
      messageType: "",
      content: null,
      senderId: "",
      createdAt: new Date(0),
      hasLastMessage: false,
      wasEffectiveLast: true,
      clientMessageId: null,
      sequenceNumber: 0,
      revision: 0,
    };
  }

  async deleteForEveryone(
    messageId: string,
    userId: string
  ): Promise<PrivateMessage> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // Bind message↔room BEFORE the sender check: a user not in (or removed from)
    // the room can't mutate even their own old message. NotFound so existence
    // isn't leaked; keeps the room-bind uniform across all private writes.
    await this.assertCallerInMessageRoom(message, userId);
    if (message.isDeleted)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (message.senderId !== userId) {
      throw new BadRequestError("CHAT_DELETE_OWN_MESSAGES_ONLY");
    }
    const deleted = await this.messageRepo.deleteForEveryone(
      messageId,
      message.roomId,
      userId
    );
    if (
      shouldCountInUnread({
        messageType: message.messageType,
        systemEvent: message.systemEvent,
        explicit: (message as unknown as { countInUnread?: boolean | null })
          .countInUnread,
      }) &&
      message.receiverId
    ) {
      this.roomRepo
        .decrementUnreadForMessage({
          roomId: message.roomId,
          recipientId: message.receiverId,
          messageId: message.id,
          messageCreatedAt: message.createdAt,
        })
        .catch((err: unknown) => {
          logger.warn(
            `PrivateMessageService|decrementUnreadForMessage failed: ${String(err)}`
          );
        });
    }
    // Best-effort: flip `quoteData.isDeleted` on every existing reply to this
    // message so "Message deleted" shows up everywhere, not just for replies
    // sent after this delete.
    this.messageRepo
      .refreshReplyQuotes(messageId, { isDeleted: true })
      .catch((err: unknown) => {
        logger.warn(
          `PrivateMessageService|refreshReplyQuotes(delete) failed: ${String(err)}`
        );
      });
    return deleted;
  }

  async editMessage(params: {
    messageId: string;
    userId: string;
    content: {
      text: string;
      urls?: string[];
      files?: Array<Record<string, unknown>>;
    };
  }): Promise<PrivateMessage> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // Bind message↔room BEFORE the sender check: a user not in (or removed from)
    // the room can't mutate even their own old message. NotFound so existence
    // isn't leaked; keeps the room-bind uniform across all private writes.
    await this.assertCallerInMessageRoom(message, params.userId);
    if (message.isDeleted)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (message.senderId !== params.userId)
      throw new BadRequestError("CHAT_EDIT_OWN_MESSAGES_ONLY");
    if (message.messageType !== "TEXT")
      throw new BadRequestError("CHAT_EDIT_TEXT_ONLY");
    if ((params.content?.text?.length ?? 0) > CHAT_TEXT_MAX_CHARS)
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    if (Date.now() - message.createdAt.getTime() > CHAT_EDIT_WINDOW_MS)
      throw new GoneError("CHAT_EDIT_WINDOW_EXPIRED");
    const updated = await this.messageRepo.editMessage(
      params.messageId,
      message.roomId,
      params.content
    );
    // Best-effort: keep every existing reply's `quoteData.preview` in sync with
    // the new text (edits are TEXT-only, so preview === the new text verbatim).
    this.messageRepo
      .refreshReplyQuotes(params.messageId, {
        preview: buildReplyPreviewText("TEXT", params.content, 0),
      })
      .catch((err: unknown) => {
        logger.warn(
          `PrivateMessageService|refreshReplyQuotes(edit) failed: ${String(err)}`
        );
      });
    return updated;
  }

  async markDelivered(params: {
    roomId: string;
    recipientId: string;
    upToMessageId: string;
  }): Promise<{ count: number; messageIds: string[] }> {
    return this.messageRepo.markDeliveredUpTo(
      params.roomId,
      params.recipientId,
      params.upToMessageId
    );
  }

  /**
   * Report a MESSAGE (not its sender). The reported target is the message; the
   * sender rides along as `reportedUserId` so a moderator can act on the person
   * without the message identity being thrown away. This used to publish
   * `type: "user"` with the sender as `targetId`, which collapsed every private
   * message report into a plain user report the moment it left this service —
   * the messageId never reached admin_db.
   *
   * Nothing here trusts the client beyond the messageId: the room, the sender
   * and the reporter's access are all resolved from the stored message.
   * `roomId`, when supplied, must MATCH the message's own room — a client
   * cannot report a message while naming a different conversation.
   */
  async reportMessage(params: {
    messageId: string;
    reporterId: string;
    reason: string;
    description?: string;
    /** Conversation the client believes the message belongs to (optional). */
    roomId?: string;
  }): Promise<PrivateMessageReport> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    if (params.roomId && params.roomId !== message.roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const room = await this.roomRepo.findByRoomId(message.roomId);
    if (!room || !room.participants?.includes(params.reporterId))
      throw new ForbiddenError("CHAT_REPORT_NOT_PARTICIPANT");

    if (message.senderId === params.reporterId)
      throw new BadRequestError("CHAT_REPORT_OWN_MESSAGE");

    try {
      const report = await this.reportRepo.create({
        roomId: message.roomId,
        messageId: message.id,
        reporterId: params.reporterId,
        reportedUserId: message.senderId ?? "",
        reason: params.reason,
        description: params.description ?? "",
      });
      publishAdminReportIngestSafe({
        type: "message",
        targetId: message.id,
        reporterId: params.reporterId,
        reason: params.reason,
        details: params.description?.trim() ? params.description.trim() : null,
        // Private (1-to-1) messages are never community-scoped.
        communityId: null,
        reportedUserId: message.senderId ?? null,
        roomId: message.roomId,
        roomType: "PRIVATE",
        eventAt: new Date().toISOString(),
        sourceReportId: report.id,
      });
      return report;
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        throw new BadRequestError("CHAT_ALREADY_REPORTED");
      }
      throw err;
    }
  }

  /**
   * Compare-and-swap toggle core, shared by `react()` and `reactToMessage()`.
   * Flips `userId`'s membership in the `emoji` bucket (add on first react,
   * remove on a duplicate react = toggle-off; one reaction per user via the
   * shared `toggleStoredReaction`, same as community/group). `revision` is
   * bumped on every content change to this message, so matching it in the
   * write's WHERE clause turns the write into a CAS — closes the concurrent-
   * request lost-update race on the non-atomic reactions read-modify-write.
   * Mirrors CommunityMessageService.reactToMessage's retry loop.
   */
  private async reactCas(
    messageId: string,
    userId: string,
    emoji: string
  ): Promise<{ message: PrivateMessage; added: boolean }> {
    const MAX_ATTEMPTS = 5;
    let message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    let added = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const refetched = await this.messageRepo.findById(messageId);
        if (!refetched) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
        message = refetched;
      }
      const wasReactedByUser = (
        reactionUserIdMap(message.reactions)[emoji] ?? []
      ).includes(userId);
      added = !wasReactedByUser;
      const updated = toggleStoredReaction(message.reactions, userId, emoji);
      const applied = await this.messageRepo.updateReactionsCas(
        messageId,
        message.roomId,
        updated,
        message.revision
      );
      if (applied) break;
      if (attempt === MAX_ATTEMPTS - 1)
        throw new ConflictError("CHAT_REACTION_CONFLICT");
    }
    const after = await this.messageRepo.findById(messageId);
    return { message: after ?? message, added };
  }

  /**
   * Toggle a single user's emoji reaction on a private message. Persists the
   * canonical `{ emoji: [{ userId, userName, avatar, memberId }] }` shape.
   * Other emojis are preserved. CAS-safe (see `reactCas`).
   */
  async react(
    messageId: string,
    userId: string,
    emoji: string
  ): Promise<PrivateMessage | null> {
    const { message } = await this.reactCas(messageId, userId, emoji);
    return message;
  }

  /**
   * Same toggle as `react()`, additionally returning the WhatsApp-style
   * lastActivity metadata (added vs removed, the message owner, and the
   * reacted-to message's own preview text) needed to bump/revert the
   * conversation list — mirrors CommunityMessageService.reactToMessage.
   */
  async reactToMessage(params: {
    messageId: string;
    userId: string;
    emoji: string;
  }): Promise<{
    roomId: string;
    added: boolean;
    targetUserId: string;
    targetMessagePreview: string;
  }> {
    const { message, added } = await this.reactCas(
      params.messageId,
      params.userId,
      params.emoji
    );
    return {
      roomId: message.roomId,
      added,
      targetUserId: message.senderId ?? "",
      targetMessagePreview: buildReactionTargetPreview(
        normalizeMessageType(message.messageType),
        message.content
      ),
    };
  }

  /**
   * Single-reaction SET: `userId` ends up with exactly `emoji` (or none, if that was already their
   * reaction). One write instead of the remove-then-add pair, so clients never observe the
   * intermediate no-reaction state. Un-guarded like {@link react} — callers authorize.
   */
  async setReaction(
    messageId: string,
    userId: string,
    emoji: string
  ): Promise<PrivateMessage | null> {
    const raw = await this.messageRepo.getReactions(messageId);
    if (raw === null) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    const updated = setStoredReaction(raw.reactions, userId, emoji);
    return this.messageRepo.addReactions(messageId, raw.roomId, updated);
  }

  /** {@link setReaction} in {@link reactToMessage}'s return shape, for the REST orchestrator. */
  async setReactionDetailed(params: {
    messageId: string;
    userId: string;
    emoji: string;
  }): Promise<{
    roomId: string;
    added: boolean;
    targetUserId: string;
    targetMessagePreview: string;
  }> {
    const message = await this.setReaction(
      params.messageId,
      params.userId,
      params.emoji
    );
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    return {
      roomId: message.roomId,
      added: true,
      targetUserId: message.senderId ?? "",
      targetMessagePreview: buildReactionTargetPreview(
        normalizeMessageType(message.messageType),
        message.content
      ),
    };
  }

  /**
   * Authorize a REST react/remove-reaction: the caller MUST be a participant of
   * the private room. The shared `react()` primitive deliberately does NOT guard
   * (the socket/gRPC path is pre-authorized by room membership at join), so the
   * REST boundary enforces participation here — the same rule the read paths use.
   */
  async assertParticipant(roomId: string, userId: string): Promise<void> {
    await assertPrivateParticipant(this.roomRepo, roomId, userId);
  }

  /** The room's two participant userIds — the recipient list for `conv:updated` fan-out. */
  async getParticipants(roomId: string): Promise<string[]> {
    const room = await this.roomRepo.findByRoomId(roomId, {
      projection: { participants: 1 },
    });
    return room?.participants ?? [];
  }

  /** See GroupRoomRepository.setReactionActivity — identical overlay semantics. */
  async setReactionActivity(
    roomId: string,
    data: {
      messageId: string;
      emoji: string;
      actorId: string;
      actorPreview: string;
      targetId: string | null;
      targetPreview: string | null;
      reactedAt: Date;
    }
  ): Promise<void> {
    await this.roomRepo.setReactionActivity(roomId, data);
  }

  /** See GroupRoomRepository.clearReactionActivityIfCurrent — identical semantics. */
  async clearReactionActivityIfCurrent(
    roomId: string,
    identity: { messageId: string; emoji: string; actorId: string }
  ): Promise<void> {
    await this.roomRepo.clearReactionActivityIfCurrent(roomId, identity);
  }

  /**
   * The room's CURRENT canonical last message (never mutated by a reaction) —
   * used to revert a reaction-removal's live bump back to reality, since the
   * canonical lastMessage/lastMessageAt columns were never touched in the
   * first place (see reactionActivity* schema comment).
   */
  async getRoomBumpSnapshot(roomId: string): Promise<{
    lastMessageId: string | null;
    lastMessageAt: number;
    senderId: string;
    content: unknown;
    messageType: string;
  } | null> {
    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room?.lastMessage) return null;
    const lm = room.lastMessage as Record<string, unknown>;
    return {
      lastMessageId: room.lastMessageId ?? null,
      lastMessageAt: room.lastMessageAt?.getTime() ?? 0,
      senderId: (lm.senderId as string) ?? "",
      content: lm.content ?? null,
      messageType: (lm.messageType as string) ?? "TEXT",
    };
  }

  /** Deep-gap horizon: a `since_revision` more than this far below the room's current
   *  revision triggers a bounded re-baseline instead of replaying the full backlog.
   *  Same value and rule as community (`CommunityMessageService`). */
  private readonly REVISION_RESET_HORIZON = 10_000;

  /**
   * ZERO-LOSS CHANGES FEED (REST) — `GET /api/chat/private/rooms/:roomId/changes`.
   *
   * Every message whose room CHANGE `revision > sinceRevision`, current state, ordered
   * revision ASC — inserts AND mutations (edit/delete-for-everyone/reaction), regardless
   * of how old the message's `sequenceNumber` is. This is what `after_seq` cannot do.
   *
   * NOTE for clients: per-viewer filtering happens AFTER the page slice, so
   * `items.length < limit` while `hasMore === true` is legal. Drain on `hasMore`, never
   * on `items.length`.
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
    items: Awaited<ReturnType<PrivateMessageService["enrichMessages"]>>;
  }> {
    const room = await assertPrivateParticipant(
      this.roomRepo,
      params.roomId,
      params.userId
    );
    const changes = await this.resolveChanges({
      ...params,
      cutoff: getPrivateDeletionCutoff(room, params.userId),
    });
    const items = await this.enrichMessages(changes.messages, params.userId);

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
   * Shared core for the zero-loss changes feed — used by BOTH the REST `/changes`
   * endpoint and the socket `chat:catchup(sinceRevision)` path. Assumes access is
   * already asserted by the caller.
   */
  private async resolveChanges(params: {
    roomId: string;
    userId: string;
    sinceRevision: number;
    limit: number;
    cutoff?: Date;
  }): Promise<{
    roomRevision: number;
    resetRequired: boolean;
    hasMore: boolean;
    nextRevision: number | null;
    messages: PrivateMessage[];
  }> {
    const roomRevision = await this.roomRepo.getRoomRevision(params.roomId);

    // Deep gap ⇒ tell the client to drop local state and re-baseline from the newest page.
    // since=0 (cold start) is NEVER a reset — it drains from the beginning.
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
        cutoff: params.cutoff,
      });

    return {
      roomRevision,
      resetRequired: false,
      hasMore,
      nextRevision,
      messages,
    };
  }

  async getMessageContext(
    roomId: string,
    messageId: string,
    userId: string
  ): Promise<PrivateMessage> {
    const room = await assertPrivateParticipant(this.roomRepo, roomId, userId);
    const message = await this.messageRepo.findMessageMeta({
      roomId,
      messageId,
    });
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    if (message.isDeleted) {
      throw new GoneError("CHAT_MESSAGE_DELETED");
    }
    if (
      message.deletedFor &&
      (message.deletedFor as Record<string, boolean>)[userId]
    ) {
      throw new GoneError("CHAT_MESSAGE_DELETED");
    }
    const cutoff = getPrivateDeletionCutoff(room, userId);
    if (cutoff && message.createdAt <= cutoff) {
      throw new GoneError("CHAT_MESSAGE_DELETED");
    }
    return message;
  }

  /**
   * Bind a message to its room: throw CHAT_MESSAGE_NOT_FOUND unless `messageId`
   * actually belongs to `roomId`. The `react()` primitive mutates a message by id
   * ALONE, so a REST caller authorized for room A could otherwise pass a messageId
   * from room B (a DM they're not in) and mutate/broadcast that foreign message.
   * Querying by BOTH id + roomId (same `findMessageMeta` the pin path uses) closes
   * that cross-room IDOR; call this AFTER the participant guard, BEFORE react().
   */
  async assertMessageInRoom(roomId: string, messageId: string): Promise<void> {
    const msg = await this.messageRepo.findMessageMeta({ roomId, messageId });
    if (!msg) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
  }

  /** Bind a loaded message to a room the caller participates in (cross-room IDOR
   * guard for routes that carry no roomId). NotFound — never Forbidden — so a
   * foreign message's existence isn't leaked. */
  private async assertCallerInMessageRoom(
    message: PrivateMessage,
    userId: string
  ): Promise<void> {
    const room = await this.roomRepo.findByRoomId(message.roomId, {
      projection: { roomId: 1, participants: 1 },
    });
    if (!room?.participants?.includes(userId))
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
  }

  async countMessages(roomId: string): Promise<number> {
    return this.messageRepo.countByRoom(roomId);
  }

  async countSearchResults(
    roomId: string,
    query: string,
    userId: string
  ): Promise<number> {
    const room = await this.roomRepo.findByRoomId(roomId);
    return this.messageRepo.countSearchResults(
      roomId,
      query,
      userId,
      getPrivateDeletionCutoff(room, userId)
    );
  }

  async forwardMessage(params: {
    sourceMessageId: string;
    /** SOURCE room the message is being forwarded FROM (REST path param). When
     * provided, it must MATCH the message's actual room (cross-check). Null on the
     * gRPC path. Either way the caller must be a participant of the message's
     * ACTUAL room — that bind is unconditional and closes the forward read-IDOR. */
    sourceRoomId?: string | null;
    targetRoomId: string;
    senderId: string;
    receiverId: string;
    clientMessageId?: string | null;
  }): Promise<PrivateMessage> {
    // friendship gate
    const friends = await this.userServiceClient.checkFriendship(
      params.senderId,
      params.receiverId
    );
    if (!friends) throw new ForbiddenError("CHAT_FRIENDSHIP_REQUIRED");

    // idempotency
    if (params.clientMessageId) {
      const existing = await this.messageRepo.findByClientMessageId(
        params.targetRoomId,
        params.senderId,
        params.clientMessageId
      );
      if (existing) return markIdempotentReplay(existing);
    }

    // fetch source message
    const source = await this.messageRepo.findById(params.sourceMessageId);
    if (!source || source.isDeleted)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    // If the caller asserted a source room (REST path param), it must match the message's room.
    if (params.sourceRoomId != null && source.roomId !== params.sourceRoomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // The caller MUST belong to the message's ACTUAL room — on BOTH transports. Forwarding
    // READS source.content, so without this a socket caller (gRPC carries no sourceRoomId)
    // could exfiltrate any message from a DM they're not in. Closes the cross-room read-IDOR.
    await this.assertCallerInMessageRoom(source, params.senderId);

    const forwardData = {
      originalMessageId: source.id,
      originalRoomId: source.roomId,
      originalSenderId: source.senderId ?? "",
      originalCreatedAt: source.createdAt.toISOString(),
      originalContentType: source.messageType,
    };

    const targetAllocation = await this.roomRepo.allocateSequenceWithRoom(
      params.targetRoomId
    );
    const seq = targetAllocation.sequenceNumber;
    // §8.1 — a forward does NOT inherit the source message's timer; it is a new
    // message in the TARGET chat and follows that chat's own setting.
    const autoDelete = this.autoDeleteStampFromRoom(targetAllocation.room);

    let message: PrivateMessage;
    try {
      message = await this.messageRepo.createForwardedMessage({
        autoDeleteAt: autoDelete.autoDeleteAt,
        autoDeleteAfterView: autoDelete.autoDeleteAfterView,
        roomId: params.targetRoomId,
        senderId: params.senderId,
        receiverId: params.receiverId,
        content: source.content as object,
        messageType: source.messageType,
        forwardData,
        clientMessageId: params.clientMessageId ?? null,
        sequenceNumber: seq,
      });
    } catch (err) {
      // Same idempotency race as sendMessage: a concurrent forward with the
      // same clientMessageId loses the unique-index insert (E11000/P2002) —
      // re-read and return the winner instead of erroring.
      if (params.clientMessageId && isDuplicateKeyError(err)) {
        const dup = await this.messageRepo.findByClientMessageId(
          params.targetRoomId,
          params.senderId,
          params.clientMessageId
        );
        if (dup) return markIdempotentReplay(dup);
      }
      throw err;
    }

    this.roomRepo
      .updateRoomOnNewMessage({
        roomId: params.targetRoomId,
        message: {
          _id: message.id,
          content: message.content,
          senderId: message.senderId ?? "",
          messageType: message.messageType,
          systemEvent: message.systemEvent,
          systemData: message.systemData,
          createdAt: message.createdAt,
          clientMessageId: message.clientMessageId,
          sequenceNumber: message.sequenceNumber,
          revision: message.revision,
        },
        receiverId: params.receiverId,
        unreadIncrement: shouldCountInUnread({
          messageType: message.messageType,
          systemEvent: message.systemEvent,
          explicit: (message as unknown as { countInUnread?: boolean | null })
            .countInUnread,
        })
          ? 1
          : 0,
      })
      .catch((err: unknown) => {
        logger.warn(
          `PrivateMessageService|forwardMessage|updateRoom failed: ${String(err)}`
        );
      });

    return message;
  }

  async getMessageReactions(params: {
    messageId: string;
    roomId: string;
    requesterId: string;
  }): Promise<{
    reactions: Record<
      string,
      {
        count: number;
        users: { userId: string; displayName: string; avatar: string }[];
        selfReacted: boolean;
      }
    >;
  }> {
    const raw = await this.messageRepo.getReactions(params.messageId);
    if (raw === null) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    // Stored entries are reactor OBJECTS; reduce to { emoji: userId[] } so the
    // grouped result carries the plain id string in users[].userId (not the object).
    const reactions = reactionUserIdMap(raw.reactions);
    const allUserIds = [...new Set(Object.values(reactions).flat())];

    const snapshots =
      allUserIds.length > 0
        ? await this.userSnapshotService.getUserSnapshotsMap(
            allUserIds,
            this.cacheRepo
          )
        : new Map<string, Record<string, unknown>>();

    const result: Record<
      string,
      {
        count: number;
        users: { userId: string; displayName: string; avatar: string }[];
        selfReacted: boolean;
      }
    > = {};

    for (const [emoji, userIds] of Object.entries(reactions)) {
      result[emoji] = {
        count: userIds.length,
        selfReacted: userIds.includes(params.requesterId),
        users: userIds.map((uid) => {
          const snap = snapshots.get(uid) ?? {};
          return {
            userId: uid,
            displayName:
              (snap.displayName as string) ?? (snap.memberId as string) ?? "",
            avatar: (snap.avatar as string) ?? "",
          };
        }),
      };
    }

    return { reactions: result };
  }

  /**
   * Reconnect gap-fill: returns messages with sequenceNumber > sinceSeq for a
   * room the user participates in. Includes tombstones (no isDeleted filter) so
   * the client can reconcile deletes/edits it missed while offline.
   *
   * When `sinceRevision` is set the room switches to the ZERO-LOSS revision axis
   * instead: every message whose `revision > sinceRevision`, inserts AND mutations,
   * via the same core as the REST `/changes` feed. `lastSeq` then still reports the
   * page's highest sequenceNumber so a client mixing both cursors stays consistent.
   */
  async catchup(p: {
    roomId: string;
    userId: string;
    sinceSeq: number;
    sinceRevision?: number;
    limit: number;
  }): Promise<{
    authorized: boolean;
    events: PrivateMessage[];
    hasMore: boolean;
    lastSeq: number;
    lastRevision: number;
    roomRevision: number;
    resetRequired: boolean;
  }> {
    const room = await this.roomRepo.findByRoomId(p.roomId, {
      projection: { roomId: 1, participants: 1 },
    });
    if (!room || !room.participants?.includes(p.userId)) {
      return {
        authorized: false,
        events: [],
        hasMore: false,
        lastSeq: p.sinceSeq,
        lastRevision: 0,
        roomRevision: 0,
        resetRequired: false,
      };
    }

    const cutoff = getPrivateDeletionCutoff(room, p.userId);

    if (p.sinceRevision != null) {
      const changes = await this.resolveChanges({
        roomId: p.roomId,
        userId: p.userId,
        sinceRevision: p.sinceRevision,
        limit: p.limit,
        cutoff,
      });
      return {
        authorized: true,
        events: changes.messages,
        hasMore: changes.hasMore,
        lastSeq: changes.messages.length
          ? Math.max(...changes.messages.map((m) => m.sequenceNumber))
          : p.sinceSeq,
        lastRevision: changes.nextRevision ?? p.sinceRevision,
        roomRevision: changes.roomRevision,
        resetRequired: changes.resetRequired,
      };
    }

    const rows = await this.messageRepo.findAfterSeq(
      p.roomId,
      p.sinceSeq,
      p.limit
    );
    const hasMore = rows.length > p.limit;
    const rawEvents = hasMore ? rows.slice(0, p.limit) : rows;

    // Exclude messages the requesting user hid with "delete for me", and
    // anything at/before their "delete conversation" cutoff.
    // deletedFor shape: { [userId]: ISO-timestamp }
    const events = rawEvents.filter((m) => {
      const deletedFor = (m.deletedFor ?? {}) as Record<string, unknown>;
      if (p.userId in deletedFor) return false;
      if (cutoff && m.createdAt <= cutoff) return false;
      return true;
    });

    const lastSeq = events.length
      ? events[events.length - 1]!.sequenceNumber
      : p.sinceSeq;

    return {
      authorized: true,
      events,
      hasMore,
      lastSeq,
      lastRevision: 0,
      roomRevision: 0,
      resetRequired: false,
    };
  }

  async enrichMessages(
    messages: PrivateMessage[],
    /** Requesting user — used only to resolve `systemAction.alreadyJoined` on
     *  COMMUNITY_INVITE cards. Omitted callers just don't get that field
     *  personalized (falls back to `false`), same as a community-service outage. */
    viewerId?: string
  ): Promise<Array<Record<string, unknown>>> {
    const senderIds = [
      ...new Set(
        messages.map((m) => m.senderId).filter((s): s is string => Boolean(s))
      ),
    ];

    const snapshots = senderIds.length
      ? await this.userSnapshotService.getUserSnapshotsMap(
          senderIds,
          this.cacheRepo
        )
      : new Map<string, Record<string, unknown>>();

    // Resolve every stored media key on this page ONCE (sender + reaction-user
    // avatars + attachment object keys) into full download URLs. Resolve on
    // READ — persisted snapshots keep the stable raw object key; the
    // presigned/CDN URL is (re)derived here so the FE never receives a key.
    const mediaKeys: string[] = [];
    for (const snap of snapshots.values()) {
      const avatar = (snap as Record<string, unknown>).avatar;
      if (typeof avatar === "string" && avatar) mediaKeys.push(avatar);
    }
    for (const message of messages) {
      const files = (message.content as Record<string, unknown> | null)?.files;
      if (Array.isArray(files)) {
        for (const file of files) {
          mediaKeys.push(...fileMediaKeys(file as MediaFileLike));
        }
      }
      const sticker = (message.content as Record<string, unknown> | null)
        ?.sticker;
      if (sticker && typeof sticker === "object") {
        const key = fileMediaKey(sticker as MediaFileLike);
        if (key) mediaKeys.push(key);
      }
      const quote = message.quoteData as Record<string, unknown> | null;
      if (typeof quote?.thumbnail === "string" && quote.thumbnail) {
        mediaKeys.push(quote.thumbnail);
      }
      const reactions = message.reactions as Record<string, unknown> | null;
      if (reactions) {
        for (const reactors of Object.values(reactions)) {
          if (!Array.isArray(reactors)) continue;
          for (const reactor of reactors) {
            const avatar = (reactor as Record<string, unknown>)?.avatar;
            if (typeof avatar === "string" && avatar) mediaKeys.push(avatar);
          }
        }
      }
    }
    const urlMap = await resolveMediaUrlMap(mediaKeys);

    // Resolve `systemAction` for every COMMUNITY_INVITE card on this page in
    // ONE batched gRPC call (deduped by communityId+code) — unlike the live
    // send path (`deliverInviteLinkDm`), a historical read can't assume the
    // invite is still fresh: the recipient may have joined since, or the
    // link may have been revoked/expired/the community deleted.
    const systemActionByMessageId = new Map<
      string,
      | ReturnType<typeof buildCommunityInvitationAction>
      | ReturnType<typeof buildGroupInvitationAction>
    >();
    const inviteMessages = messages.filter(isCommunityInvitationMessage);
    if (inviteMessages.length > 0) {
      const queriesByKey = new Map<
        string,
        { communityId: string; code: string }
      >();
      for (const m of inviteMessages) {
        const sd = (m.systemData ?? {}) as Record<string, unknown>;
        const communityId = String(sd.communityId ?? "");
        if (!communityId) continue;
        const code = String(sd.linkCode ?? "");
        queriesByKey.set(`${communityId}::${code}`, { communityId, code });
      }
      const contexts = this.communityClient
        ? await this.communityClient.getCommunityInviteContexts(
            viewerId ?? "",
            [...queriesByKey.values()]
          )
        : [];
      // Re-matched by communityId alone: `getCommunityInviteContexts` doesn't
      // echo `code` back, and in practice every invite card for the same
      // community on one page (one room/conversation) shares the same code.
      const contextByCommunityId = new Map(
        contexts.map((c) => [c.communityId, c])
      );

      for (const m of inviteMessages) {
        const sd = (m.systemData ?? {}) as Record<string, unknown>;
        const communityId = String(sd.communityId ?? "");
        const communityName = String(sd.communityName ?? "");
        const storedHandle = sd.communityHandle
          ? String(sd.communityHandle)
          : null;
        const inviteCode = sd.linkCode ? String(sd.linkCode) : null;
        const deepLink = String(sd.inviteDeepLink ?? sd.inviteUrl ?? "");
        const ctx = communityId
          ? contextByCommunityId.get(communityId)
          : undefined;

        systemActionByMessageId.set(
          m.id,
          ctx
            ? buildCommunityInvitationAction({
                communityId,
                communityName: ctx.found ? ctx.communityName : communityName,
                communityHandle: ctx.found ? ctx.communityHandle : null,
                inviteCode,
                deepLink,
                alreadyJoined: ctx.isMember,
                status: ctx.found ? ctx.linkStatus : "DELETED",
              })
            : // gRPC unresolved/unavailable — fail open using the message's own
              // stored data rather than telling every past invite it's dead.
              buildCommunityInvitationAction({
                communityId,
                communityName,
                communityHandle: storedHandle,
                inviteCode,
                deepLink,
                alreadyJoined: false,
                status: "ACTIVE",
              })
        );
      }
    }

    // Resolve `systemAction` for every GROUP_INVITE card — in-process (no
    // gRPC): group membership/link state lives in this same service, so each
    // card is re-checked directly against the current row, unlike
    // COMMUNITY_INVITE which needs the batched gRPC round-trip above.
    const groupInviteMessages = messages.filter(isGroupInvitationMessage);
    if (
      groupInviteMessages.length > 0 &&
      this.groupRoomRepo &&
      this.groupMemberRepo
    ) {
      for (const m of groupInviteMessages) {
        const sd = (m.systemData ?? {}) as Record<string, unknown>;
        const groupId = String(sd.groupId ?? "");
        const groupName = String(sd.groupName ?? "");
        const groupAvatarUrl = sd.groupAvatarUrl
          ? String(sd.groupAvatarUrl)
          : null;
        const memberCount = Number(sd.memberCount ?? 0);
        const token = sd.token ? String(sd.token) : null;
        const deepLink = String(sd.inviteDeepLink ?? sd.inviteUrl ?? "");

        const room = groupId
          ? await this.groupRoomRepo.findActiveByRoomId(groupId)
          : null;
        const alreadyJoined =
          Boolean(room) && viewerId
            ? Boolean(
                await this.groupMemberRepo.findActiveByRoomAndUser(
                  groupId,
                  viewerId
                )
              )
            : false;
        const link = token
          ? await this.groupInviteLinkRepo?.findActiveByToken(token)
          : null;
        const status: "ACTIVE" | "EXPIRED" | "REVOKED" | "DELETED" = !room
          ? "DELETED"
          : token && !link
            ? "REVOKED"
            : "ACTIVE";

        systemActionByMessageId.set(
          m.id,
          buildGroupInvitationAction({
            groupId,
            groupName: room?.name ?? groupName,
            groupAvatarUrl: room
              ? await resolveMediaUrl(room.avatar)
              : groupAvatarUrl,
            memberCount: room?.memberCount ?? memberCount,
            inviteToken: token,
            deepLink,
            alreadyJoined,
            status,
          })
        );
      }
    }

    return messages.map((message) => {
      const snapshot = (snapshots.get(message.senderId || "") || {}) as Record<
        string,
        unknown
      >;
      // §1: canonical wire shape — drops the internal `messageType` column and
      // exposes UPPER-CASE `contentType`, identical to the socket message:new
      // and the REST edit/forward responses (single client mapper).
      const wire = toWireMessage(
        message as { messageType?: string | null }
      ) as unknown as Record<string, unknown>;
      // `readBy`/`deliveredTo`/`deliveredAt` are real PrivateMessage columns, so
      // `toWireMessage`'s `...rest` spread carries them onto `wire` verbatim —
      // strip them here so none leak into the history response. The frontend
      // no longer consumes per-message delivery/read receipts on history
      // reads; the underlying columns (still written by `markDelivered` etc.)
      // are untouched — this only affects what gets serialized onto the wire.
      // Fields are omitted entirely (not `null`/`[]`).
      delete wire.readBy;
      delete wire.deliveredTo;
      delete wire.deliveredAt;
      wire.countInUnread = shouldCountInUnread({
        messageType: message.messageType,
        systemEvent: message.systemEvent,
        explicit: (message as unknown as { countInUnread?: boolean | null })
          .countInUnread,
      });
      const systemAction = systemActionByMessageId.get(message.id);
      if (systemAction) wire.systemAction = systemAction;
      const displayName = (snapshot.displayName as string) || "";
      const avatar = urlFromMap(urlMap, (snapshot.avatar as string) || "");

      // Stamp resolved download URLs onto attachment files (content.files[])
      // and the sticker sub-object (content.sticker) — the latter lives
      // outside `files[]` and is otherwise never resolve-on-read.
      const content = wire.content as Record<string, unknown> | null;
      let contentForWire = content;
      if (
        viewerId &&
        String(wire.contentType).toUpperCase() === "SYSTEM" &&
        message.systemEvent
      ) {
        const systemData = (message.systemData ?? {}) as Record<
          string,
          unknown
        >;
        const thirdPersonText = String(content?.text ?? "");
        const personalized = personalizePrivateSystemMessageForViewer(
          message.systemEvent,
          systemData,
          thirdPersonText,
          viewerId,
          currentLocale()
        );
        if (personalized !== thirdPersonText && content) {
          contentForWire = { ...content, text: personalized };
        }
      }

      const resolvedContent = contentForWire
        ? {
            ...contentForWire,
            ...(Array.isArray(contentForWire.files)
              ? {
                  files: applyUrlMapToFiles(
                    contentForWire.files as MediaFileLike[],
                    urlMap
                  ),
                }
              : {}),
            ...(contentForWire.sticker &&
            typeof contentForWire.sticker === "object"
              ? {
                  sticker: resolveStickerField(
                    contentForWire.sticker as MediaFileLike,
                    urlMap
                  ),
                }
              : {}),
          }
        : contentForWire;

      // Canonical client-facing reaction shape (FE reads `reactionGroups[]`; the
      // legacy `reactions` map carried by `...wire` is deprecated).
      const reactionGroups = buildReactionGroups(wire.reactions, (key) =>
        urlFromMap(urlMap, key)
      );

      return {
        ...wire,
        content: resolvedContent,
        senderDisplayName: displayName,
        senderAvatar: avatar,
        senderMemberId: (snapshot.memberId as string) || "",
        isDeletedUser: snapshot.isDeletedUser === true,
        // additive canonical aliases so REST history reads with the SAME mapper
        // as the socket message:new (legacy fields kept untouched).
        senderName: displayName,
        conversationType: "PRIVATE",
        quoteData: resolveQuoteThumbnail(
          buildCanonicalQuote(wire.quoteData),
          urlMap
        ),
        reactionGroups,
        // Normalized tombstone (one shape across private/group/community).
        ...tombstoneWireFields(message),
        clientTs: Number(
          (wire.clientInfo as Record<string, unknown> | null)?.clientTs ?? 0
        ),
        serverTs:
          message.createdAt instanceof Date ? message.createdAt.getTime() : 0,
      };
    });
  }
}
