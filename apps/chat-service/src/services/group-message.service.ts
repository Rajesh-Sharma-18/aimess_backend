import {
  BadRequestError,
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
import { personalizeGroupSystemMessageForViewer } from "@aimess/constants";
import {
  normalizeMessageType,
  buildCanonicalQuote,
  buildReplyQuoteSnapshot,
  buildReplyPreviewText,
  buildReactionGroups,
  reactionUserIdMap,
  toggleStoredReaction,
  toWireMessage,
  type CanonicalQuote,
} from "../lib/chat-message.serializer.js";
import { assertGroupMember } from "../lib/access-guard.js";
import {
  computeSeqAroundCursors,
  type AroundCursors,
} from "../lib/around-cursors.js";
import { isDuplicateKeyError } from "../lib/db-errors.js";
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
  resolveQuoteThumbnail,
  resolveStickerField,
  type MediaFileLike,
} from "../lib/media-resolve.js";
import { shouldCountInUnread } from "../lib/unread-count.js";

import type { GroupMessageRepository } from "../repositories/group-message.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { GroupMessage } from "../generated/prisma/index.js";

export class GroupMessageService {
  constructor(
    private readonly messageRepo: GroupMessageRepository,
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService
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

    // Verify membership
    const member = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.senderId
    );
    if (!member) throw new BadRequestError("CHAT_NOT_A_MEMBER");

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

    const created: GroupMessage[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const entity: Record<string, unknown> = {
        roomId: params.roomId,
        senderId: params.senderId,
        senderName: params.senderName,
        senderAvatar: params.senderAvatar,
        content: part.content,
        messageType: normalizeMessageType(part.messageType),
        parentMessageId: resolvedParentId,
        clientMessageId: part.clientMessageId || null,
        ...(i === 0 && params.clientTs
          ? { clientInfo: { clientTs: params.clientTs } }
          : {}),
        ...(i === 0 && quoteData ? { quoteData } : {}),
      };

      const seq = await this.roomRepo.allocateSequence(params.roomId);
      entity.sequenceNumber = seq;

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
    this.roomRepo
      .updateLastMessage(params.roomId, {
        _id: message.id,
        senderId: message.senderId ?? null,
        senderName: message.senderName,
        messageType: message.messageType,
        content: { text: (messageContent.text as string) || "" },
        createdAt: message.createdAt,
      })
      .catch((err: unknown) => {
        logger.warn(
          `GroupMessageService|updateLastMessage failed: ${String(err)}`
        );
      });

    const unreadIncrement = created.filter((m) =>
      shouldCountInUnread({
        messageType: m.messageType,
        systemEvent: m.systemEvent,
        explicit: (m as unknown as { countInUnread?: boolean | null })
          .countInUnread,
      })
    ).length;
    if (unreadIncrement > 0) {
      this.memberRepo
        .incUnreadForRoom(params.roomId, params.senderId, unreadIncrement)
        .catch((err: unknown) => {
          logger.warn(
            `GroupMessageService|incUnreadForRoom failed: ${String(err)}`
          );
        });
    }
    return withRole(attachAlbumMessages(message, created));
  }

  /**
   * Active member userIds for a group room — the recipient list for inbox
   * "bump-to-top" (`conv:updated`) fan-out.
   */
  async getActiveMemberIds(roomId: string): Promise<string[]> {
    const members = await this.memberRepo.findActiveMembers(roomId);
    return members.map((m) => m.userId);
  }

