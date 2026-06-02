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

import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { PrivateMessageReportRepository } from "../repositories/private-message-report.repository.js";
import type { UserServiceClient } from "../grpc/user.client.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
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
    private readonly reportRepo: PrivateMessageReportRepository
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
  }): Promise<PrivateMessage> {
    // Defensive caps (the gRPC/socket send path doesn't run the Zod validators).
    if ((params.content?.text?.length ?? 0) > CHAT_TEXT_MAX_CHARS) {
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    }
    assertAttachmentsValid(params.messageType, params.content?.files);

    const friends = await this.userServiceClient.checkFriendship(
      params.senderId,
      params.receiverId
    );
    if (!friends) {
      throw new ForbiddenError("CHAT_FRIENDSHIP_REQUIRED");
    }

    // Idempotency: if clientMessageId provided, check for existing message
    if (params.clientMessageId) {
      const existing = await this.messageRepo.findByClientMessageId(
        params.roomId,
        params.senderId,
        params.clientMessageId
      );
      if (existing) return existing;
    }

    const entity: Record<string, unknown> = {
      roomId: params.roomId,
      senderId: params.senderId,
      receiverId: params.receiverId,
      content: params.content,
      messageType: params.messageType || "TEXT",
      parentMessageId: params.parentMessageId || null,
      clientMessageId: params.clientMessageId ?? null,
    };

    // If reply, attach quote data
    if (params.parentMessageId) {
      const originalMsg = await this.messageRepo.findById(
        params.parentMessageId
      );
      if (originalMsg?.content) {
        const originSenderId = originalMsg.senderId || "";
        const snapshots = await this.userSnapshotService.getUserSnapshotsMap(
          [originSenderId],
          this.cacheRepo
        );
        const senderSnap = snapshots.get(originSenderId) || {};
        entity.quoteData = {
          message:
            (originalMsg.content as unknown as Record<string, unknown>)?.text ||
            "",
          senderName:
            ((senderSnap as Record<string, unknown>).displayName as string) ||
            ((senderSnap as Record<string, unknown>).memberId as string) ||
            "",
        };
      }
    }

    // Allocate the per-room monotonic sequence AFTER the idempotency pre-check,
    // immediately before insert, so a retried clientMessageId never burns a seq.
    const seq = await this.roomRepo.allocateSequence(params.roomId);
    entity.sequenceNumber = seq;

    const message = await this.messageRepo.createMessage(
      entity as Parameters<PrivateMessageRepository["createMessage"]>[0]
    );

    // Update room with last message
    this.roomRepo
      .updateRoomOnNewMessage({
        roomId: params.roomId,
        message: {
          _id: message.id,
          content: message.content,
          senderId: message.senderId || "",
          messageType: message.messageType,
          systemEvent: message.systemEvent,
          systemData: message.systemData,
          createdAt: message.createdAt,
        },
        receiverId: params.receiverId,
      })
      .catch((err: unknown) => {
        logger.warn(`PrivateMessageService|updateRoom failed: ${String(err)}`);
      });
    return message;
  }

  async getMessages(params: {
    roomId: string;
    userId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<PrivateMessage[]> {
    const room = await this.roomRepo.findByRoomId(params.roomId, {
      projection: { roomId: 1, deletedFor: 1 },
    });
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    const beforeTimestamp = params.cursor || new Date().toISOString();
    return this.messageRepo.findByRoomIdWithTime(
      params.userId,
      { roomId: room.roomId },
      beforeTimestamp,
      params.limit
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
    limit: number;
  }): Promise<{
    items: PrivateMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const room = await this.roomRepo.findByRoomId(params.roomId, {
      projection: { roomId: 1, deletedFor: 1 },
    });
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    const rows = await this.messageRepo.findByRoomIdTimeline({
      userId: params.userId,
      roomId: room.roomId,
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

  async searchMessages(params: {
    roomId: string;
    userId: string;
    query: string;
    limit: number;
  }): Promise<PrivateMessage[]> {
    const room = await this.roomRepo.findByRoomId(params.roomId, {
      projection: { roomId: 1 },
    });
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
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
    });
  }

  async markRead(params: {
    roomId: string;
    userId: string;
    lastMessageId: string;
  }): Promise<unknown> {
    return this.roomRepo.markReadUpTo({
      roomId: params.roomId,
      userId: params.userId,
      upToMessageId: params.lastMessageId,
    });
  }

  async deleteForMe(
    messageId: string,
    userId: string
  ): Promise<PrivateMessage> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // isDeleted=true means already deleted for everyone — can't delete for me again
    if (message.isDeleted)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    // Check if this user already deleted it for themselves
    const deletedFor = (message.deletedFor ?? {}) as Record<string, unknown>;
    if (userId in deletedFor)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    return this.messageRepo.deleteForMe(messageId, userId);
  }

  async deleteForEveryone(
    messageId: string,
    userId: string
  ): Promise<PrivateMessage> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.isDeleted)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (message.senderId !== userId) {
      throw new BadRequestError("CHAT_DELETE_OWN_MESSAGES_ONLY");
    }
    return this.messageRepo.deleteForEveryone(messageId, userId);
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

  async reportMessage(params: {
    messageId: string;
    reporterId: string;
    reason: string;
    description?: string;
  }): Promise<PrivateMessageReport> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const room = await this.roomRepo.findByRoomId(message.roomId);
    if (!room || !room.participants?.includes(params.reporterId))
      throw new ForbiddenError("CHAT_REPORT_NOT_PARTICIPANT");

    if (message.senderId === params.reporterId)
      throw new BadRequestError("CHAT_REPORT_OWN_MESSAGE");

    try {
      return await this.reportRepo.create({
        roomId: message.roomId,
        messageId: message.id,
        reporterId: params.reporterId,
        reportedUserId: message.senderId ?? "",
        reason: params.reason,
        description: params.description ?? "",
      });
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

  async react(
    messageId: string,
    reactions: Record<string, unknown[]>
  ): Promise<PrivateMessage | null> {
    return this.messageRepo.addReactions(messageId, reactions);
  }

  async countMessages(roomId: string): Promise<number> {
    return this.messageRepo.countByRoom(roomId);
  }

  async countSearchResults(roomId: string, query: string): Promise<number> {
    return this.messageRepo.countSearchResults(roomId, query);
  }

  async forwardMessage(params: {
    sourceMessageId: string;
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
      receiverId: params.receiverId,
      content: source.content as object,
      messageType: source.messageType,
      forwardData,
      clientMessageId: params.clientMessageId ?? null,
      sequenceNumber: seq,
    });

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
        },
        receiverId: params.receiverId,
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

  /**
   * Reconnect gap-fill: returns messages with sequenceNumber > sinceSeq for a
   * room the user participates in. Includes tombstones (no isDeleted filter) so
   * the client can reconcile deletes/edits it missed while offline.
   */
  async catchup(p: {
    roomId: string;
    userId: string;
    sinceSeq: number;
    limit: number;
  }): Promise<{
    authorized: boolean;
    events: PrivateMessage[];
    hasMore: boolean;
    lastSeq: number;
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

  async enrichMessages(
    messages: PrivateMessage[]
  ): Promise<Array<Record<string, unknown>>> {
    const senderIds = [
      ...new Set(
        messages.map((m) => m.senderId).filter((s): s is string => Boolean(s))
      ),
    ];
    if (!senderIds.length) {
      return messages.map((m) => m as unknown as Record<string, unknown>);
    }

    const snapshots = await this.userSnapshotService.getUserSnapshotsMap(
      senderIds,
      this.cacheRepo
    );

    return messages.map((message) => {
      const snapshot = snapshots.get(message.senderId || "") || {};
      return {
        ...(message as unknown as Record<string, unknown>),
        senderDisplayName:
          (snapshot as Record<string, unknown>).displayName || "",
        senderAvatar: (snapshot as Record<string, unknown>).avatar || "",
        senderMemberId: (snapshot as Record<string, unknown>).memberId || "",
        isDeletedUser:
          (snapshot as Record<string, unknown>).isDeletedUser === true,
      };
    });
  }
}
