import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@aimess/errors";

import { SystemEvent } from "../types/enums.js";
import { assertGroupMember } from "../lib/access-guard.js";
import { publishGroupMemberAddedSafe } from "../events/publish-group-member-added.js";
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
    opts?: {
      systemEvent?: SystemEvent;
      actorId?: string;
      /**
       * Invite-link self-join: the joining user is authorized by possessing a
       * valid link, so skip the OWNER/ADMIN actor check. Default (false) means
       * a direct add MUST be performed by an active OWNER/ADMIN.
       */
      skipActorAuthz?: boolean;
    }
  ): Promise<GroupMember> {
    const room = await this.roomRepo.findActiveByRoomId(params.roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");

    // Authorize the actor: only an active OWNER/ADMIN may add members (mirrors
    // the kick/updateRole guards). Without this, any authenticated user could
    // inject themselves or others into a private group (AUDIT H3).
    if (!opts?.skipActorAuthz) {
      if (!params.invitedBy) {
        throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");
      }
      await assertGroupMember(
        this.memberRepo,
        params.roomId,
        params.invitedBy,
        {
          roles: ["OWNER", "ADMIN"],
        }
      );
    }

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
    // A banned member cannot rejoin (mirrors community's assertNotBanned join
    // gate) — without this, `ban` had no effect since upsert would silently
    // reactivate them on the next add/invite-link redemption.
    if (existing && existing.status === "BANNED") {
      throw new ForbiddenError("CHAT_BANNED_FROM_ROOM");
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

    // Out-of-room push/inbox for the added member (additive to the in-room SYSTEM
    // message above). Skip invite-link self-joins (systemEvent MEMBER_JOINED) —
    // the user initiated the join and already knows, mirroring community JOINED.
    if (systemEvent === SystemEvent.MEMBER_ADDED) {
      publishGroupMemberAddedSafe({
        roomId: params.roomId,
        groupName: room.name,
        addedUserId: params.userId,
        actorId: opts?.actorId ?? params.invitedBy ?? params.userId,
        eventAt: new Date().toISOString(),
      });
    }

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

  /**
   * Ban a member: same permission/role-order rules as `kick`, but the target's
   * `status` becomes `"BANNED"` (not `"KICKED"`) and `bannedAt`/`bannedBy` are
   * populated — those two Prisma columns previously existed on the schema but
   * were never written or checked anywhere, so a "banned" group member was
   * functionally identical to an active one. `findActiveByRoomAndUser`'s
   * `status: "ACTIVE"` filter (used by every send/read/access-guard check)
   * already excludes non-ACTIVE members, so this closes both the write/read
   * gate AND (via `addMember`'s new check above) the rejoin gate, matching
   * community's hardened ban enforcement.
   */
  async ban(params: {
    roomId: string;
    targetUserId: string;
    bannedBy: string;
    reason?: string;
  }): Promise<GroupMember | null> {
    const actor = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.bannedBy
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

    const roleOrder = ["OWNER", "ADMIN", "MODERATOR", "MEMBER"];
    if (roleOrder.indexOf(actor.role) >= roleOrder.indexOf(target.role)) {
      throw new BadRequestError("CHAT_CANNOT_KICK_HIGHER_ROLE");
    }

    const updated = await this.memberRepo.updateStatus(
      params.roomId,
      params.targetUserId,
      "BANNED",
      {
        bannedAt: new Date(),
        bannedBy: params.bannedBy,
        kickReason: params.reason || null,
      }
    );
    await this.roomRepo.incMemberCount(params.roomId, -1);

    await this.sysMsg.post({
      roomId: params.roomId,
      actorId: params.bannedBy,
      systemEvent: SystemEvent.MEMBER_REMOVED,
      systemData: { targetUserId: params.targetUserId },
    });

    return updated;
  }

  /**
   * Lift a ban. Actor must be OWNER/ADMIN/MODERATOR (same gate as `ban`). Does
   * NOT re-add the user as a member — it only clears the ban so a future
   * add/invite-link redemption is no longer rejected by `addMember`'s check.
   */
  async unban(params: {
    roomId: string;
    targetUserId: string;
    unbannedBy: string;
  }): Promise<GroupMember | null> {
    const actor = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.unbannedBy
    );
    if (!actor) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (!["OWNER", "ADMIN", "MODERATOR"].includes(actor.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const target = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.targetUserId
    );
    if (!target || target.status !== "BANNED") {
      throw new NotFoundError("CHAT_NOT_A_MEMBER");
    }

    return this.memberRepo.updateStatus(
      params.roomId,
      params.targetUserId,
      "LEFT",
      { bannedAt: null, bannedBy: null }
    );
  }

  /**
   * Mute/unmute personal notifications for this group — mirrors
   * PrivateRoomService.muteRoom/unmuteRoom. Private already has this; Group had
   * the storage field (`notificationSettings`) and even read it in the inbox
   * list, but no route ever wrote it.
   */
  async muteRoom(
    roomId: string,
    userId: string,
    muteUntil: Date | null
  ): Promise<GroupMember> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    const updated = await this.memberRepo.setMuted(roomId, userId, muteUntil);
    return updated ?? member;
  }

  async unmuteRoom(roomId: string, userId: string): Promise<GroupMember> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    const updated = await this.memberRepo.setUnmuted(roomId, userId);
    return updated ?? member;
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
