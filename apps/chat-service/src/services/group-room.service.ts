import { BadRequestError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import { generateRoomId } from "../lib/room-id.js";
import { SystemEvent } from "../types/enums.js";
import {
  resolveMediaUrl,
  resolveMediaUrlMap,
  urlFromMap,
} from "../lib/media-resolve.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { GroupInviteLinkRepository } from "../repositories/group-invite-link.repository.js";
import type { GroupSystemMessageService } from "./group-system-message.service.js";
import type { GroupRoom, GroupMember } from "../generated/prisma/index.js";

export type GroupRoomMembership = GroupRoom & {
  /** True when the logged-in caller is an active member of this group. */
  isJoined: boolean;
};

export type EnrichedGroupRoom = GroupRoomMembership & {
  isMuted: boolean;
  unreadCount: number;
  role: string;
};

export class GroupRoomService {
  constructor(
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository,
    private readonly inviteLinkRepo: GroupInviteLinkRepository,
    private readonly sysMsg: GroupSystemMessageService,
    private readonly redis: Redis | Cluster
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

    // System message → sets lastMessageAt so the brand-new (message-less) group
    // appears and sorts in the unified inbox immediately.
    await this.sysMsg.post({
      roomId,
      actorId: params.createdBy,
      systemEvent: SystemEvent.GROUP_CREATED,
      systemData: { groupName: params.name },
    });

    logger.info(
      `GroupRoomService|createGroup|room=${roomId}, owner=${params.createdBy}`
    );

    // Re-read so the response reflects the lastMessageAt/preview the system
    // message just set (the `room` above predates that write). Falls back to the
    // original row if the post/read was a no-op.
    const fresh = await this.roomRepo.findActiveByRoomId(roomId);
    return { room: fresh ?? room, member };
  }

  async getRoom(roomId: string, userId?: string): Promise<GroupRoomMembership> {
    const room = await this.roomRepo.findActiveByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");
    // Any authenticated user can fetch a group's detail, so isJoined genuinely
    // varies: true only when the caller has an ACTIVE membership row.
    const isJoined = userId
      ? (await this.memberRepo.findActiveByRoomAndUser(roomId, userId)) !== null
      : false;
    // Resolve the room logo object key → download URL on read (never persisted).
    const avatar = await resolveMediaUrl(room.avatar);
    return { ...room, avatar, isJoined };
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

    // Snapshot the pre-update values so we only post system messages for fields
    // that actually changed (a client may re-send unchanged values).
    const room = await this.roomRepo.findActiveByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");

    const updated = await this.roomRepo.updateRoom(roomId, data);
    if (!updated) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");

    // One system message per changed presentational field (memberLimit is silent).
    if (data.name != null && data.name !== room.name) {
      await this.sysMsg.post({
        roomId,
        actorId: userId,
        systemEvent: SystemEvent.ROOM_RENAMED,
        systemData: { newName: data.name },
      });
    }
    if (data.avatar != null && data.avatar !== room.avatar) {
      await this.sysMsg.post({
        roomId,
        actorId: userId,
        systemEvent: SystemEvent.AVATAR_CHANGED,
      });
    }
    if (data.description != null && data.description !== room.description) {
      await this.sysMsg.post({
        roomId,
        actorId: userId,
        systemEvent: SystemEvent.DESCRIPTION_CHANGED,
      });
    }

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
  ): Promise<GroupRoomMembership[]> {
    const roomIds = await this.memberRepo.getActiveRoomIds(userId);
    if (!roomIds.length) return [];
    const rooms = await this.roomRepo.getUserGroups(userId, roomIds, params);
    // Resolve every room logo on this page ONCE (deduped) → download URLs.
    const avatarUrls = await resolveMediaUrlMap(rooms.map((r) => r.avatar));
    // Every row here is a group the caller is an ACTIVE member of.
    return rooms.map((room) => ({
      ...room,
      avatar: urlFromMap(avatarUrls, room.avatar),
      isJoined: true,
    }));
  }

  async countUserGroups(userId: string): Promise<number> {
    const roomIds = await this.memberRepo.getActiveRoomIds(userId);
    if (!roomIds.length) return 0;
    return this.roomRepo.countUserGroups(roomIds);
  }

  async archiveRoom(roomId: string, userId: string): Promise<GroupRoom> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const room = await this.roomRepo.findActiveByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");
    const updated = await this.roomRepo.setArchived(roomId, userId);
    this.redis
      .publish(
        `user:${userId}`,
        JSON.stringify({
          event: "conv:archived",
          data: { roomId, type: "GROUP", archivedAt: Date.now() },
        })
      )
      .catch(() => {});
    return updated ?? room;
  }

  async unarchiveRoom(roomId: string, userId: string): Promise<GroupRoom> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const room = await this.roomRepo.findActiveByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");
    const updated = await this.roomRepo.setUnarchived(roomId, userId);
    this.redis
      .publish(
        `user:${userId}`,
        JSON.stringify({
          event: "conv:unarchived",
          data: { roomId, type: "GROUP" },
        })
      )
      .catch(() => {});
    return updated ?? room;
  }

  /**
   * Timestamp-bounded group fetch for the unified inbox, enriched with the
   * viewer's per-room unread count, mute state, and role.
   */
  async getInboxGroups(params: {
    userId: string;
    direction: "before" | "after";
    ts: Date;
    limit: number;
  }): Promise<EnrichedGroupRoom[]> {
    const memberships = await this.memberRepo.getActiveMemberships(
      params.userId
    );
    if (!memberships.length) return [];

    const membershipByRoom = new Map(memberships.map((m) => [m.roomId, m]));
    const roomIds = memberships.map((m) => m.roomId);

    const rooms = await this.roomRepo.getInboxGroups({
      roomIds,
      direction: params.direction,
      ts: params.ts,
      limit: params.limit,
    });

    // Resolve every room logo on this page ONCE (deduped) → download URLs, so
    // the unified inbox renders a usable avatar instead of a raw object key.
    const avatarUrls = await resolveMediaUrlMap(rooms.map((r) => r.avatar));

    const now = Date.now();
    return rooms.map((room) => {
      const membership = membershipByRoom.get(room.roomId);
      const settings = (membership?.notificationSettings ?? {}) as {
        mute?: boolean;
        muteUntil?: string | null;
      };
      const isMuted =
        settings.mute === true ||
        (settings.muteUntil != null &&
          new Date(settings.muteUntil).getTime() > now);
      const isJoined = membership != null;
      return {
        ...room,
        avatar: urlFromMap(avatarUrls, room.avatar),
        isMuted,
        unreadCount: membership?.unreadCount ?? 0,
        role: membership?.role ?? "MEMBER",
        isJoined,
      };
    });
  }
}
