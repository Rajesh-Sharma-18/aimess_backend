import { BadRequestError, ForbiddenError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { FriendshipRepository } from "../repositories/friendship.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { PrivateMessage } from "../generated/prisma/index.js";

export class PrivateMessageService {
  constructor(
    private readonly messageRepo: PrivateMessageRepository,
    private readonly roomRepo: PrivateRoomRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly friendshipRepo: FriendshipRepository
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
  }): Promise<PrivateMessage> {
    const friends = await this.friendshipRepo.areFriends(
      params.senderId,
      params.receiverId
    );
    if (!friends) {
      throw new ForbiddenError("CHAT_FRIENDSHIP_REQUIRED");
    }

    const entity: Record<string, unknown> = {
      roomId: params.roomId,
      senderId: params.senderId,
      receiverId: params.receiverId,
      content: params.content,
      messageType: params.messageType || "TEXT",
      parentMessageId: params.parentMessageId || null,
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
