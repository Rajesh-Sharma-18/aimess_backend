import { BadRequestError, NotFoundError } from "@aimess/errors";
import { nanoid } from "nanoid";

import { SystemEvent } from "../types/enums.js";
import { assertGroupMember } from "../lib/access-guard.js";
import { resolveMediaUrl } from "../lib/media-resolve.js";

import type { GroupInviteLinkRepository } from "../repositories/group-invite-link.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { GroupInviteLink, GroupRoom } from "../generated/prisma/index.js";
import { GroupMemberService } from "./group-member.service.js";

export class GroupInviteLinkService {
  constructor(
    private readonly inviteLinkRepo: GroupInviteLinkRepository,
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository
  ) {}

  async create(params: {
    roomId: string;
    userId: string;
    expiresAt?: Date | null;
    maxUses?: number | null;
    shareName?: string;
  }): Promise<GroupInviteLink> {
    const room = await this.roomRepo.findActiveByRoomId(params.roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");

    const member = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member) throw new BadRequestError("CHAT_NOT_A_MEMBER");

    // Check settings
    const settings = (room.settings ?? {}) as Record<string, unknown>;
    if (!settings.allowMemberInviteLink && member.role === "MEMBER") {
      throw new BadRequestError("CHAT_MEMBERS_CANNOT_CREATE_LINKS");
    }

    const token = nanoid(24);

    return this.inviteLinkRepo.create({
      roomId: params.roomId,
      token,
      createdBy: params.userId,
      expiresAt: params.expiresAt || null,
      maxUses: params.maxUses || null,
      shareName: params.shareName || "",
    });
  }

  async revoke(token: string, userId: string): Promise<GroupInviteLink | null> {
    const link = await this.inviteLinkRepo.findActiveByToken(token);
    if (!link) throw new NotFoundError("CHAT_INVITE_LINK_NOT_FOUND");

    const member = await this.memberRepo.findActiveByRoomAndUser(
      link.roomId,
      userId
    );
    if (!member || !["OWNER", "ADMIN"].includes(member.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    return this.inviteLinkRepo.revoke(token, userId);
  }

  async preview(token: string): Promise<{
    token: string;
    groupId: string;
    groupName: string;
    groupAvatar: string;
    description: string;
    memberCount: number;
    memberLimit: number;
  }> {
    const link = await this.inviteLinkRepo.findActiveByToken(token);
    if (!link) throw new NotFoundError("CHAT_INVITE_LINK_NOT_FOUND");

    // Check expiry
    if (link.expiresAt && new Date() > new Date(link.expiresAt)) {
      throw new BadRequestError("CHAT_INVITE_LINK_EXPIRED");
    }

    // Check max uses
    if (link.maxUses && link.usedCount >= link.maxUses) {
      throw new BadRequestError("CHAT_INVITE_LINK_USAGE_LIMIT");
    }

    const room = await this.roomRepo.findActiveByRoomId(link.roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NO_LONGER_EXISTS");

    return {
      token: link.token,
      groupId: room.roomId,
      groupName: room.name,
      groupAvatar: await resolveMediaUrl(room.avatar),
      description: room.description,
      memberCount: room.memberCount,
      memberLimit: room.memberLimit,
    };
  }

  async join(
    token: string,
    userId: string,
    memberService: GroupMemberService
  ): Promise<{ room: GroupRoom }> {
    const link = await this.inviteLinkRepo.findActiveByToken(token);
    if (!link) throw new NotFoundError("CHAT_INVITE_LINK_NOT_FOUND");

    if (link.expiresAt && new Date() > new Date(link.expiresAt)) {
      throw new BadRequestError("CHAT_INVITE_LINK_EXPIRED");
    }
    if (link.maxUses && link.usedCount >= link.maxUses) {
      throw new BadRequestError("CHAT_INVITE_LINK_USAGE_LIMIT");
    }

    const room = await this.roomRepo.findActiveByRoomId(link.roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NO_LONGER_EXISTS");

    await memberService.addMember(
      {
        roomId: link.roomId,
        userId,
        invitedBy: link.createdBy,
      },
      {
        systemEvent: SystemEvent.MEMBER_JOINED,
        actorId: userId,
        // Self-join: the user is authorized by the valid invite link, not by an
        // OWNER/ADMIN role — skip the direct-add actor authorization.
        skipActorAuthz: true,
      }
    );

    await this.inviteLinkRepo.incrementUsedCount(token);

    return { room };
  }

  async getActiveLinks(
    roomId: string,
    userId: string
  ): Promise<GroupInviteLink[]> {
    // Invite tokens grant group entry, so listing them must be restricted to an
    // active OWNER/ADMIN of the room — not any authenticated user (AUDIT H4).
    await assertGroupMember(this.memberRepo, roomId, userId, {
      roles: ["OWNER", "ADMIN"],
    });
    return this.inviteLinkRepo.findActiveByRoom(roomId);
  }

  async countActiveLinks(roomId: string): Promise<number> {
    return this.inviteLinkRepo.countActiveByRoom(roomId);
  }
}
