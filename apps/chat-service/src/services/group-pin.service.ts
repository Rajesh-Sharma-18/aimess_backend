import { BadRequestError, NotFoundError } from "@aimess/errors";

import { env } from "../config/env.js";
import { resolvePinsMedia } from "../lib/media-resolve.js";
import type { GroupMessagePinRepository } from "../repositories/group-message-pin.repository.js";
import type { GroupMessageRepository } from "../repositories/group-message.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { GroupMessagePin } from "../generated/prisma/index.js";

export class GroupPinService {
  constructor(
    private readonly pinRepo: GroupMessagePinRepository,
    private readonly messageRepo: GroupMessageRepository,
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService
  ) {}

  async pin(params: {
    roomId: string;
    messageId: string;
    userId: string;
  }): Promise<{ pin: GroupMessagePin; pinnedCount: number }> {
    const { roomId, messageId, userId } = params;

    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    // Only owner/admin/moderator may pin — matches unpin's role gate below and
    // community's admin/moderator-only pin model. Previously any active member
    // could pin, unlike unpin (which was already role-gated).
    if (!["OWNER", "ADMIN", "MODERATOR"].includes(member.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const totalPins = await this.pinRepo.countPinsByRoom(roomId);
    if (totalPins >= env.PIN_LIMIT_PER_ROOM) {
      throw new BadRequestError("CHAT_PIN_LIMIT_REACHED");
    }

    const msg = await this.messageRepo.findById(messageId);
    if (!msg || msg.roomId !== roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const snapshots = await this.userSnapshotService.getUserSnapshotsMap(
      [msg.senderId || ""],
      this.cacheRepo
    );
    const senderSnap = (snapshots.get(msg.senderId || "") || {}) as Record<
      string,
      unknown
    >;

    const pin = await this.pinRepo.createPin({
      roomId,
      messageId: msg.id,
      pinnedBy: userId,
      pinnedAt: new Date(),
      messageCreatedAt: msg.createdAt,
      senderId: msg.senderId || "",
      senderDisplayName: (senderSnap.displayName as string) || "",
      senderAvatar: (senderSnap.avatar as string) || "",
      contentPinned: msg.content as object,
    });

    const updated = await this.roomRepo.incPinnedCount(roomId, 1);
    return { pin, pinnedCount: updated?.pinnedCount || 0 };
  }

  async unpin(params: {
    roomId: string;
    messageId: string;
    userId: string;
  }): Promise<{ pinnedCount: number }> {
    const { roomId, messageId, userId } = params;

    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    // Only owner/admin/moderator can unpin (role-gated only — there is no
    // "original pinner" exception, despite what an earlier comment claimed).
    if (!["OWNER", "ADMIN", "MODERATOR"].includes(member.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const result = await this.pinRepo.deletePin(roomId, messageId);
    if (!result.deletedCount) throw new NotFoundError("CHAT_PIN_NOT_FOUND");

    const updated = await this.roomRepo.incPinnedCount(roomId, -1);
    return { pinnedCount: updated?.pinnedCount || 0 };
  }

  async list(
    roomId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<GroupMessagePin[]> {
    const pins = await this.pinRepo.findPinsByRoom(roomId, params);
    // Resolve the pinned snapshot's sender avatar + attachment keys on read so
    // the pinned-banner FE never receives a raw object key (URLs not persisted).
    return resolvePinsMedia(pins);
  }

  async countPins(roomId: string): Promise<number> {
    return this.pinRepo.countPinsByRoom(roomId);
  }
}
