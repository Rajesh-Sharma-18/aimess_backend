import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from "@aimess/errors";
import { logger } from "@aimess/logger";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";

import {
  CHAT_EDIT_WINDOW_MS,
  CHAT_TEXT_MAX_CHARS,
  assertAttachmentsValid,
} from "../constants/media-limits.js";
import { assertAttachmentsVerified } from "../lib/attachment-guard.js";
import {
  buildGroupSystemFallbackText,
  currentLocale,
  isCallContentType,
  personalizeGroupSystemMessageForViewer,
} from "@aimess/constants";
import {
  anonymizeSystemData,
  anonymizeWireSender,
  collectDeletedUserIds,
  collectRowUserIds,
} from "../lib/deleted-identity.js";
import {
  buildMessagePreview,
  buildReactionTargetPreview,
} from "./message-preview.service.js";
import { publishConvUpdatedSafe } from "../events/publish-conv-updated.js";
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
  type CanonicalQuote,
} from "../lib/chat-message.serializer.js";
import {
  assertGroupMember,
  assertGroupWritable,
  assertGroupReadAccess,
  assertGroupMemberNotMuted,
  isGroupMemberMuted,
  canDeleteOthersMessage,
} from "../lib/access-guard.js";
import { publishAdminReportIngestSafe } from "../events/publish-admin-report.js";
import { getGroupVisibilityCutoff } from "../lib/deletion-cutoff.js";
import {
  assertMaySeeReadReceipts,
  buildReadReceipts,
  readersAtOrPast,
  type ReadReceiptsPayload,
} from "../lib/read-receipts.js";
import { isObjectId } from "../lib/object-id.js";
import {
  computeSeqAroundCursors,
  type AroundCursors,
  computeSeqPageCursors,
} from "../lib/around-cursors.js";
import { isDuplicateKeyError } from "../lib/db-errors.js";
// No AFTER_VIEWING grace period here: group reads never arm, because group
// AFTER_VIEWING is unsupported (see GroupAutoDeleteService).
import {
  AUTO_DELETE_NONE,
  computeAutoDeleteStamp,
  readRoomAutoDelete,
  type AutoDeleteStamp,
} from "../lib/auto-delete.js";
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
import { groupVisibilitySource } from "./last-visible-adapters.js";
import {
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

import type { GroupMessageRepository } from "../repositories/group-message.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import {
  resolveDisplayName,
  type UserSnapshotService,
} from "./user-snapshot.service.js";
import type { PresenceService } from "./presence.service.js";
import type { Redis, Cluster } from "ioredis";
import type { GroupMember, GroupMessage } from "../generated/prisma/index.js";

export class GroupMessageService {
  constructor(
    private readonly messageRepo: GroupMessageRepository,
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    // Presence-aware delivery — populates `deliveredTo` at insert time from
    // every active OTHER member currently online, and publishes one
    // `message:delivered` per online member so the sender's tick flips to ✓✓
    // immediately without waiting for each recipient's client-triggered ack.
    // Optional so unit tests that construct the service without these keep
    // working (delivery stays "sent" until the client ack lands).
    private readonly presenceService?: PresenceService,
    private readonly redis?: Redis | Cluster | null
  ) {}

  async sendMessage(params: {
    roomId: string;
    senderId: string;
    senderName: string;
    senderAvatar: string;
    content: { text: string; urls?: string[]; files?: unknown[] };
    messageType: string;
    parentMessageId?: string | null;
    clientMessageId?: string | null;
    /** Client compose time (epoch ms) — display only; never overwrites serverTs. */
    clientTs?: number | null;
  }): Promise<GroupMessage & { senderRole?: string }> {
    // Defensive caps (the gRPC/socket send path doesn't run the Zod validators).
    if ((params.content?.text?.length ?? 0) > CHAT_TEXT_MAX_CHARS) {
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    }
    assertAttachmentsValid(
      params.messageType,
      params.content?.files as Array<Record<string, unknown>> | undefined
    );
    // See private-message.service.ts — this verifies the OBJECT (scan verdict,
    // uploader, room scope), not just the client-declared size/duration.
    await assertAttachmentsVerified({
      resourceId: params.roomId,
      senderId: params.senderId,
      files: params.content?.files as
        | Array<Record<string, unknown>>
        | undefined,
      extra: [
        (params.content as { sticker?: Record<string, unknown> } | undefined)
          ?.sticker,
      ],
    });

    // Verify membership
    const member = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.senderId
    );
    if (!member) throw new BadRequestError("CHAT_NOT_A_MEMBER");
    assertGroupMemberNotMuted(member);
    // A frozen room (disbanded / closed by a system ban) keeps history readable, so the membership check above cannot catch it — the room's own status must.
    await assertGroupWritable(this.roomRepo, params.roomId);

    // §2.2: stamp the sender's group role on the returned message (transient,
    // not persisted) so the message:new emit can carry senderRole.
    const senderRole = (member as { role?: string }).role ?? "MEMBER";
    const withRole = (m: GroupMessage): GroupMessage & { senderRole: string } =>
      Object.assign(m, { senderRole });

