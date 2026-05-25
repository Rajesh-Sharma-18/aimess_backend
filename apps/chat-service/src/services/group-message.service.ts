import { BadRequestError, NotFoundError } from "@aimess/errors";

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

    const message = await this.messageRepo.create(
      entity as Parameters<typeof this.messageRepo.create>[0]
    );

    // Update room last message
    const messageContent = (message.content ?? {}) as Record<string, unknown>;
    await this.roomRepo.updateLastMessage(params.roomId, {
      _id: message.id,
      senderId: message.senderId ?? null,
      senderName: message.senderName,
      messageType: message.messageType,
      content: { text: (messageContent.text as string) || "" },
      createdAt: message.createdAt,
    });

    // Increment unread for all other members
    await this.memberRepo.incUnreadForRoom(params.roomId, params.senderId);

    return message;
  }

  async getMessages(params: {
    roomId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<GroupMessage[]> {
    const beforeTimestamp = params.cursor || new Date().toISOString();
    return this.messageRepo.findByRoomIdWithTime(
      params.roomId,
      beforeTimestamp,
      params.limit
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
}
