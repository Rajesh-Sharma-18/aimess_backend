import { BadRequestError, ForbiddenError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";

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

    const message = await this.messageRepo.createForwardedMessage({
      roomId: params.targetRoomId,
      senderId: params.senderId,
      senderName: params.senderName,
      senderAvatar: params.senderAvatar,
      content: source.content as object,
      messageType: source.messageType,
      forwardData,
      clientMessageId: params.clientMessageId ?? null,
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