    // Check idempotency (album batches use `base:N` sibling clientMessageIds).
    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.senderId}:${params.clientMessageId}`;
      const cachedId = await this.cacheRepo.getMessageIdempotency(idemKey);
      if (cachedId) {
        const cached = await this.messageRepo.findById(cachedId);
        if (cached) {
          const batch = await this.messageRepo.findAlbumBatchByClientMessageId(
            params.roomId,
            params.senderId,
            params.clientMessageId
          );
          const messages = (batch?.length ?? 0) > 0 ? batch : [cached];
          return withRole(
            markAlbumIdempotentReplay(messages[messages.length - 1]!, messages)
          );
        }
      }
      const existing = await this.messageRepo.findByClientMessageId(
        params.roomId,
        params.senderId,
        params.clientMessageId
      );
      if (existing) {
        this.cacheRepo
          .setMessageIdempotency(idemKey, existing.id)
          .catch(() => {});
        const batch = await this.messageRepo.findAlbumBatchByClientMessageId(
          params.roomId,
          params.senderId,
          params.clientMessageId
        );
        const messages = (batch?.length ?? 0) > 0 ? batch : [existing];
        return withRole(
          markAlbumIdempotentReplay(messages[messages.length - 1]!, messages)
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
        // Album sends are split one-row-per-file (lib/split-media-album.ts),
        // so the parent row's own content.files can never reveal the true
        // album size — look up its sibling batch for IMAGE/VIDEO parents.
        const attachmentCountOverride = ["IMAGE", "VIDEO"].includes(
          normalizeMessageType(originalMsg.messageType)
        )
          ? await resolveReplyAttachmentCount(
              this.messageRepo,
              params.roomId,
              originalMsg.senderId ?? "",
              originalMsg
            )
          : undefined;
        quoteData = buildReplyQuoteSnapshot({
          messageId: originalMsg.id,
          senderId: originalMsg.senderId ?? "",
          senderName: originalMsg.senderName ?? "",
          messageType: originalMsg.messageType,
          content: originalMsg.content,
          isDeleted: Boolean(originalMsg.isDeleted),
          attachmentCountOverride,
        });
      }
    }

    // Presence-aware group delivery: resolve every OTHER active member's live
    // socket status in ONE batch call BEFORE inserting, so the persisted
    // `deliveredTo` list reflects the truthful "who was online at send time"
    // rather than "who has a client-side ack listener that happened to fire".
    // Only queried when the service is fully wired (presence + redis) — tests
    // that omit those keep the old behaviour and deliveredTo starts empty.
    let deliveredToOnInsert: string[] = [];
    if (this.presenceService && this.redis) {
      try {
        const others = (
          await this.memberRepo.findActiveMembers(params.roomId)
        ).filter((m) => m.userId !== params.senderId);
        if (others.length > 0) {
          const presence = await this.presenceService.getPresenceMany(
            others.map((m) => m.userId)
          );
          deliveredToOnInsert = others
            .filter((m) => presence.get(m.userId) === true)
            .map((m) => m.userId);
        }
      } catch (err) {
        // Delivery is best-effort — a presence lookup outage must never block
        // the send itself. The client-triggered `message:delivered` ack path
        // remains as the fallback delivery signal.
        logger.warn(
          `GroupMessageService|resolvePresence|room=${params.roomId}: ${String(err)}`
        );
      }
    }

    // One round trip for two answers: the first row's sequence number and the
    // room's auto-delete timer. Which timer THIS send gets is decided once,
    // here, off the row the `$inc` already read — so a change made a moment ago
    // is in force for the very next message and there is no cached copy to go
    // stale. Resolved before the insert loop so every album row of one send
    // shares the same deadline.
    const firstSlot = await this.roomRepo.allocateSequenceWithRoom(
      params.roomId
    );
    const autoDelete = this.autoDeleteStampFromRoom(firstSlot.room);

    const created: GroupMessage[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const entity: Record<string, unknown> = {
        autoDeleteAt: autoDelete.autoDeleteAt,
        autoDeleteAfterView: autoDelete.autoDeleteAfterView,
        roomId: params.roomId,
        senderId: params.senderId,
        senderName: params.senderName,
        senderAvatar: params.senderAvatar,
        content: part.content,
        messageType: normalizeMessageType(part.messageType),
        parentMessageId: resolvedParentId,
        clientMessageId: part.clientMessageId || null,
        // Same deliveredTo snapshot on every album sibling — atomic delivery
        // for a media set that the recipient's client will receive as one page.
        deliveredTo: deliveredToOnInsert,
        ...(i === 0 && params.clientTs
          ? { clientInfo: { clientTs: params.clientTs } }
          : {}),
        ...(i === 0 && quoteData ? { quoteData } : {}),
      };

      entity.sequenceNumber =
        i === 0
          ? firstSlot.sequenceNumber
          : await this.roomRepo.allocateSequence(params.roomId);

      try {
        const row = await this.messageRepo.create(
          entity as Parameters<typeof this.messageRepo.create>[0]
        );
        created.push(row);
      } catch (err) {
        if (isDuplicateKeyError(err) && part.clientMessageId) {
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
            return withRole(
              markAlbumIdempotentReplay(
                messages[messages.length - 1]!,
                messages
              )
            );
          }
        }
        throw err;
      }
    }

    const message = created[created.length - 1]!;

    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.senderId}:${params.clientMessageId}`;
      this.cacheRepo.setMessageIdempotency(idemKey, message.id).catch(() => {});
    }

    const messageContent = (message.content ?? {}) as Record<string, unknown>;
    // Awaited (not fire-and-forget) for the same reason incUnreadForRoom below
    // is awaited: conv:updated/chat:unread_summary fan out right after this —
    // firing before the room's lastMessage/lastActivity write actually commits
    // left the list preview/position stale while the unread badge (which does
    // commit synchronously) moved on, a real badge/list mismatch under load or
    // a transient failure.
    try {
      await this.roomRepo.updateLastMessage(params.roomId, {
        _id: message.id,
        senderId: message.senderId ?? null,
        senderName: message.senderName,
        messageType: message.messageType,
        content: { text: (messageContent.text as string) || "" },
        createdAt: message.createdAt,
        clientMessageId: message.clientMessageId,
        sequenceNumber: message.sequenceNumber,
        revision: message.revision,
      });
    } catch (err: unknown) {
      logger.warn(
        `GroupMessageService|updateLastMessage failed: ${String(err)}`
      );
    }

    const unreadIncrement = created.filter((m) =>
      shouldCountInUnread({
        messageType: m.messageType,
        systemEvent: m.systemEvent,
        explicit: (m as unknown as { countInUnread?: boolean | null })
          .countInUnread,
      })
    ).length;
    if (unreadIncrement > 0) {
      // Await before the caller fans conv:updated / chat:unread_summary — otherwise
      // the summary push reads a stale sum and the Chats nav badge desyncs from
      // the list (classic private/group badge mismatch).
      try {
        await this.memberRepo.incUnreadForRoom(
          params.roomId,
          params.senderId,
          unreadIncrement
        );
      } catch (err: unknown) {
        logger.warn(
          `GroupMessageService|incUnreadForRoom failed: ${String(err)}`
        );
      }
    }

    // Fire one `message:delivered` per online member so the sender's tick can
    // flip SENT→DELIVERED as each recipient is confirmed present. Fire-and-
    // forget — a Redis blip must never fail the send itself.
    if (this.redis && deliveredToOnInsert.length > 0) {
      const messageIds = created.map((m) => m.id);
      const lastId = message.id;
      for (const recipientId of deliveredToOnInsert) {
        void this.redis
          .publish(
            `conv:${params.roomId}`,
            JSON.stringify({
              event: "message:delivered",
              data: {
                conversationId: params.roomId,
                recipientId,
                upToMessageId: lastId,
                messageIds,
              },
            })
          )
          .catch((err: unknown) =>
            logger.warn(
              `GroupMessageService|publish message:delivered failed room=${params.roomId} recipient=${recipientId}: ${String(err)}`
            )
          );
      }
      // ALSO direct to the SENDER's own `user:<id>` channel — one publish
      // regardless of how many members came online (the sender's list row only
      // needs one tick update). Guarantees delivery even if the sender's
      // sidebar socket hasn't (yet) joined `conv:<roomId>` — see the identical
      // comment on the private markDelivered path.
      void this.redis
        .publish(
          `user:${params.senderId}`,
          JSON.stringify({
            event: "message:delivered",
            data: {
              conversationId: params.roomId,
              recipientId: deliveredToOnInsert[0],
              upToMessageId: lastId,
              messageIds,
            },
          })
        )
        .catch((err: unknown) =>
          logger.warn(
            `GroupMessageService|publish message:delivered direct failed room=${params.roomId} sender=${params.senderId}: ${String(err)}`
          )
        );
    }

    return withRole(attachAlbumMessages(message, created));
  }

  /**
   * Presence-connect backfill for GROUPS — called by PresenceService when a
   * user transitions offline→online. Walks every group the user is an active
   * member of, atomically appends the userId to every message's `deliveredTo`
   * where they aren't already present, and publishes one `message:delivered`
   * per room so senders' ticks catch up live. Bounded by member count and by
   * the repo's per-room 200-row cap inside markDeliveredUpTo.
   */
  async backfillDeliveredOnPresenceConnect(userId: string): Promise<void> {
    if (!this.redis) return;
    let memberships: Array<{ roomId: string }>;
    try {
      memberships = await this.memberRepo.getActiveMemberships(userId);
    } catch (err) {
      logger.warn(
        `GroupMessageService|backfill|getActiveMemberships failed userId=${userId}: ${String(err)}`
      );
      return;
    }
    for (const membership of memberships) {
      try {
        const head = await this.roomRepo.findActiveByRoomId(membership.roomId);
        if (!head?.lastMessageId) continue;
        const { count, messageIds } = await this.messageRepo.markDeliveredUpTo(
          membership.roomId,
          userId,
          head.lastMessageId
        );
        if (count === 0) continue;
        const payload = JSON.stringify({
          event: "message:delivered",
          data: {
            conversationId: membership.roomId,
            recipientId: userId,
            upToMessageId: head.lastMessageId,
            messageIds,
          },
        });
        await this.redis.publish(`conv:${membership.roomId}`, payload);
        const senderId = (
          head.lastMessagePreview as { senderId?: string } | null
        )?.senderId;
        if (senderId && senderId !== userId) {
          await this.redis
            .publish(`user:${senderId}`, payload)
            .catch((e: unknown) =>
              logger.warn(
                `GroupMessageService|backfill direct publish failed sender=${senderId}: ${String(e)}`
              )
            );
        }
      } catch (err) {
        logger.warn(
          `GroupMessageService|backfill|room=${membership.roomId} userId=${userId}: ${String(err)}`
        );
      }
    }
  }

  /**
   * Active member userIds for a group room — the recipient list for inbox
   * "bump-to-top" (`conv:updated`) fan-out.
   */
  async getActiveMemberIds(roomId: string): Promise<string[]> {
    const members = await this.memberRepo.findActiveMembers(roomId);
    return members.map((m) => m.userId);
  }

  /**
   * {@link getActiveMemberIds} plus the subset currently moderation-muted, from
   * the SAME query — the gateway's typing/recording gate needs both and would
   * otherwise pay a second round trip per keystroke. Lazy expiry is applied
   * (`isGroupMemberMuted`), so a lapsed timed mute never appears here.
   */
  async getActiveRoster(
    roomId: string
  ): Promise<{ userIds: string[]; mutedUserIds: string[] }> {
    const members = await this.memberRepo.findActiveMembers(roomId);
    return {
      userIds: members.map((m) => m.userId),
      mutedUserIds: members.filter(isGroupMemberMuted).map((m) => m.userId),
    };
  }

  /**
   * The room's CURRENT last-message sequenceNumber (0 if none). Used by the
   * read-receipt fan-out to tell the sender's inbox row whether a reader's
   * watermark has caught up to the newest message — see `getMessageSequence`.
   */
  async getRoomLastMessageSeq(roomId: string): Promise<number> {
    const room = await this.roomRepo.findActiveByRoomId(roomId);
    const lastId = room?.lastMessageId;
    return lastId ? this.getMessageSequence(lastId) : 0;
  }

  /** See PrivateRoomRepository.setReactionActivity — identical overlay semantics. */
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

  /** See PrivateRoomRepository.clearReactionActivityIfCurrent — identical semantics. */
  async clearReactionActivityIfCurrent(
    roomId: string,
    identity: { messageId: string; emoji: string; actorId: string }
  ): Promise<void> {
    await this.roomRepo.clearReactionActivityIfCurrent(roomId, identity);
  }

  /** See PrivateMessageService.getRoomBumpSnapshot — identical purpose, reads
   *  GroupRoom.lastMessagePreview instead (already carries senderName). */
  async getRoomBumpSnapshot(roomId: string): Promise<{
    lastMessageId: string | null;
    lastMessageAt: number;
    senderId: string;
    senderName: string;
    content: unknown;
    messageType: string;
  } | null> {
    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room?.lastMessagePreview) return null;
    const lp = room.lastMessagePreview as Record<string, unknown>;
    return {
      lastMessageId: room.lastMessageId ?? null,
      lastMessageAt: room.lastMessageAt?.getTime() ?? 0,
      senderId: (lp.senderId as string) ?? "",
      senderName: (lp.senderName as string) ?? "",
      content: { text: (lp.text as string) ?? "" },
      messageType: (lp.messageType as string) ?? "TEXT",
    };
  }

  async getMessages(params: {
    roomId: string;
    userId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<GroupMessage[]> {
    const member = await assertGroupMember(
      this.memberRepo,
      params.roomId,
      params.userId
    );
    const beforeTimestamp = params.cursor || new Date().toISOString();
    return this.messageRepo.findByRoomIdWithTime(
      params.roomId,
      beforeTimestamp,
      params.limit,
      params.userId,
      getGroupVisibilityCutoff(member)
    );
  }

  /**
   * Timestamp-paginated message page (before_ts / after_ts). Over-fetches one
   * extra row in the repo so `hasMore` is exact; `nextCursor` is the boundary
   * message's createdAt as epoch-ms (feed back as the next before_ts/after_ts).
   * Matches `getMessages` visibility (no membership gate; deleted-for-everyone
   * messages are returned for placeholder rendering).
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
    items: GroupMessage[];
    hasMore: boolean;
    nextCursor: string | null;
    total: number;
    cursors: AroundCursors;
    roomRevision: number;
  }> {
    const { member, readCutoffBefore } = await assertGroupReadAccess(
      this.memberRepo,
      params.roomId,
      params.userId
    );
    const cutoff = getGroupVisibilityCutoff(member);
    const [{ messages: items, hasMore }, total, roomRevision] =
      await Promise.all([
        this.messageRepo.findByRoomIdTimeline({
          userId: params.userId,
          roomId: params.roomId,
          direction: params.direction,
          ts: params.ts,
          boundaryId: params.boundaryId ?? null,
          inclusive: params.inclusive ?? false,
          limit: params.limit,
          cutoff,
          readCutoffBefore,
        }),
        this.messageRepo.countTimeline({
          roomId: params.roomId,
          userId: params.userId,
          cutoff,
          readCutoffBefore,
        }),
        this.roomRepo.getRoomRevision(params.roomId),
      ]);

    const cursors = await this.seqPageCursors(
      items,
      params.roomId,
      params.userId,
      cutoff,
      readCutoffBefore
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
    page: GroupMessage[],
    roomId: string,
    userId: string,
    cutoff: Date | undefined,
    readCutoffBefore?: Date
  ): Promise<AroundCursors> {
    return computeSeqPageCursors(page, (direction, seq) =>
      this.messageRepo.findByRoomIdSeq({
        userId,
        roomId,
        direction,
        seq,
        limit: 1,
        cutoff,
        readCutoffBefore,
      })
    );
  }

  /**
   * V2 §3.2: seq-keyset page. `nextCursor` is the boundary `sequenceNumber`.
   */
  async getMessagesSeq(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    /** null = newest page. */
    seq: number | null;
    limit: number;
  }): Promise<{
    items: GroupMessage[];
    hasMore: boolean;
    nextCursor: string | null;
    cursors: AroundCursors;
    roomRevision: number;
  }> {
    const { member, readCutoffBefore } = await assertGroupReadAccess(
      this.memberRepo,
      params.roomId,
      params.userId
    );
    const cutoff = getGroupVisibilityCutoff(member);
    const [rows, roomRevision] = await Promise.all([
      this.messageRepo.findByRoomIdSeq({
        userId: params.userId,
        roomId: params.roomId,
        direction: params.direction,
        seq: params.seq,
        limit: params.limit,
        cutoff,
        readCutoffBefore,
      }),
      this.roomRepo.getRoomRevision(params.roomId),
    ]);
    const hasMore = rows.length > params.limit;
    const items = rows.slice(0, params.limit);
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? String(last.sequenceNumber) : null;
    const cursors = await this.seqPageCursors(
      items,
      params.roomId,
      params.userId,
      cutoff,
      readCutoffBefore
    );
    return { items, hasMore, nextCursor, cursors, roomRevision };
  }

  /** Raw message lookup — the path-param delete route resolves its room from the message. */
  findMessageById(messageId: string): Promise<GroupMessage | null> {
    return this.messageRepo.findById(messageId);
  }

  /**
   * V2 §3.2: jump-to-message window centered on a message id.
   */
  async getMessagesAround(params: {
    roomId: string;
    userId: string;
    messageId: string;
    limit: number;
  }): Promise<{ items: GroupMessage[]; anchorSeq: number } & AroundCursors> {
    const { member, readCutoffBefore } = await assertGroupReadAccess(
      this.memberRepo,
      params.roomId,
      params.userId
    );
    const anchor = await this.messageRepo.findById(params.messageId);
    if (!anchor) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    const cutoff = getGroupVisibilityCutoff(member);
    const items = await this.messageRepo.findAroundSeq({
      userId: params.userId,
      roomId: params.roomId,
      anchorSeq: anchor.sequenceNumber,
      limit: params.limit,
      cutoff,
      readCutoffBefore,
    });
    // Bidirectional continuation: probe one row strictly beyond each window edge
    // (reusing the seq keyset paging query), so the client can page up AND down.
    const cursors = await computeSeqAroundCursors(items, (direction, seq) =>
      this.messageRepo.findByRoomIdSeq({
        userId: params.userId,
        roomId: params.roomId,
        direction,
        seq,
        limit: 1,
        cutoff,
        readCutoffBefore,
      })
    );
    return { items, anchorSeq: anchor.sequenceNumber, ...cursors };
  }

  /**
   * Paginated conversation page for a group room + mark-as-read side effect.
   * Enforces active membership first (same check as getMessages/listMedia),
   * fetches the offset page (createdAt < timestamp, newest first), then advances
   * the caller's read pointer to the newest returned message (forward-only).
   */
  async getConversation(params: {
    roomId: string;
    userId: string;
    pageNumber: number;
    limit: number;
    timestamp?: number;
  }): Promise<{ messages: GroupMessage[]; total: number }> {
    // Enforce active membership first.
    const member = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member) throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    const cutoff = getGroupVisibilityCutoff(member);

    const beforeMs = params.timestamp ?? Date.now();
    const skip = (params.pageNumber - 1) * params.limit;

    const [messages, total] = await Promise.all([
      this.messageRepo.listConversationMessages({
        roomId: params.roomId,
        userId: params.userId,
        beforeMs,
        skip,
        take: params.limit,
        cutoff,
      }),
      // Count must match the page's filter (createdAt < beforeMs + per-user
      // deletion exclusion), not the boundary-less countByRoom.
      this.messageRepo.countConversation({
        roomId: params.roomId,
        userId: params.userId,
        beforeMs,
        cutoff,
      }),
    ]);

    // Mark-as-read: advance to the newest message in the page (index 0, since
    // the page is createdAt DESC). Forward-only; skip when the page is empty.
    // Recompute remaining unread (messages still newer than the new pointer that
    // are visible to this user) so viewing an old page doesn't wrongly zero unread.
    const newest = messages[0];
    if (newest) {
      const remainingUnread = await this.messageRepo
        .countUnreadAfter({
          roomId: params.roomId,
          userId: params.userId,
          afterDate: newest.createdAt,
          cutoff,
        })
        .catch((err: unknown) => {
          logger.warn(
            `GroupMessageService|getConversation|countUnreadAfter failed: ${String(err)}`
          );
          return 0;
        });
      await this.memberRepo
        .advanceReadPointer(
          params.roomId,
          params.userId,
          newest.id,
          newest.createdAt,
          remainingUnread
        )
        .catch((err: unknown) => {
          logger.warn(
            `GroupMessageService|getConversation|advanceReadPointer failed: ${String(err)}`
          );
        });
    }

    return { messages, total };
  }

  async searchMessages(params: {
    roomId: string;
    userId: string;
    query: string;
    limit: number;
    cursor?: string | null;
  }): Promise<{
    messages: GroupMessage[];
    scores: Map<string, number>;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const member = await assertGroupMember(
      this.memberRepo,
      params.roomId,
      params.userId
    );
    return this.messageRepo.searchByText({
      roomId: params.roomId,
      query: params.query,
      limit: params.limit,
      userId: params.userId,
      cursor: params.cursor,
      cutoff: getGroupVisibilityCutoff(member),
    });
  }

  async listMedia(params: {
    roomId: string;
    userId: string;
    type?: string;
    cursor?: string | null;
    limit: number;
  }): Promise<GroupMessage[]> {
    // Enforce active membership first.
    const member = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member) throw new BadRequestError("CHAT_NOT_A_MEMBER");

    return this.messageRepo.listMedia({
      roomId: params.roomId,
      userId: params.userId,
      type: params.type,
      cursor: params.cursor,
      limit: params.limit,
      cutoff: getGroupVisibilityCutoff(member),
    });
  }

  async countMessages(roomId: string): Promise<number> {
    return this.messageRepo.countByRoom(roomId);
  }

  async countSearchResults(
    roomId: string,
    query: string,
    userId: string
  ): Promise<number> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    return this.messageRepo.countSearchResults(
      roomId,
      query,
      userId,
      getGroupVisibilityCutoff(member)
    );
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
    senderId: string | null;
    senderName: string;
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
      const prevContent = (prev.content ?? { text: "" }) as { text?: string };
      await this.roomRepo.setLastMessage(roomId, {
        id: prev.id,
        senderId: prev.senderId ?? null,
        senderName: prev.senderName ?? "",
        content: { text: prevContent.text ?? "" },
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
        senderId: prev.senderId ?? null,
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
      messageType: "",
      content: null,
      senderId: null,
      senderName: "",
      createdAt: new Date(0),
      hasLastMessage: false,
      clientMessageId: null,
      sequenceNumber: 0,
      revision: 0,
    };
  }

  /**
   * Per-recipient list-preview overrides for a delete-for-everyone fan-out: the
   * recipients who have personally hidden `sharedPrevMessageId` get their own
   * visible preview instead of the shared one. Empty map in the common case.
   */
  async resolveForEveryoneOverrides(
    roomId: string,
    sharedPrevMessageId: string | null,
    recipientIds: string[]
  ): Promise<Map<string, RecipientOverride | null>> {
    return resolveForEveryoneOverrides(
      groupVisibilitySource(this.messageRepo),
      roomId,
      sharedPrevMessageId,
      recipientIds
    );
  }

  async deleteForMe(
    messageId: string,
    userId: string,
    roomId: string
  ): Promise<GroupMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    // Bind message↔room: an active member of group A must not delete-for-me a
    // message that lives in group B (cross-room IDOR). NotFound (not Forbidden)
    // so foreign-message existence isn't leaked.
    if (!message || message.roomId !== roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new BadRequestError("CHAT_NOT_A_MEMBER");
    // Parity with CommunityMessageService.deleteForMe — a muted member cannot
    // mutate their own view of room content either.
    assertGroupMemberNotMuted(member);
    await assertGroupWritable(this.roomRepo, roomId);

    const hidden = await this.messageRepo.deleteForMe(messageId, userId);
    // Mirror of PrivateMessageService.deleteForMe: hiding a still-unread message
    // must shrink THIS member's badge (and only theirs). The repo re-checks the
    // read watermark, so hiding an already-read message is a no-op.
    if (
      message.senderId !== userId &&
      shouldCountInUnread({
        messageType: message.messageType,
        systemEvent: message.systemEvent,
        explicit: (message as unknown as { countInUnread?: boolean | null })
          .countInUnread,
      })
    ) {
      this.memberRepo
        .decrementUnreadForMessage({
          roomId,
          senderId: message.senderId,
          messageCreatedAt: message.createdAt,
          onlyUserId: userId,
        })
        .catch((err: unknown) => {
          logger.warn(
            `GroupMessageService|deleteForMe decrementUnreadForMessage failed: ${String(err)}`
          );
        });
    }
    return hidden;
  }

  /**
   * After a delete-for-me on the group's last message, find the message still
   * visible to THAT member (skipping globally-deleted and personally-hidden
   * messages) so a TARGETED conv:updated can refresh only the deleting user's
   * list preview. Mirror of the community/private forMe variant: it does NOT
   * touch the shared GroupRoom snapshot — every other member is unaffected.
   * Always returns a recalc object (hasLastMessage:false when the user has now
   * hidden every message) with a `wasEffectiveLast` flag (via
   * deletedWasEffectiveLast); the caller gates the broadcast on it so a
   * delete-for-me on a NON-last message is a no-op.
   */
  async recalculateLastMessageAfterDeleteForMe(
    roomId: string,
    deletedMessageCreatedAt: Date,
    userId: string
  ): Promise<{
    prevMessageId: string | null;
    messageType: string;
    content: unknown;
    senderId: string | null;
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
    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room) return null;
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    const prev = await this.messageRepo.findPreviousVisibleForUser(
      roomId,
      userId,
      getGroupVisibilityCutoff(member)
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
        senderId: prev.senderId ?? null,
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
      messageType: "",
      content: null,
      senderId: null,
      senderName: "",
      createdAt: new Date(0),
      hasLastMessage: false,
      wasEffectiveLast: true,
      clientMessageId: null,
      sequenceNumber: 0,
      revision: 0,
    };
  }

  /**
   * @param bySystem The caller is the auto-delete sweeper, not a person. The
   *   authority is the expired timer, so the actor checks below are skipped:
   *   a message must still disappear when its sender has since LEFT or been
   *   kicked (no member row at all) or is under a moderation mute — otherwise
   *   exactly the messages a departed member left behind would live forever.
   *   Only ever set server-side; no request path can reach it.
   */
  async deleteMessage(
    messageId: string,
    userId: string,
    roomId: string,
    bySystem = false
  ): Promise<GroupMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    // Bind message↔room BEFORE any role check or broadcast: an admin/owner of
    // group A must not delete a message that lives in group B (cross-room IDOR).
    // NotFound (not Forbidden) so foreign-message existence isn't leaked.
    if (!message || message.roomId !== roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    let deletedType = "SELF_DELETE";
    if (!bySystem) {
      const member = await this.memberRepo.findActiveByRoomAndUser(
        roomId,
        userId
      );
      if (!member) throw new BadRequestError("CHAT_NOT_A_MEMBER");
      // Only the human paths are gated — the auto-delete sweeper (bySystem)
      // must keep purging a frozen room's expired messages.
      await assertGroupWritable(this.roomRepo, roomId);

      // Same sender-less problem the private path has: a group call row carries
      // `senderId: ""`, so its owner is `content.call.callerId`. Without this a
      // plain member could not remove the call card they themselves started —
      // only an admin/moderator could, and it logged as an ADMIN_DELETE.
      const callCallerId = isCallContentType(message.messageType)
        ? (message.content as { call?: { callerId?: string } } | null)?.call
            ?.callerId
        : undefined;
      const isOwnMessage =
        message.senderId === userId || callCallerId === userId;

      if (!isOwnMessage) {
        // Only admins/moderators can delete others' messages, and a MODERATOR
        // may not delete an ADMIN's (or a peer MODERATOR's) message — same
        // outrank rule kick/mute/ban enforce. A sender who has since left the
        // group has no row: they rank as a plain MEMBER, so their leftover
        // messages stay moderatable.
        const senderMember = message.senderId
          ? await this.memberRepo.findActiveByRoomAndUser(
              roomId,
              message.senderId
            )
          : null;
        if (!canDeleteOthersMessage(member.role, senderMember?.role)) {
          throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
        }
        deletedType = "ADMIN_DELETE";
      } else {
        // Mirrors CommunityMessageService.deleteForAll: a muted member cannot
        // delete their OWN message, but an admin/mod deleting someone else's is
        // moderation and stays allowed even while that admin is muted.
        assertGroupMemberNotMuted(member);
      }
    }

    const deleted = await this.messageRepo.deleteForEveryone(
      messageId,
      message.roomId,
      userId,
      deletedType
    );
    publishAdminActivitySafe({
      // A system-driven purge (auto-delete sweeper) has no human actor.
      actorId: bySystem ? null : userId,
      actorType: bySystem ? "SYSTEM" : "USER",
      action: USER_AUDIT_ACTIONS.MESSAGE_DELETED,
      targetType: "message",
      targetId: messageId,
      after: { roomType: "GROUP", roomId, deletedType },
    });
    if (
      shouldCountInUnread({
        messageType: message.messageType,
        systemEvent: message.systemEvent,
        explicit: (message as unknown as { countInUnread?: boolean | null })
          .countInUnread,
      })
    ) {
      this.memberRepo
        .decrementUnreadForMessage({
          roomId,
          senderId: message.senderId,
          messageCreatedAt: message.createdAt,
        })
        .catch((err: unknown) => {
          logger.warn(
            `GroupMessageService|decrementUnreadForMessage failed: ${String(err)}`
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
          `GroupMessageService|refreshReplyQuotes(delete) failed: ${String(err)}`
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
      files?: unknown[];
    };
  }): Promise<GroupMessage> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // The edit route carries no roomId; derive the room from the message and
    // authorize the caller as an ACTIVE member of THAT room before any sender/
    // type/window check. A non-member (or someone not in the message's room)
    // must not mutate it — NotFound so existence isn't leaked. (cross-room IDOR)
    const editor = await this.assertActiveMemberOfMessageRoom(
      message,
      params.userId
    );
    // A muted member cannot mutate room content (Telegram: editing needs send).
    // Mirrors CommunityMessageService.editMessage.
    assertGroupMemberNotMuted(editor);
    await assertGroupWritable(this.roomRepo, message.roomId);
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
          `GroupMessageService|refreshReplyQuotes(edit) failed: ${String(err)}`
        );
      });
    this.refreshListPreviewAfterEdit(updated);
    return updated;
  }

  /**
   * GROUP half of the edit→list refresh. See
   * `PrivateMessageService.refreshListPreviewAfterEdit` for the full rationale:
   * `message:edited` only reaches `conv:<roomId>` (the open chat), and the
   * denormalized `GroupRoom.lastMessagePreview` the inbox renders was never
   * rewritten, so an edited last message stayed stale in the sidebar even
   * across a reload.
   *
   * Fire-and-forget; `setLastMessage` keeps the ORIGINAL `createdAt` so the row
   * refreshes in place instead of jumping to the top.
   */
  private refreshListPreviewAfterEdit(updated: GroupMessage): void {
    if (!this.redis) return;
    const redis = this.redis;
    void (async () => {
      const room = await this.roomRepo.findByRoomId(updated.roomId);
      if (!room || room.lastMessageId !== updated.id) return;
      const senderName =
        (updated as unknown as { senderName?: string }).senderName ?? "";
      await this.roomRepo.setLastMessage(updated.roomId, {
        id: updated.id,
        senderId: updated.senderId ?? "",
        senderName,
        content: {
          text:
            ((updated.content as Record<string, unknown> | null)
              ?.text as string) ?? "",
        },
        messageType: updated.messageType,
        createdAt: updated.createdAt,
        clientMessageId: updated.clientMessageId,
        sequenceNumber: updated.sequenceNumber,
        revision: updated.revision,
      });
      publishConvUpdatedSafe({
        redis,
        type: "GROUP",
        roomId: updated.roomId,
        fetchRecipients: () => this.getActiveMemberIds(updated.roomId),
        senderId: updated.senderId ?? "",
        senderName,
        lastMessageId: updated.id,
        lastMessageAt: updated.createdAt.getTime(),
        // An edit is not new activity: nobody's unread badge may move.
        countInUnread: false,
        preview: {
          contentType: normalizeMessageType(updated.messageType),
          text: buildMessagePreview(updated.messageType, updated.content),
          clientMessageId: updated.clientMessageId,
          seq: updated.sequenceNumber ?? 0,
          revision: updated.revision ?? 0,
          createdAt: updated.createdAt.getTime(),
        },
      });
    })().catch((err: unknown) => {
      logger.warn(
        `GroupMessageService|refreshListPreviewAfterEdit failed for ${updated.id}: ${String(err)}`
      );
    });
  }

  /**
   * Compare-and-swap toggle core, shared by `react()` and `reactToMessage()`.
   * See PrivateMessageService.reactCas for the full rationale — identical
   * CAS-retry semantics, applied here to GroupMessage.
   */
  private async reactCas(
    messageId: string,
    userId: string,
    emoji: string
  ): Promise<{ message: GroupMessage; added: boolean }> {
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
   * Toggle a single user's emoji reaction on a group message. Persists the
   * canonical `{ emoji: [{ userId, userName, avatar, memberId }] }` shape.
   * Other emojis are preserved. CAS-safe (see `reactCas`).
   */
  async react(
    messageId: string,
    userId: string,
    emoji: string
  ): Promise<GroupMessage | null> {
    const { message } = await this.reactCas(messageId, userId, emoji);
    return message;
  }

  /**
   * Same toggle as `react()`, additionally returning the WhatsApp-style
   * lastActivity metadata needed to bump/revert the conversation list —
   * mirrors PrivateMessageService.reactToMessage / CommunityMessageService.reactToMessage.
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
  ): Promise<GroupMessage | null> {
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
   * Authorize a REST react/remove-reaction: the caller MUST be an ACTIVE member
   * of the group. The shared `react()` primitive deliberately does NOT guard (the
   * socket/gRPC path is pre-authorized at join), so the REST boundary enforces
   * membership here — the same rule the read/send paths use.
   */
  async assertMember(roomId: string, userId: string): Promise<void> {
    await assertGroupMember(this.memberRepo, roomId, userId);
  }

  /**
   * {@link assertMember} plus the moderation-mute gate — for WRITE boundaries
   * only (react / remove-reaction). Kept separate from `assertMember` because
   * that one also guards pure READS (getMessageReactions, message context),
   * which a muted member keeps full access to. Mirrors Community, where the
   * react path calls `assertRoomMemberActive` + `assertCommunityMemberNotMuted`.
   *
   * @throws ForbiddenError `CHAT_MUTED_IN_GROUP` when the member is muted.
   */
  async assertCanWrite(roomId: string, userId: string): Promise<void> {
    const member = await assertGroupMember(this.memberRepo, roomId, userId);
    assertGroupMemberNotMuted(member);
    await assertGroupWritable(this.roomRepo, roomId);
  }

  /**
   * Mirrors CommunityMessageService.report() (inline reports array), plus
   * forwards to the admin moderation pipeline the way PrivateMessageService.
   * reportMessage() does — community's report() never wired that forward, so
   * a community report never reached backoffice; group's does.
   * ponytail: no dedicated report model/unique-per-reporter constraint, so a
   * user CAN report the same message twice — add PrivateMessageReport's
   * (messageId, reporterId) unique index here if duplicate-report noise
   * becomes a real moderation problem.
   */
  async report(params: {
    messageId: string;
    reporterId: string;
    reportReason: string;
    description?: string;
    /** Room from the request path — must match the message's own room. */
    roomId?: string;
  }): Promise<GroupMessage | null> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // The reported message must actually live in the conversation the caller
    // named; otherwise a member of group A could report a message in group B
    // through A's path. Membership is then checked against the message's REAL
    // room, never the path's.
    if (params.roomId && params.roomId !== message.roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    await assertGroupMember(this.memberRepo, message.roomId, params.reporterId);
    const updated = await this.messageRepo.addReport(params.messageId, {
      userReportId: params.reporterId,
      userReportReason: params.reportReason,
    });
    publishAdminReportIngestSafe({
      type: "message",
      targetId: params.messageId,
      reporterId: params.reporterId,
      reason: params.reportReason,
      details: params.description?.trim() ? params.description.trim() : null,
      communityId: null,
      reportedUserId: message.senderId ?? null,
      roomId: message.roomId,
      roomType: "GROUP",
      eventAt: new Date().toISOString(),
      sourceReportId: `group:${params.messageId}:${params.reporterId}`,
    });
    return updated;
  }

  /** Deep-gap horizon — same value and rule as community and private. */
  private readonly REVISION_RESET_HORIZON = 10_000;

  /**
   * ZERO-LOSS CHANGES FEED (REST) — `GET /api/chat/groups/rooms/:roomId/changes`.
   * Identical contract to the private equivalent; see it for the full rationale.
   *
   * NOTE for clients: per-viewer filtering happens AFTER the page slice, so
   * `items.length < limit` while `hasMore === true` is legal. Drain on `hasMore`.
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
    items: Awaited<ReturnType<GroupMessageService["enrichForWire"]>>;
  }> {
    const member = await assertGroupMember(
      this.memberRepo,
      params.roomId,
      params.userId
    );
    const changes = await this.resolveChanges({
      ...params,
      cutoff: getGroupVisibilityCutoff(member),
    });
    const items = await this.enrichForWire(changes.messages, params.userId);

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
    messages: GroupMessage[];
  }> {
    const roomRevision = await this.roomRepo.getRoomRevision(params.roomId);

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
  ): Promise<GroupMessage> {
    const member = await assertGroupMember(this.memberRepo, roomId, userId);
    const message = await this.messageRepo.findById(messageId);
    if (!message || message.roomId !== roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    if (message.isDeleted) {
      throw new GoneError("CHAT_MESSAGE_DELETED");
    }
    if (
      message.deletedForUserIds &&
      (message.deletedForUserIds as string[]).includes(userId)
    ) {
      throw new GoneError("CHAT_MESSAGE_DELETED");
    }
    const cutoff = getGroupVisibilityCutoff(member);
    if (cutoff && message.createdAt <= cutoff) {
      throw new GoneError("CHAT_MESSAGE_DELETED");
    }
    return message;
  }

  /**
   * Bind a message to its room: throw CHAT_MESSAGE_NOT_FOUND unless `messageId`
   * actually belongs to `roomId`. The `react()` primitive mutates a message by id
   * ALONE, so a REST caller who is an active member of group A could otherwise
   * pass a messageId from group B (one they're not in) and mutate/broadcast that
   * foreign message. Loading the row and asserting `roomId` matches closes that
   * cross-room IDOR; call this AFTER the member guard, BEFORE react().
   */
  async assertMessageInRoom(roomId: string, messageId: string): Promise<void> {
    const msg = await this.messageRepo.findById(messageId);
    if (!msg || msg.roomId !== roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
  }

  /** Bind a loaded message to its OWN room and require the caller to be an ACTIVE
   * member of that room (cross-room IDOR guard for paths that derive the room from
   * the message — edit, and the forward source-read). NotFound — never Forbidden —
   * so a foreign message's existence isn't leaked. */
  private async assertActiveMemberOfMessageRoom(
    message: GroupMessage,
    userId: string
  ): Promise<GroupMember> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      message.roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    return member;
  }

  async forwardMessage(params: {
    sourceMessageId: string;
    /** SOURCE room the message is being forwarded FROM (REST path param). When
     * provided, it must MATCH the message's actual room (cross-check). Null on the
     * gRPC path. Either way the caller must be an active member of the message's
     * ACTUAL room — that bind is unconditional and closes the forward read-IDOR. */
    sourceRoomId?: string | null;
    targetRoomId: string;
    senderId: string;
    senderName: string;
    senderAvatar: string;
    clientMessageId?: string | null;
  }): Promise<GroupMessage & { senderRole?: string }> {
    // check sender is active member of target room
    const member = await this.memberRepo.findActiveByRoomAndUser(
      params.targetRoomId,
      params.senderId
    );
    if (!member) throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    // A forward CREATES a message in the target room, so it is a send: a muted
    // member must not be able to route around the mute by forwarding.
    assertGroupMemberNotMuted(member);
    await assertGroupWritable(this.roomRepo, params.targetRoomId);

    // §2.2: stamp the forwarder's group role (transient) for parity with send.
    const senderRole = (member as { role?: string }).role ?? "MEMBER";
    const withRole = (m: GroupMessage): GroupMessage & { senderRole: string } =>
      Object.assign(m, { senderRole });

    // idempotency — require senderId to avoid false matches across senders
    if (params.clientMessageId) {
      const existing = await this.messageRepo.findByClientMessageId(
        params.targetRoomId,
        params.senderId,
        params.clientMessageId
      );
      if (existing) return withRole(existing);
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
    // could exfiltrate any message from a group they're not in. Closes the cross-room read-IDOR.
    await this.assertActiveMemberOfMessageRoom(source, params.senderId);

    const forwardData = {
      originalMessageId: source.id,
      originalRoomId: source.roomId,
      originalSenderId: source.senderId ?? "",
      originalCreatedAt: source.createdAt.toISOString(),
      originalContentType: source.messageType,
    };

    // A forward is a brand-new message in the TARGET room, so it follows THAT
    // room's timer — never the source room's.
    const targetSlot = await this.roomRepo.allocateSequenceWithRoom(
      params.targetRoomId
    );
    const autoDelete = this.autoDeleteStampFromRoom(targetSlot.room);

    const message = await this.messageRepo.createForwardedMessage({
      roomId: params.targetRoomId,
      senderId: params.senderId,
      senderName: params.senderName,
      senderAvatar: params.senderAvatar,
      content: source.content as object,
      messageType: source.messageType,
      forwardData,
      clientMessageId: params.clientMessageId ?? null,
      sequenceNumber: targetSlot.sequenceNumber,
      autoDeleteAt: autoDelete.autoDeleteAt,
      autoDeleteAfterView: autoDelete.autoDeleteAfterView,
    });
    const unreadIncrement = shouldCountInUnread({
      messageType: message.messageType,
      systemEvent: message.systemEvent,
      explicit: (message as unknown as { countInUnread?: boolean | null })
        .countInUnread,
    })
      ? 1
      : 0;

    // update room last message (fire and forget)
    const messageContent = (message.content ?? {}) as Record<string, unknown>;
    this.roomRepo
      .updateLastMessage(params.targetRoomId, {
        _id: message.id,
        senderId: message.senderId ?? null,
        senderName: message.senderName,
        messageType: message.messageType,
        content: { text: (messageContent.text as string) || "" },
        createdAt: message.createdAt,
        clientMessageId: message.clientMessageId,
        sequenceNumber: message.sequenceNumber,
        revision: message.revision,
      })
      .catch((err: unknown) => {
        logger.warn(
          `GroupMessageService|forwardMessage|updateLastMessage failed: ${String(err)}`
        );
      });

    if (unreadIncrement > 0) {
      try {
        await this.memberRepo.incUnreadForRoom(
          params.targetRoomId,
          params.senderId,
          unreadIncrement
        );
      } catch (err: unknown) {
        logger.warn(
          `GroupMessageService|forwardMessage|incUnreadForRoom failed: ${String(err)}`
        );
      }
    }

    return withRole(message);
  }

  /**
   * Reconnect gap-fill for a group room: returns messages with
   * sequenceNumber > sinceSeq. Includes tombstones (no isDeleted filter) so the
   * client can reconcile deletes/edits missed while offline. Authorizes via the
   * same active-membership check used by sendMessage.
   *
   * When `sinceRevision` is set the room switches to the ZERO-LOSS revision axis
   * instead — see the private equivalent for the full contract.
   */
  async catchup(p: {
    roomId: string;
    userId: string;
    sinceSeq: number;
    sinceRevision?: number;
    limit: number;
  }): Promise<{
    authorized: boolean;
    events: GroupMessage[];
    hasMore: boolean;
    lastSeq: number;
    lastRevision: number;
    roomRevision: number;
    resetRequired: boolean;
  }> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      p.roomId,
      p.userId
    );
    if (!member) {
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

    const cutoff = getGroupVisibilityCutoff(member);

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
    // deletedForUserIds shape: string[] (array of userId strings)
    const events = rawEvents.filter((m) => {
      const raw = m as unknown as { deletedForUserIds?: unknown };
      const deletedForUserIds = (raw.deletedForUserIds ?? []) as string[];
      if (deletedForUserIds.includes(p.userId)) return false;
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

  /**
   * Resolve a group message's per-room `sequenceNumber` from its id. Used by the
   * read_sync fan-out. Returns 0 if the message is missing.
   */
  async getMessageSequence(messageId: string): Promise<number> {
    if (!messageId) return 0;
    const msg = await this.messageRepo.findById(messageId);
    const seq = (msg as { sequenceNumber?: number } | null)?.sequenceNumber;
    return typeof seq === "number" ? seq : 0;
  }

  /** Absolute per-member unread for a group room — used on conv:updated. */
  async getUnreadCountsByUser(roomId: string): Promise<Record<string, number>> {
    const members = await this.memberRepo.findActiveMembers(roomId);
    const out: Record<string, number> = {};
    for (const m of members) out[m.userId] = m.unreadCount ?? 0;
    return out;
  }

  /**
   * Every other member's DELIVERED watermark, the parallel signal to
   * {@link getMemberReadCursors} for the grey ✓✓ tier. `GroupMessage.deliveredTo`
   * is already persisted (presence at insert + presence-connect backfill + the
   * client ack below), but the history serializer strips it off the wire — without
   * this the sender's group ticks collapse to a single ✓ on every relaunch, exactly
   * the bug memberReadSeq fixed for the blue tier.
   */
  async getMemberDeliveredCursors(
    roomId: string,
    userId: string
  ): Promise<Record<string, number>> {
    return this.messageRepo.getMemberDeliveredSeqs(roomId, userId);
  }

  /**
   * Client-initiated delivery ack for a group room (socket `message:delivered`).
   * The presence paths cover "member was online at send" and "member reconnected";
   * this covers the recipient confirming receipt itself. Same repo primitive, so
   * all three converge on one forward-only `deliveredTo` append.
   */
  async markDelivered(params: {
    roomId: string;
    recipientId: string;
    upToMessageId: string;
  }): Promise<{ count: number; messageIds: string[] }> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.recipientId
    );
    if (!member) return { count: 0, messageIds: [] };
    return this.messageRepo.markDeliveredUpTo(
      params.roomId,
      params.recipientId,
      params.upToMessageId
    );
  }

  /**
   * Every OTHER active member's current read high-water mark, as a
   * sequenceNumber, keyed by userId. Used to hydrate per-message "seen by" /
   * read-count state on the INITIAL page load (group has no single "peer" —
   * unlike private's `getPeerReadSeq` — so the FE compares each message's
   * `sequenceNumber` against every other member's cursor here to know who has
   * read it, without waiting for a live `message:read` event).
   */
  async getMemberReadCursors(
    roomId: string,
    excludeUserId: string
  ): Promise<Record<string, number>> {
    const members = await this.memberRepo.findActiveMembers(roomId);
    const others = members.filter(
      (m) => m.userId !== excludeUserId && m.lastReadMessageId
    );
    const uniqueMessageIds = [
      ...new Set(others.map((m) => m.lastReadMessageId as string)),
    ];
    const seqById = new Map<string, number>();
    await Promise.all(
      uniqueMessageIds.map(async (id) => {
        seqById.set(id, await this.getMessageSequence(id));
      })
    );
    const cursors: Record<string, number> = {};
    for (const m of others) {
      cursors[m.userId] = seqById.get(m.lastReadMessageId as string) ?? 0;
    }
    return cursors;
  }

  /**
   * Per-message "Viewed by" sheet for a GROUP message. Sender-only.
   *
   * Only ACTIVE members are considered, so a member who left, was kicked or was
   * banned disappears from the sheet (`findActiveMembers` is the same roster the
   * ticks and typing fan-out use). `getMessageContext` supplies the membership
   * guard plus the deleted/cleared checks.
   */
  async getReadReceipts(
    roomId: string,
    messageId: string,
    userId: string
  ): Promise<ReadReceiptsPayload> {
    const message = await this.getMessageContext(roomId, messageId, userId);
    if (message.senderId !== userId)
      throw new ForbiddenError("CHAT_NOT_MESSAGE_SENDER");
    await assertMaySeeReadReceipts(userId);

    const members = (await this.memberRepo.findActiveMembers(roomId)).filter(
      (m) => m.userId !== userId && m.lastReadMessageId
    );
    const uniqueReadIds = [
      ...new Set(members.map((m) => m.lastReadMessageId as string)),
    ];
    const seqById = new Map(
      (await this.messageRepo.findManyByIds(uniqueReadIds)).map((m) => [
        m.id,
        (m as { sequenceNumber?: number }).sequenceNumber ?? 0,
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

  /**
   * Explicit "mark read up to `upToMessageId`" action — the REST/gRPC
   * mark-read entry point. Routes through the SAME guarded, forward-only,
   * accurate-unread pointer advance (`memberRepo.advanceReadPointer`) that
   * `getConversation`'s implicit fetch-triggered mark-read already uses, so
   * both paths share one update rule instead of two divergent ones (the old
   * `GroupMemberRepository#markRead` hard-zeroed unread and had no
   * forward-only check or optimistic-id guard).
   */
  /**
   * The auto-delete stamp a message sent into `room` right now must carry.
   * Never throws — a malformed stored setting degrades to "no timer" rather
   * than failing the send.
   */
  private autoDeleteStampFromRoom(room: {
    roomId: string;
    autoDelete?: unknown;
  }): AutoDeleteStamp {
    try {
      return computeAutoDeleteStamp(readRoomAutoDelete(room), new Date());
    } catch (err) {
      logger.warn(
        `GroupMessageService|autoDeleteStampFromRoom failed room=${room.roomId}: ${String(err)}`
      );
      return AUTO_DELETE_NONE;
    }
  }

  // NOTE — there is deliberately no `armAfterViewingMessages` here.
  //
  // Group AFTER_VIEWING is unsupported (see GroupAutoDeleteService), so a group
  // read must never arm anything. The removed version also ran BEFORE the
  // target was validated and was bounded by nothing but the room, so a single
  // read receipt started the countdown on every unarmed message in the group,
  // including ones the reader had never scrolled to.

  async markReadUpTo(params: {
    roomId: string;
    userId: string;
    upToMessageId: string;
  }): Promise<{ readToSeq: number; remainingUnread: number }> {
    if (!isObjectId(params.upToMessageId))
      return { readToSeq: 0, remainingUnread: 0 };

    const member = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member) return { readToSeq: 0, remainingUnread: 0 };

    const message = await this.messageRepo.findById(params.upToMessageId);
    if (!message || message.roomId !== params.roomId)
      return { readToSeq: 0, remainingUnread: 0 };

    const remainingUnread = await this.messageRepo
      .countUnreadAfter({
        roomId: params.roomId,
        userId: params.userId,
        afterDate: message.createdAt,
        cutoff: getGroupVisibilityCutoff(member),
      })
      .catch((err: unknown) => {
        logger.warn(
          `GroupMessageService|markReadUpTo|countUnreadAfter failed: ${String(err)}`
        );
        return 0;
      });

    // `advanceReadPointer` is forward-only: it returns the row it left behind,
    // which is the UNCHANGED member row when the request was stale (a second
    // device catching up, a jump-to-message landing on old history). Report the
    // ACCEPTED watermark, never the requested target — publishing the request's
    // own seq would broadcast a regression the DB never made and hand the
    // reader's other devices an inflated unread count.
    const updated = await this.memberRepo.advanceReadPointer(
      params.roomId,
      params.userId,
      message.id,
      message.createdAt,
      remainingUnread
    );
    const seq = (message as { sequenceNumber?: number }).sequenceNumber ?? 0;
    const acceptedId = updated?.lastReadMessageId;
    // No stored pointer at all = this member's FIRST read, which forward-only
    // cannot have refused, so the requested target IS the accepted watermark.
    if (!acceptedId || acceptedId === message.id)
      return {
        readToSeq: seq,
        remainingUnread: updated?.unreadCount ?? remainingUnread,
      };

    return {
      readToSeq: await this.getMessageSequence(acceptedId).catch(() => 0),
      remainingUnread: updated?.unreadCount ?? remainingUnread,
    };
  }

  /**
   * "Viewed list" for one group message — every active member (excluding the
   * sender) whose read cursor has reached this message's sequenceNumber.
   * Same high-water-mark rule as getMemberReadCursors, just inverted per message.
   */
  async getMessageReadBy(params: {
    roomId: string;
    messageId: string;
    requesterId: string;
  }): Promise<{
    readBy: {
      userId: string;
      displayName: string;
      avatar: string;
      readAt: number | null;
    }[];
    totalMembers: number;
  }> {
    const requester = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.requesterId
    );
    if (!requester) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    const message = await this.messageRepo.findById(params.messageId);
    if (!message || message.roomId !== params.roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const messageSeq =
      (message as { sequenceNumber?: number }).sequenceNumber ?? 0;

    const members = await this.memberRepo.findActiveMembers(params.roomId);
    const candidates = members.filter(
      (m) => m.userId !== message.senderId && m.lastReadMessageId
    );

    const seqById = new Map<string, number>();
    await Promise.all(
      [...new Set(candidates.map((m) => m.lastReadMessageId as string))].map(
        async (id) => {
          seqById.set(id, await this.getMessageSequence(id));
        }
      )
    );

    const readers = candidates.filter((m) => {
      const seq = seqById.get(m.lastReadMessageId as string) ?? 0;
      return messageSeq > 0
        ? seq >= messageSeq
        : !!m.lastReadAt && m.lastReadAt >= message.createdAt;
    });

    const snapshots =
      readers.length > 0
        ? await this.userSnapshotService.getUserSnapshotsMap(
            readers.map((m) => m.userId),
            this.cacheRepo
          )
        : new Map<string, Record<string, unknown>>();

    const urlMap = await resolveMediaUrlMap(
      [...snapshots.values()].map((s) => (s.avatar as string) || "")
    );

    return {
      readBy: readers.map((m) => {
        const snap = snapshots.get(m.userId) ?? {};
        return {
          userId: m.userId,
          displayName: resolveDisplayName(snap),
          avatar: urlFromMap(urlMap, (snap.avatar as string) || ""),
          readAt: m.lastReadAt ? new Date(m.lastReadAt).getTime() : null,
        };
      }),
      totalMembers: members.filter((m) => m.userId !== message.senderId).length,
    };
  }

  /**
   * The reactor list for one group message — userId + displayName + avatar of
   * everyone who reacted, i.e. a roster disclosure, so it takes the same guard
   * as every other group read: `assertGroupReadAccess` (ACTIVE members, plus
   * LEFT/KICKED members capped at their cutoff), then the message bound to the
   * room and clamped to that cutoff.
   *
   * It previously ran no check at all and ignored `params.roomId` entirely, so a
   * bare `messageId` returned the reactors of any group message to any
   * authenticated caller.
   */
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
    const { readCutoffBefore } = await assertGroupReadAccess(
      this.memberRepo,
      params.roomId,
      params.requesterId
    );
    const message = await this.messageRepo.findById(params.messageId);
    // NotFound, never Forbidden — a foreign message's existence isn't leaked.
    if (!message || message.roomId !== params.roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (readCutoffBefore && message.createdAt > readCutoffBefore)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

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

    // Resolve reactor avatar keys → download URLs on read (one batch, deduped).
    const urlMap = await resolveMediaUrlMap(
      [...snapshots.values()].map((s) => (s.avatar as string) || "")
    );

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
            displayName: resolveDisplayName(snap),
            avatar: urlFromMap(urlMap, (snap.avatar as string) || ""),
          };
        }),
      };
    }

    return { reactions: result };
  }

  /**
   * Serialize a page of group messages to the canonical client wire shape with
   * resolve-on-read media. Group rows denormalize senderName/senderAvatar, so
   * unlike the private path no user-snapshot fan-out is needed — but the stored
   * `senderAvatar`, `content.files[].objectKey`, and reaction-user avatars are
   * raw MinIO object keys. Collect every key on the page ONCE, presign via
   * {@link resolveMediaUrlMap}, then stamp each row synchronously so the FE never
   * receives a raw key (URLs are derived at read time, never persisted).
   */
  async enrichForWire(
    messages: GroupMessage[],
    viewerUserId?: string
  ): Promise<Array<Record<string, unknown>>> {
    const mediaKeys: string[] = [];
    for (const message of messages) {
      if (message.senderAvatar) mediaKeys.push(message.senderAvatar);
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
      // Reaction-user avatars live inside the stored `{ emoji: [{ avatar }] }`
      // map; collect them so they can be stamped in place (shape preserved).
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
      const quote = message.quoteData as Record<string, unknown> | null;
      if (typeof quote?.thumbnail === "string" && quote.thumbnail) {
        mediaKeys.push(quote.thumbnail);
      }
    }
    // Group rows freeze `senderName`/`senderAvatar` at send time, so a sender
    // who later deleted their account would keep their old name on every
    // historical message. Resolve which of the page's participants are deleted
    // (one batched, Redis-cached snapshot lookup) and scrub them below —
    // stored rows are never rewritten.
    const deletedUserIds = await collectDeletedUserIds(
      messages.flatMap((m) =>
        collectRowUserIds(m as unknown as Record<string, unknown>)
      ),
      this.userSnapshotService,
      this.cacheRepo
    );

    const urlMap = await resolveMediaUrlMap(mediaKeys);

    return messages.map((message) => {
      // §1: canonical wire shape — drops the internal `messageType` column and
      // exposes UPPER-CASE `contentType`, identical to the socket message:new.
      const wire = toWireMessage(
        message as { messageType?: string | null }
      ) as unknown as Record<string, unknown>;
      wire.countInUnread = shouldCountInUnread({
        messageType: message.messageType,
        systemEvent: message.systemEvent,
        explicit: (message as unknown as { countInUnread?: boolean | null })
          .countInUnread,
      });

      if (typeof wire.senderAvatar === "string") {
        wire.senderAvatar = urlFromMap(urlMap, wire.senderAvatar);
      }

      // Normalized tombstone (one shape across private/group/community) — the
      // raw isDeleted/deletedAt/deletedType columns stay on the wire untouched.
      Object.assign(wire, tombstoneWireFields(message));

      // Stamp resolved download URLs onto attachment files (content.files[])
      // and the sticker sub-object (content.sticker) — the latter lives
      // outside `files[]` and is otherwise never resolve-on-read.
      const content = wire.content as Record<string, unknown> | null;
      if (content) {
        wire.content = {
          ...content,
          ...(Array.isArray(content.files)
            ? {
                files: applyUrlMapToFiles(
                  content.files as MediaFileLike[],
                  urlMap
                ),
              }
            : {}),
          ...(content.sticker && typeof content.sticker === "object"
            ? {
                sticker: resolveStickerField(
                  content.sticker as MediaFileLike,
                  urlMap
                ),
              }
            : {}),
        };
      }

      // Canonical client-facing reaction shape (FE reads `reactionGroups[]`); the
      // raw `reactions` map resolved below is kept for backward compat but deprecated.
      wire.reactionGroups = buildReactionGroups(wire.reactions, (key) =>
        urlFromMap(urlMap, key)
      );

      // Stamp reaction-user avatars in place, preserving the stored map shape
      // (`{ emoji: [{ userId, userName, avatar, … }] }`) the group read path
      // returns — only the raw `avatar` key is swapped for its resolved URL.
      const reactions = wire.reactions as Record<string, unknown> | null;
      if (reactions && typeof reactions === "object") {
        const resolvedReactions: Record<string, unknown> = {};
        for (const [emoji, reactors] of Object.entries(reactions)) {
          resolvedReactions[emoji] = Array.isArray(reactors)
            ? reactors.map((reactor) => {
                const r = (reactor ?? {}) as Record<string, unknown>;
                return typeof r.avatar === "string" && r.avatar
                  ? { ...r, avatar: urlFromMap(urlMap, r.avatar) }
                  : reactor;
              })
            : reactors;
        }
        wire.reactions = resolvedReactions;
      }

      wire.conversationType = "GROUP";
      wire.quoteData = resolveQuoteThumbnail(
        buildCanonicalQuote(wire.quoteData),
        urlMap
      );
      wire.clientTs = Number(
        (wire.clientInfo as Record<string, unknown> | null)?.clientTs ?? 0
      );
      wire.serverTs =
        message.createdAt instanceof Date ? message.createdAt.getTime() : 0;

      // Replaces the frozen senderName/senderAvatar (and the quoted-message
      // preview's) for deleted accounts, and stamps `isDeletedUser` on every
      // row so the client gates profile navigation off a flag, not a string.
      anonymizeWireSender(wire, deletedUserIds);

      if (String(wire.contentType).toUpperCase() === "SYSTEM") {
        const rawSystemData = (message.systemData ?? {}) as Record<
          string,
          unknown
        >;
        // "Alice added Bob" must become "Alice added Deleted Account" once Bob
        // is gone. The names are baked into systemData at write time, but the
        // TEXT is rebuilt from them on every read — so scrubbing the data here
        // is enough, with no stored-row rewrite.
        const systemData = anonymizeSystemData(rawSystemData, deletedUserIds);
        const content = wire.content as Record<string, unknown> | null;
        const thirdPersonText = String(content?.text ?? "");
        if (message.systemEvent && content) {
          // Two entry points on purpose. `personalize…` short-circuits to the
          // STORED text whenever there is no viewer and the locale is English —
          // correct normally, wrong here, because the stored text is precisely
          // what still contains the deleted user's name. So a scrubbed
          // systemData goes straight to the builder, which always re-renders.
          const rebuilt =
            systemData === rawSystemData
              ? personalizeGroupSystemMessageForViewer(
                  message.systemEvent,
                  systemData,
                  thirdPersonText,
                  viewerUserId ?? "",
                  currentLocale()
                )
              : buildGroupSystemFallbackText(
                  message.systemEvent,
                  systemData,
                  viewerUserId ?? "",
                  currentLocale()
                );
          if (rebuilt && rebuilt !== thirdPersonText) {
            wire.content = { ...content, text: rebuilt };
          }
        }
      }

      return wire;
    });
  }
}
