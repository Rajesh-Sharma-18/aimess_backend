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
  }): Promise<GroupMessage> {
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

    // Check idempotency
    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.senderId}:${params.clientMessageId}`;
      const cachedId = await this.cacheRepo.getMessageIdempotency(idemKey);
      if (cachedId) {
        const cached = await this.messageRepo.findById(cachedId);
        if (cached) return cached;
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
        return existing;
      }
    }

    const entity: Record<string, unknown> = {
      roomId: params.roomId,
      senderId: params.senderId,
      senderName: params.senderName,
      senderAvatar: params.senderAvatar,
      content: params.content,
      messageType: params.messageType || "TEXT",
      parentMessageId: params.parentMessageId || null,
      clientMessageId: params.clientMessageId || null,
    };

    // If reply, attach quote data
    if (params.parentMessageId) {
      const originalMsg = await this.messageRepo.findById(
        params.parentMessageId
      );
      if (originalMsg) {
        const origContent = (originalMsg.content ?? {}) as Record<
          string,
          unknown
        >;
        entity.quoteData = {
          text: (origContent.text as string) || "",
          senderId: originalMsg.senderId,
          senderName: originalMsg.senderName,
          messageType: originalMsg.messageType,
          deletedForAll: originalMsg.isDeleted,
        };
      }
    }

    // Allocate the per-room monotonic sequence AFTER the idempotency pre-check,
    // immediately before insert. On the P2002 dup path below the allocated seq is
    // discarded (an acceptable gap — we do not retry allocation).
    const seq = await this.roomRepo.allocateSequence(params.roomId);
    entity.sequenceNumber = seq;

    let message: GroupMessage;
    try {
      message = await this.messageRepo.create(
        entity as Parameters<typeof this.messageRepo.create>[0]
      );
    } catch (err) {
      // P2002 = unique constraint violation from the sparse idempotency index
      const pe = err as { code?: string };
      if (pe?.code === "P2002" && params.clientMessageId) {
        const dup = await this.messageRepo.findByClientMessageId(
          params.roomId,
          params.senderId,
          params.clientMessageId
        );
        if (dup) return dup;
      }
      throw err;
    }

    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.senderId}:${params.clientMessageId}`;
      this.cacheRepo.setMessageIdempotency(idemKey, message.id).catch(() => {});
    }

    // Update room last message
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

    // Increment unread for all other members
    this.memberRepo
      .incUnreadForRoom(params.roomId, params.senderId)
      .catch((err: unknown) => {
        logger.warn(
          `GroupMessageService|incUnreadForRoom failed: ${String(err)}`
        );
      });
    return message;
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
    limit: number;
  }): Promise<{
    items: GroupMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const rows = await this.messageRepo.findByRoomIdTimeline({
      userId: params.userId,
      roomId: params.roomId,
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
    query: string;
    limit: number;
  }): Promise<GroupMessage[]> {
    return this.messageRepo.searchByText(
      params.roomId,
      params.query,
      params.limit
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

  async countSearchResults(roomId: string, query: string): Promise<number> {
    return this.messageRepo.countSearchResults(roomId, query);
  }

  async deleteForMe(
    messageId: string,
    userId: string,
    roomId: string
  ): Promise<GroupMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new BadRequestError("CHAT_NOT_A_MEMBER");

    return this.messageRepo.deleteForMe(messageId, userId);
  }

  async deleteMessage(
    messageId: string,
    userId: string,
    roomId: string
  ): Promise<GroupMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

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

    return this.messageRepo.deleteForEveryone(messageId, userId, deletedType);
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
    return this.messageRepo.editMessage(params.messageId, params.content);
  }

  async react(
    messageId: string,
    reactions: Record<string, unknown[]>
  ): Promise<GroupMessage | null> {
    return this.messageRepo.addReactions(messageId, reactions);
  }

  async forwardMessage(params: {
    sourceMessageId: string;
    targetRoomId: string;
    senderId: string;
    senderName: string;
    senderAvatar: string;
    clientMessageId?: string | null;
  }): Promise<GroupMessage> {
    // check sender is active member of target room
    const member = await this.memberRepo.findActiveByRoomAndUser(
      params.targetRoomId,
      params.senderId
    );
    if (!member) throw new ForbiddenError("CHAT_NOT_A_MEMBER");

    // idempotency — require senderId to avoid false matches across senders
    if (params.clientMessageId) {
      const existing = await this.messageRepo.findByClientMessageId(
        params.targetRoomId,
        params.senderId,
        params.clientMessageId
      );
      if (existing) return existing;
    }

    // fetch source message
    const source = await this.messageRepo.findById(params.sourceMessageId);
    if (!source || source.isDeleted)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

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

    return message;
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
    const events = hasMore ? rows.slice(0, p.limit) : rows;
    const lastSeq = events.length
      ? events[events.length - 1]!.sequenceNumber
      : p.sinceSeq;

    return { authorized: true, events, hasMore, lastSeq };
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

    const reactions = (raw ?? {}) as Record<string, string[]>;
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
}