  async getMessages(params: {
    roomId: string;
    userId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<GroupMessage[]> {
    await assertGroupMember(this.memberRepo, params.roomId, params.userId);
    const beforeTimestamp = params.cursor || new Date().toISOString();
    return this.messageRepo.findByRoomIdWithTime(
      params.roomId,
      beforeTimestamp,
      params.limit,
      params.userId
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
  }> {
    await assertGroupMember(this.memberRepo, params.roomId, params.userId);
    const [{ messages: items, hasMore }, total] = await Promise.all([
      this.messageRepo.findByRoomIdTimeline({
        userId: params.userId,
        roomId: params.roomId,
        direction: params.direction,
        ts: params.ts,
        boundaryId: params.boundaryId ?? null,
        inclusive: params.inclusive ?? false,
        limit: params.limit,
      }),
      this.messageRepo.countTimeline({
        roomId: params.roomId,
        userId: params.userId,
      }),
    ]);

    // The repo returns the page in DB order (before → newest-first, after →
    // oldest-first); the boundary for the next page is the LAST row either way.
    // nextCursor is a COMPOUND "<createdAtMs>_<id>" keyset cursor — the _id
    // tiebreaker is what keeps same-millisecond messages reachable. The client
    // feeds it back verbatim as the next before_ts/after_ts.
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last ? `${last.createdAt.getTime()}_${last.id}` : null;

    return { items, hasMore, nextCursor, total };
  }

  /**
   * V2 §3.2: seq-keyset page. `nextCursor` is the boundary `sequenceNumber`.
   */
  async getMessagesSeq(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    seq: number;
    limit: number;
  }): Promise<{
    items: GroupMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    await assertGroupMember(this.memberRepo, params.roomId, params.userId);
    const rows = await this.messageRepo.findByRoomIdSeq({
      userId: params.userId,
      roomId: params.roomId,
      direction: params.direction,
      seq: params.seq,
      limit: params.limit,
    });
    const hasMore = rows.length > params.limit;
    const items = rows.slice(0, params.limit);
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? String(last.sequenceNumber) : null;
    return { items, hasMore, nextCursor };
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
    await assertGroupMember(this.memberRepo, params.roomId, params.userId);
    const anchor = await this.messageRepo.findById(params.messageId);
    if (!anchor) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    const items = await this.messageRepo.findAroundSeq({
      userId: params.userId,
      roomId: params.roomId,
      anchorSeq: anchor.sequenceNumber,
      limit: params.limit,
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

    const beforeMs = params.timestamp ?? Date.now();
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
    // Recompute remaining unread (messages still newer than the new pointer that
    // are visible to this user) so viewing an old page doesn't wrongly zero unread.
    const newest = messages[0];
    if (newest) {
      const remainingUnread = await this.messageRepo
        .countUnreadAfter({
          roomId: params.roomId,
          userId: params.userId,
          afterDate: newest.createdAt,
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
    skip?: number;
  }): Promise<GroupMessage[]> {
    await assertGroupMember(this.memberRepo, params.roomId, params.userId);
    return this.messageRepo.searchByText(
      params.roomId,
      params.query,
      params.limit,
      params.userId,
      params.skip ?? 0
    );
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
    return this.messageRepo.countSearchResults(roomId, query, userId);
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
      });
      return {
        prevMessageId: prev.id,
        messageType: prev.messageType,
        content: prev.content,
        senderId: prev.senderId ?? null,
        senderName: prev.senderName ?? "",
        createdAt: prev.createdAt,
        hasLastMessage: true,
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

    return this.messageRepo.deleteForMe(messageId, userId);
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
    wasEffectiveLast: boolean;
  } | null> {
    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room) return null;
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
        messageType: prev.messageType,
        content: prev.content,
        senderId: prev.senderId ?? null,
        senderName: prev.senderName ?? "",
        createdAt: prev.createdAt,
        hasLastMessage: true,
        wasEffectiveLast,
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
    };
  }

  async deleteMessage(
    messageId: string,
    userId: string,
    roomId: string
  ): Promise<GroupMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    // Bind message↔room BEFORE any role check or broadcast: an admin/owner of
    // group A must not delete a message that lives in group B (cross-room IDOR).
    // NotFound (not Forbidden) so foreign-message existence isn't leaked.
    if (!message || message.roomId !== roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new BadRequestError("CHAT_NOT_A_MEMBER");

    let deletedType = "SELF_DELETE";
    if (message.senderId !== userId) {
      // Only admins can delete others' messages
      if (!["OWNER", "ADMIN", "MODERATOR"].includes(member.role)) {
        throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
      }
      deletedType = "ADMIN_DELETE";
    }

    const deleted = await this.messageRepo.deleteForEveryone(
      messageId,
      userId,
      deletedType
    );
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
    await this.assertActiveMemberOfMessageRoom(message, params.userId);
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
    return updated;
  }

  /**
   * Toggle a single user's emoji reaction on a group message. Reads the stored
   * reactor map, flips `userId`'s membership in the `emoji` bucket (add on first
   * react, remove on a duplicate react = toggle-off), and persists the canonical
   * `{ emoji: [{ userId, userName, avatar, memberId }] }` shape. Other emojis are
   * preserved.
   */
  async react(
    messageId: string,
    userId: string,
    emoji: string
  ): Promise<GroupMessage | null> {
    const raw = await this.messageRepo.getReactions(messageId);
    if (raw === null) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    const updated = toggleStoredReaction(raw, userId, emoji);
    return this.messageRepo.addReactions(messageId, updated);
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

  async getMessageContext(
    roomId: string,
    messageId: string,
    userId: string
  ): Promise<GroupMessage> {
    await assertGroupMember(this.memberRepo, roomId, userId);
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
  ): Promise<void> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      message.roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
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

    const seq = await this.roomRepo.allocateSequence(params.targetRoomId);

    const message = await this.messageRepo.createForwardedMessage({
      roomId: params.targetRoomId,
      senderId: params.senderId,
      senderName: params.senderName,
      senderAvatar: params.senderAvatar,
      content: source.content as object,
      messageType: source.messageType,
      forwardData,
      clientMessageId: params.clientMessageId ?? null,
      sequenceNumber: seq,
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
      })
      .catch((err: unknown) => {
        logger.warn(
          `GroupMessageService|forwardMessage|updateLastMessage failed: ${String(err)}`
        );
      });

    if (unreadIncrement > 0) {
      this.memberRepo
        .incUnreadForRoom(params.targetRoomId, params.senderId, unreadIncrement)
        .catch((err: unknown) => {
          logger.warn(
            `GroupMessageService|forwardMessage|incUnreadForRoom failed: ${String(err)}`
          );
        });
    }

    return withRole(message);
  }

  /**
   * Reconnect gap-fill for a group room: returns messages with
   * sequenceNumber > sinceSeq. Includes tombstones (no isDeleted filter) so the
   * client can reconcile deletes/edits missed while offline. Authorizes via the
   * same active-membership check used by sendMessage.
   */
  async catchup(p: {
    roomId: string;
    userId: string;
    sinceSeq: number;
    limit: number;
  }): Promise<{
    authorized: boolean;
    events: GroupMessage[];
    hasMore: boolean;
    lastSeq: number;
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
      };
    }

    const rows = await this.messageRepo.findAfterSeq(
      p.roomId,
      p.sinceSeq,
      p.limit
    );
    const hasMore = rows.length > p.limit;
    const rawEvents = hasMore ? rows.slice(0, p.limit) : rows;

    // Exclude messages the requesting user hid with "delete for me".
    // deletedForUserIds shape: string[] (array of userId strings)
    const events = rawEvents.filter((m) => {
      const raw = m as unknown as { deletedForUserIds?: unknown };
      const deletedForUserIds = (raw.deletedForUserIds ?? []) as string[];
      return !deletedForUserIds.includes(p.userId);
    });

    const lastSeq = events.length
      ? events[events.length - 1]!.sequenceNumber
      : p.sinceSeq;

    return { authorized: true, events, hasMore, lastSeq };
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
    const reactions = reactionUserIdMap(raw);
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
            displayName:
              (snap.displayName as string) ?? (snap.memberId as string) ?? "",
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
          const key = fileMediaKey(file as MediaFileLike);
          if (key) mediaKeys.push(key);
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

      if (
        viewerUserId &&
        String(wire.contentType).toUpperCase() === "SYSTEM" &&
        message.systemEvent
      ) {
        const systemData = (message.systemData ?? {}) as Record<
          string,
          unknown
        >;
        const content = wire.content as Record<string, unknown> | null;
        const thirdPersonText = String(content?.text ?? "");
        const personalized = personalizeGroupSystemMessageForViewer(
          message.systemEvent,
          systemData,
          thirdPersonText,
          viewerUserId
        );
        if (personalized !== thirdPersonText && content) {
          wire.content = { ...content, text: personalized };
        }
      }

      return wire;
    });
  }
}
