import { BadRequestError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { generateRoomId } from "../lib/room-id.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { GroupInviteLinkRepository } from "../repositories/group-invite-link.repository.js";
import type { GroupRoom, GroupMember } from "../generated/prisma/index.js";

export class GroupRoomService {
  constructor(
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository,
    private readonly inviteLinkRepo: GroupInviteLinkRepository
  ) {}

  async createGroup(params: {
    name: string;
    description?: string;
    avatar?: string;
    createdBy: string;
    memberLimit?: number;
  }): Promise<{ room: GroupRoom; member: GroupMember }> {
    const roomId = generateRoomId("grp");

    const room = await this.roomRepo.create({
      roomId,
      type: "GROUP",
      name: params.name,
      description: params.description || "",
      avatar: params.avatar || "",
      createdBy: params.createdBy,
      memberLimit: params.memberLimit || 50,
      memberCount: 1,
    });

    const member = await this.memberRepo.create({
      roomId,
      userId: params.createdBy,
      role: "OWNER",
      status: "ACTIVE",
      joinedAt: new Date(),
    });

    logger.info(
      `GroupRoomService|createGroup|room=${roomId}, owner=${params.createdBy}`
    );

    return { room, member };
  }

  async getRoom(roomId: string): Promise<GroupRoom> {
    const room = await this.roomRepo.findActiveByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");
    return room;
  }

  async updateRoom(
    roomId: string,
    userId: string,
    data: {
      name?: string;
      description?: string;
      avatar?: string;
      memberLimit?: number;
    }
  ): Promise<GroupRoom> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (!["OWNER", "ADMIN"].includes(member.role)) {
      throw new BadRequestError("CHAT_ONLY_OWNER_ADMIN_UPDATE");
    }

    const updated = await this.roomRepo.updateRoom(roomId, data);
    if (!updated) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");
    return updated;
  }

  async disbandGroup(roomId: string, userId: string): Promise<GroupRoom> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (member.role !== "OWNER") {
      throw new BadRequestError("CHAT_ONLY_OWNER_DISBAND");
    }

    const disbanded = await this.roomRepo.disband(roomId, userId);
    if (!disbanded) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");

    // Revoke all active invite links
    await this.inviteLinkRepo.revokeAllForRoom(roomId, userId);

    return disbanded;
  }

  async getUserGroups(
    userId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<GroupRoom[]> {
    const roomIds = await this.memberRepo.getActiveRoomIds(userId);
    if (!roomIds.length) return [];
    return this.roomRepo.getUserGroups(userId, roomIds, params);
  }

  async countUserGroups(userId: string): Promise<number> {
    const roomIds = await this.memberRepo.getActiveRoomIds(userId);
    if (!roomIds.length) return 0;
    return this.roomRepo.countUserGroups(roomIds);
  }
}
