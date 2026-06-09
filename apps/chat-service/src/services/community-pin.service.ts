import { BadRequestError, ForbiddenError, NotFoundError } from "@aimess/errors";

import { env } from "../config/env.js";
import type { CommunityMessagePinRepository } from "../repositories/community-message-pin.repository.js";
import type { GeneralRoomMessageRepository } from "../repositories/general-room-message.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { CommunityMessagePin } from "../generated/prisma/index.js";

export class CommunityPinService {
  constructor(
    private readonly pinRepo: CommunityMessagePinRepository,
    private readonly messageRepo: GeneralRoomMessageRepository,
    private readonly roomRepo: GeneralRoomRepository,
    private readonly memberRepo: RoomMemberRepository
  ) {}

  async pin(params: {
    roomId: string;
    messageId: string;
    userId: string;
    communityId: string;
  }): Promise<{ pin: CommunityMessagePin; pinnedCount: number }> {
    const { roomId, messageId, userId } = params;

    const member = await this.memberRepo.findByRoomAndUser(roomId, userId);
    if (!member || member.status !== "active")
      throw new NotFoundError("CHAT_NOT_A_MEMBER");

    if (!["admin", "moderator"].includes(member.role)) {
      throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const totalPins = await this.pinRepo.countPinsByRoom(roomId);
    if (totalPins >= env.PIN_LIMIT_PER_ROOM) {
      throw new BadRequestError("CHAT_PIN_LIMIT_REACHED");
    }

    const msg = await this.messageRepo.findById(messageId);
    if (!msg || msg.roomId !== roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const senderDisplayName = msg.senderName ?? "";
    const senderAvatar = msg.senderAvatar ?? "";
    const senderId = msg.sentBy ?? "";

    const pin = await this.pinRepo.createPin({
      roomId,
      messageId: msg.id,
      pinnedBy: userId,
      pinnedAt: new Date(),
      messageCreatedAt: msg.createdAt,
      senderId,
      senderDisplayName,
      senderAvatar,
      contentPinned: {
        text: msg.message ?? "",
        urls: [],
        files: [],
      },
    });

    const updated = await this.roomRepo.incPinnedCount(roomId, 1);
    return { pin, pinnedCount: updated?.pinnedCount ?? 0 };
  }

  async unpin(params: {
    roomId: string;
    messageId: string;
    userId: string;
  }): Promise<{ pinnedCount: number }> {
    const { roomId, messageId, userId } = params;

    const member = await this.memberRepo.findByRoomAndUser(roomId, userId);
    if (!member || member.status !== "active")
      throw new NotFoundError("CHAT_NOT_A_MEMBER");

    if (!["admin", "moderator"].includes(member.role)) {
      throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const result = await this.pinRepo.deletePin(roomId, messageId);
    if (!result.deletedCount) throw new NotFoundError("CHAT_PIN_NOT_FOUND");

    const updated = await this.roomRepo.incPinnedCount(roomId, -1);
    return { pinnedCount: updated?.pinnedCount ?? 0 };
  }

  async list(
    roomId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<CommunityMessagePin[]> {
    return this.pinRepo.findPinsByRoom(roomId, params);
  }

  async countPins(roomId: string): Promise<number> {
    return this.pinRepo.countPinsByRoom(roomId);
  }
}
