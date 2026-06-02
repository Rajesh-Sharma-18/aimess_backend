import { BadRequestError, ConflictError, NotFoundError } from "@aimess/errors";

import { SystemEvent } from "../types/enums.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupSystemMessageService } from "./group-system-message.service.js";
import type { GroupMember } from "../generated/prisma/index.js";

export class GroupMemberService {
  constructor(
    private readonly memberRepo: GroupMemberRepository,
    private readonly roomRepo: GroupRoomRepository,
    private readonly sysMsg: GroupSystemMessageService
  ) {}

  /**
   * Adds (or reactivates) a member. By default posts a MEMBER_ADDED system
   * message attributed to `invitedBy`. The invite-link join path passes
   * `opts` to post MEMBER_JOINED attributed to the joining user instead.
   */
  async addMember(
    params: {
      roomId: string;
      userId: string;
      invitedBy?: string;
      role?: string;
    },
    opts?: { systemEvent?: SystemEvent; actorId?: string }
  ): Promise<GroupMember> {
    const room = await this.roomRepo.findActiveByRoomId(params.roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");

    if (room.memberCount >= room.memberLimit) {
      throw new BadRequestError("CHAT_GROUP_MEMBER_LIMIT_REACHED");
    }

    const existing = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (existing && existing.status === "ACTIVE") {
      throw new ConflictError("CHAT_ALREADY_MEMBER");
    }

    const member = await this.memberRepo.upsert(params.roomId, params.userId, {
      role: params.role || "MEMBER",
      status: "ACTIVE",
      joinedAt: new Date(),
      invitedBy: params.invitedBy || null,
      leftAt: null,
      kickedAt: null,
      kickedBy: null,
      kickReason: null,
      bannedAt: null,
      bannedBy: null,
    });

    await this.roomRepo.incMemberCount(params.roomId, 1);

    const systemEvent = opts?.systemEvent ?? SystemEvent.MEMBER_ADDED;
    await this.sysMsg.post({
      roomId: params.roomId,
      actorId: opts?.actorId ?? params.invitedBy ?? params.userId,
      systemEvent,
      systemData: { targetUserId: params.userId },
    });

    return member;
  }

  async leave(roomId: string, userId: string): Promise<GroupMember | null> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    if (member.role === "OWNER") {
      throw new BadRequestError("CHAT_OWNER_CANNOT_LEAVE");
    }

    const updated = await this.memberRepo.updateStatus(roomId, userId, "LEFT", {
      leftAt: new Date(),
    });
    await this.roomRepo.incMemberCount(roomId, -1);

    await this.sysMsg.post({
      roomId,
      actorId: userId,
      systemEvent: SystemEvent.MEMBER_LEFT,
    });

    return updated;
  }

  async kick(params: {
    roomId: string;
    targetUserId: string;
    kickedBy: string;
    reason?: string;
  }): Promise<GroupMember | null> {
    const actor = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.kickedBy
    );
    if (!actor) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (!["OWNER", "ADMIN", "MODERATOR"].includes(actor.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const target = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.targetUserId
    );
    if (!target) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    // Cannot kick someone with equal or higher role
    const roleOrder = ["OWNER", "ADMIN", "MODERATOR", "MEMBER"];
    if (roleOrder.indexOf(actor.role) >= roleOrder.indexOf(target.role)) {
      throw new BadRequestError("CHAT_CANNOT_KICK_HIGHER_ROLE");
    }

    const updated = await this.memberRepo.updateStatus(
      params.roomId,
      params.targetUserId,
      "KICKED",
      {
        kickedAt: new Date(),
        kickedBy: params.kickedBy,
        kickReason: params.reason || null,
      }
    );
    await this.roomRepo.incMemberCount(params.roomId, -1);

    await this.sysMsg.post({
      roomId: params.roomId,
      actorId: params.kickedBy,
      systemEvent: SystemEvent.MEMBER_REMOVED,
      systemData: { targetUserId: params.targetUserId },
    });

    return updated;
  }

  async updateRole(params: {
    roomId: string;
    targetUserId: string;
    newRole: string;
    actorUserId: string;
  }): Promise<GroupMember | null> {
    const actor = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.actorUserId
    );
    if (!actor) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (!["OWNER", "ADMIN"].includes(actor.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    // Owner can set any role, admin can only set moderator/member
    if (actor.role !== "OWNER" && ["OWNER", "ADMIN"].includes(params.newRole)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const updated = await this.memberRepo.updateRole(
      params.roomId,
      params.targetUserId,
      params.newRole
    );

    await this.sysMsg.post({
      roomId: params.roomId,
      actorId: params.actorUserId,
      systemEvent: SystemEvent.ROLE_CHANGED,
      systemData: {
        targetUserId: params.targetUserId,
        newRole: params.newRole,
      },
    });

    return updated;
  }

  async markRead(params: {
    roomId: string;
    userId: string;
    lastMessageId: string;
  }): Promise<GroupMember | null> {
    return this.memberRepo.markRead(
      params.roomId,
      params.userId,
      params.lastMessageId
    );
  }

  async getMembers(
    roomId: string,
    params?: { limit?: number; cursor?: string | null }
  ): Promise<GroupMember[]> {
    return this.memberRepo.findActiveMembers(roomId, params);
  }

  async countMembers(roomId: string): Promise<number> {
    return this.memberRepo.countActiveMembers(roomId);
  }
}
