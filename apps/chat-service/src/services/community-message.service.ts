import { logger } from "@aimess/logger";
import {
  BadRequestError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from "@aimess/errors";

import {
  CHAT_EDIT_WINDOW_MS,
  CHAT_TEXT_MAX_CHARS,
  assertAttachmentsValid,
} from "../constants/media-limits.js";
import { env } from "../config/env.js";

import type { GeneralRoomMessageRepository } from "../repositories/general-room-message.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { GeneralRoomMessage } from "../generated/prisma/index.js";
import { groupStoredReactions } from "../lib/chat-message.serializer.js";
import { communityMessagePreview } from "../utils/community-message-preview.js";

/** Per-community chat summary for the GET /communities/mine enrichment. */
export interface CommunityChatSummary {
  communityId: string;
  unreadMessageCount: number;
  /** false => the caller should render lastMessageActivity as null. */
  hasLastMessage: boolean;
  lastMessage?: {
    username: string;
    message: string;
    /** epoch ms */
    dateTime: number;
  };
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
    private readonly userSnapshotService: UserSnapshotService
  ) {}

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
  }): Promise<GeneralRoomMessage> {
    // Defensive caps (the gRPC/socket send path doesn't run the Zod validators).
    if ((params.message?.length ?? 0) > CHAT_TEXT_MAX_CHARS) {
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    }
    assertAttachmentsValid(params.messageType, params.attachments);

    // Guard: block sends to suspended or deactivated rooms. "suspended" means
    // the community was closed by an admin; "inactive" means it was deleted.
    // This check runs before idempotency so a suspended-community retry never
    // returns a previously-cached message as if the send succeeded.
    const room = await this.roomRepo.findRoomById(params.roomId);
    if (!room || room.status !== "active") {
      if (room?.status === "suspended") {
        throw new ForbiddenError("COMMUNITY_SUSPENDED");
      }
      throw new ForbiddenError("COMMUNITY_CHAT_DISABLED");
    }

    // Check idempotency
    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.sentBy}:${params.clientMessageId}`;
      const cachedId = await this.cacheRepo.getMessageIdempotency(idemKey);
      if (cachedId) {
        const cached = await this.messageRepo.findById(cachedId);
        if (cached) return cached;
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
        return existing;
      }
    }

    const entity: Record<string, unknown> = {
      roomId: params.roomId,
      sentBy: params.sentBy,
      senderName: params.senderName,
      senderAvatar: params.senderAvatar,
      message: params.message || "",
      messageType: params.messageType || "text",
      parentMessageId: params.parentMessageId || null,
      clientMessageId: params.clientMessageId || null,
    };

    if (params.attachments?.length) {
      entity.attachments = params.attachments;
    }

    // If reply, attach quote data
    if (params.parentMessageId) {
      const originalMsg = await this.messageRepo.findById(
        params.parentMessageId
      );
      if (originalMsg) {
        entity.quoteData = {
          message: originalMsg.message,
          senderName: originalMsg.senderName,
        };
      }
    }

    let message: GeneralRoomMessage;
    try {
      message = await this.messageRepo.save(
        entity as Parameters<typeof this.messageRepo.save>[0]
      );
    } catch (err) {
      // P2002 = unique constraint violation from the sparse idempotency index
      const pe = err as { code?: string };
      if (pe?.code === "P2002" && params.clientMessageId) {
        const dup = await this.messageRepo.findOne({
          roomId: params.roomId,
          sentBy: params.sentBy,
          clientMessageId: params.clientMessageId,
        });
        if (dup) return dup;
      }
      throw err;
    }

    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.sentBy}:${params.clientMessageId}`;
      this.cacheRepo.setMessageIdempotency(idemKey, message.id).catch(() => {});
    }

    // Update room last message
    this.roomRepo
      .addLastestMessageToRoom(params.roomId, {
        _id: message.id,
        sentBy: message.sentBy,
        senderName: message.senderName || "",
        message: message.message || "",
        messageType: message.messageType,
        createdAt: message.createdAt,
      })
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|addLastestMessageToRoom failed: ${String(err)}`
        );
      });
    return message;
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
    limit: number;
  }): Promise<{
    events: GeneralRoomMessage[];
    hasMore: boolean;
    lastId: string;
    nextTs: number;
    authorized: boolean;
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
      };
    }

    const limit = Math.min(Math.max(params.limit || 100, 1), 200);

    // since_ts mode: updatedAt-based query that catches all mutation types.
    if (params.sinceTs) {
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
    return { events: messages, hasMore, lastId, nextTs: 0, authorized: true };
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
   * Bulk community-chat summaries for GET /communities/mine. For each requested
   * communityId (roomId === communityId): unread count + last-message preview,
   * but ONLY for communities the user is an ACTIVE member of (member-only
   * previews). Non-member communities get `unreadMessageCount: 0` +
   * `hasLastMessage: false`. Single bulk query per concern — no N+1.
   */
  async getChatSummaries(params: {
    userId: string;
    communityIds: string[];
  }): Promise<CommunityChatSummary[]> {
    const ids = [...new Set(params.communityIds.filter(Boolean))];
    if (!ids.length) return [];

    // 1. Active membership rows → member roomIds + per-room read threshold.
    const members = await this.memberRepo.findActiveByUserAndRooms(
      params.userId,
      ids
    );
    const readMap = new Map<string, Date | null>(
      members.map((m) => [m.roomId, m.lastReadAt])
    );
    const memberRoomIds = members.map((m) => m.roomId);

    // 2/3. In parallel: member rooms (lastMessage JSON) + bulk unread counts.
    const [rooms, unreadMap] = await Promise.all([
      this.roomRepo.findManyByIds(memberRoomIds),
      memberRoomIds.length
        ? this.messageRepo.countUnreadBulk({
            userId: params.userId,
            thresholds: memberRoomIds.map((roomId) => ({
              roomId,
              afterDate: readMap.get(roomId) ?? new Date(0),
            })),
          })
        : Promise.resolve<Record<string, number>>({}),
    ]);
    const roomById = new Map(rooms.map((r) => [r.id, r]));

    // 4. Build a summary for EVERY requested community.
    return ids.map((communityId) => {
      if (!readMap.has(communityId)) {
        // Not an active member → no preview, zero unread (member-only previews).
        return {
          communityId,
          unreadMessageCount: 0,
          hasLastMessage: false,
        };
      }

      const room = roomById.get(communityId);
      const last = (room?.lastMessage ?? null) as RoomLastMessageJson | null;
      const unreadMessageCount = unreadMap[communityId] ?? 0;

      if (!last || !last.createdAt) {
        return { communityId, unreadMessageCount, hasLastMessage: false };
      }

      const createdAt =
        last.createdAt instanceof Date
          ? last.createdAt
          : new Date(last.createdAt);

      return {
        communityId,
        unreadMessageCount,
        hasLastMessage: true,
        lastMessage: {
          username: last.senderName ?? "",
          message: communityMessagePreview({
            messageType: last.messageType,
            content: last.content,
          }),
          dateTime: Number.isNaN(createdAt.getTime()) ? 0 : createdAt.getTime(),
        },
      };
    });
  }

  async bulkMarkRead(userId: string, communityIds: string[]): Promise<number> {
    const ids = [...new Set(communityIds.filter(Boolean))];
    if (!ids.length) return 0;
    return this.memberRepo.bulkAdvanceReadToNow(userId, ids);
  }

  async getMessages(params: {
    roomId: string;
    userId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<GeneralRoomMessage[]> {
    const beforeTimestamp = params.cursor || new Date().toISOString();
    return this.messageRepo.findByRoomIdWithTime(
      params.roomId,
      beforeTimestamp,
      "older",
      params.limit,
      params.userId
    );
  }

  /**
   * Timestamp-keyset page (before_ts / after_ts). Over-fetches one extra row so
   * `hasMore` is exact; `nextCursor` is the boundary createdAt as epoch-ms.
   */
  async getMessagesTimeline(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    ts: Date;
    limit: number;
  }): Promise<{
    items: GeneralRoomMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const rows = await this.messageRepo.findByRoomIdTimeline({
      roomId: params.roomId,
      userId: params.userId,
      direction: params.direction,
      ts: params.ts,
      limit: params.limit,
    });

    const hasMore = rows.length > params.limit;
    const items = rows.slice(0, params.limit);
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last ? String(last.createdAt.getTime()) : null;

    return { items, hasMore, nextCursor };
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
      messageType: string;
      attachments: unknown;
      reactions: Array<{
        emoji: string;
        count: number;
        users: Array<{ userId: string; displayName: string; avatar: string }>;
      }>;
      deletedForAll: boolean;
      editedAt: number | null;
      createdAt: number;
      updatedAt: number;
      syncEventType: "new" | "edited" | "deleted" | "reacted";
    }>;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    // Enforce active membership — banned/left members cannot read.
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active") {
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    }

    const { messages, hasMore } = await this.messageRepo.findUpdatedAtSince({
      roomId: params.roomId,
      userId: params.userId,
      fromTs: params.fromTs,
      limit: params.limit,
    });

    const last = messages[messages.length - 1];
    const nextCursor =
      hasMore && last ? String(last.updatedAt.getTime()) : null;

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

      return {
        id: msg.id,
        roomId: msg.roomId,
        sentBy: msg.sentBy,
        senderName: msg.senderName ?? null,
        senderAvatar: msg.senderAvatar ?? null,
        message: msg.message ?? null,
        messageType: msg.messageType,
        attachments: msg.attachments,
        reactions: groupStoredReactions(msg.reactions),
        deletedForAll: msg.deletedForAll,
        editedAt: editedMs,
        createdAt: createdMs,
        updatedAt: updatedMs,
        syncEventType,
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
  }): Promise<{ items: GeneralRoomMessage[] }> {
    const anchor = await this.messageRepo.findById(params.messageId);
    if (!anchor) {
      return { items: [] };
    }
    const items = await this.messageRepo.findAroundDate({
      roomId: params.roomId,
      userId: params.userId,
      anchorDate: anchor.createdAt,
      limit: params.limit,
    });
    return { items };
  }

  /**
   * Paginated conversation page for a community room + mark-as-read side effect.
   * Enforces active membership first (same check as listMedia), fetches the
   * offset page (createdAt < timestamp, newest first), then advances the
   * caller's read pointer to the newest returned message (forward-only).
   */
  async getConversation(params: {
    roomId: string;
    userId: string;
    pageNumber: number;
    limit: number;
    timestamp?: number;
  }): Promise<{ messages: GeneralRoomMessage[]; total: number }> {
    // Enforce active membership first (banned/left members can't read).
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");

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
    const newest = messages[0];
    if (newest) {
      await this.memberRepo
        .advanceReadPointer(
          params.roomId,
          params.userId,
          newest.id,
          newest.createdAt
        )
        .catch((err: unknown) => {
          logger.warn(
            `CommunityMessageService|getConversation|advanceReadPointer failed: ${String(err)}`
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
  }): Promise<GeneralRoomMessage[]> {
    return this.messageRepo.searchByText(
      params.roomId,
      params.query,
      params.limit,
      params.userId
    );
  }

  async countMessages(roomId: string): Promise<number> {
    return this.messageRepo.countByRoom(roomId);
  }

  async countSearchResults(roomId: string, query: string): Promise<number> {
    return this.messageRepo.countSearchResults(roomId, query);
  }

  async listMedia(params: {
    roomId: string;
    userId: string;
    type?: string;
    cursor?: string | null;
    limit: number;
  }): Promise<GeneralRoomMessage[]> {
    // Enforce active membership first (banned/left members can't list media).
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");

    return this.messageRepo.listMedia({
      roomId: params.roomId,
      userId: params.userId,
      type: params.type,
      cursor: params.cursor,
      limit: params.limit,
    });
  }

  async editMessage(params: {
    messageId: string;
    userId: string;
    content: { text: string };
  }): Promise<GeneralRoomMessage> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (message.sentBy !== params.userId)
      throw new BadRequestError("CHAT_EDIT_OWN_MESSAGES_ONLY");
    if (message.messageType !== "text")
      throw new BadRequestError("CHAT_EDIT_TEXT_ONLY");
    if ((params.content?.text?.length ?? 0) > CHAT_TEXT_MAX_CHARS)
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    if (Date.now() - message.createdAt.getTime() > CHAT_EDIT_WINDOW_MS)
      throw new GoneError("CHAT_EDIT_WINDOW_EXPIRED");
    return this.messageRepo.editMessage(params.messageId, params.content.text);
  }

  async reactToMessage(params: {
    messageId: string;
    userId: string;
    communityId: string;
    emoji: string;
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
    if (message.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");

    // Guard: only active members may react.
    const member = await this.memberRepo.findByRoomAndUser(
      message.roomId,
      params.userId
    );
    if (!member || member.status !== "active") {
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    }

    // NOTE: non-atomic read-modify-write; acceptable at current scale
    const updatedReactions = (
      message.reactions
        ? {
            ...(message.reactions as Record<
              string,
              Array<{
                userId: string;
                userName: string;
                avatar: string;
                memberId: string;
              }>
            >),
          }
        : {}
    ) as Record<
      string,
      Array<{
        userId: string;
        userName: string;
        avatar: string;
        memberId: string;
      }>
    >;

    if (!updatedReactions[params.emoji]) {
      updatedReactions[params.emoji] = [];
    }

    const existingIndex = updatedReactions[params.emoji]!.findIndex(
      (entry) => entry.userId === params.userId
    );

    if (existingIndex !== -1) {
      updatedReactions[params.emoji]!.splice(existingIndex, 1);
      if (updatedReactions[params.emoji]!.length === 0) {
        delete updatedReactions[params.emoji];
      }
    } else {
      updatedReactions[params.emoji]!.push({
        userId: params.userId,
        userName: "",
        avatar: "",
        memberId: "",
      });
    }

    await this.messageRepo.updateById(
      params.communityId,
      params.messageId,
      updatedReactions
    );

    // Collect all unique userIds across all reaction arrays
    const allUserIds = [
      ...new Set(
        Object.values(updatedReactions)
          .flat()
          .map((e) => e.userId)
          .filter(Boolean)
      ),
    ];

    const snaps =
      allUserIds.length > 0
        ? await this.userSnapshotService.getUserSnapshotsMap(
            allUserIds,
            this.cacheRepo
          )
        : new Map<string, Record<string, unknown>>();

    const reactionGroups = Object.entries(updatedReactions)
      .filter(([, users]) => users.length > 0) // skip defensively if empty
      .map(([emoji, users]) => ({
        emoji,
        count: users.length,
        users: users.map((u) => {
          const snap = snaps.get(u.userId);
          return {
            userId: u.userId,
            displayName: (snap?.displayName as string) || u.userName || "",
            avatar: (snap?.avatar as string) || u.avatar || "",
          };
        }),
      }));

    return {
      messageId: params.messageId,
      communityId: params.communityId,
      reactions: reactionGroups,
    };
  }

  async deleteForMe(
    messageId: string,
    userId: string
  ): Promise<GeneralRoomMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    await this.messageRepo.deleteForUser(messageId, userId);
    return this.messageRepo.findById(messageId);
  }

  async deleteForAll(
    messageId: string,
    userId: string
  ): Promise<GeneralRoomMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    // Sender can always delete their own message for everyone.
    // Others need admin or moderator role.
    if (message.sentBy !== userId) {
      const member = await this.memberRepo.findByRoomAndUser(
        message.roomId,
        userId
      );
      if (!member || !["admin", "moderator"].includes(member.role)) {
        throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
      }
    }

    return this.messageRepo.deleteForAll(messageId);
  }

  async report(params: {
    messageId: string;
    reporterId: string;
    reportReason: string;
  }): Promise<GeneralRoomMessage | null> {
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
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    if (!["admin", "moderator"].includes(member.role))
      throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");

    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.roomId !== params.roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");

    const room = await this.roomRepo.findRoomById(params.roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
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
    return {
      pinnedIds: newPinnedIds,
      pinnedCount: newPinnedIds.length,
      pinnedAt: Date.now(),
    };
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
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    if (!["admin", "moderator"].includes(member.role))
      throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");

    const room = await this.roomRepo.findRoomById(params.roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const pinnedIds: string[] = Array.isArray(room.listPinedMessage)
      ? (room.listPinedMessage as string[])
      : [];

    if (!pinnedIds.includes(params.messageId))
      throw new NotFoundError("CHAT_PIN_NOT_FOUND");

    const newPinnedIds = pinnedIds.filter((id) => id !== params.messageId);
    await this.roomRepo.updatePinnedMessages(params.roomId, newPinnedIds);
    return { pinnedIds: newPinnedIds, pinnedCount: newPinnedIds.length };
  }
}
