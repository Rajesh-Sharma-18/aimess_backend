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
import {
  resolveVisibleLastBulk,
  type VisibilitySource,
  type VisibleLast,
} from "./last-visible-resolver.js";
import { groupVisibilitySource } from "./last-visible-adapters.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { GroupMessageRepository } from "../repositories/group-message.repository.js";
import type { GroupInviteLinkRepository } from "../repositories/group-invite-link.repository.js";
import type { GroupSystemMessageService } from "./group-system-message.service.js";
import type { GroupRoom, GroupMember } from "../generated/prisma/index.js";

export type GroupRoomMembership = GroupRoom & {
  /** True when the logged-in caller is an active member of this group. */
  isJoined: boolean;
};

/**
 * Post-fetch "delete conversation" visibility gate — mirrors
 * PrivateRoomRepository's `isVisibleAfterDeleteForMe`. A member who cleared
 * their group history stays ACTIVE (unlike Leave), so the room only reappears
 * in their list once a message newer than the clear lands.
 */
function isVisibleAfterClear(
  room: { lastMessageAt: Date | null },
  clearedAt: Date | null | undefined
): boolean {
  if (!clearedAt) return true;
  const lastMs = room.lastMessageAt ? room.lastMessageAt.getTime() : 0;
  return lastMs > clearedAt.getTime();
}

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
    private readonly redis: Redis | Cluster,
    private readonly messageRepo: GroupMessageRepository
  ) {}

  /**
   * Adapter that exposes the group-message deletion shape (deletedForUserIds
   * ARRAY) to the shared LastVisibleResolver. Normalizes a GroupMessage into the
   * room-type-agnostic `VisibleLast`.
   */
  private visibilitySource(): VisibilitySource {
    return groupVisibilitySource(this.messageRepo);
  }

  /**
   * Per-user list-preview pass shared by getInboxGroups and getUserGroups: for
   * each room whose shared lastMessageId is hidden from the viewer (globally
   * deleted OR personally hidden), substitute the viewer's previous-visible
   * message into `lastMessagePreview`. Rooms whose shared last is visible (the
   * common case) are returned untouched. Ordering (lastMessageAt) is left as the
   * shared snapshot dictates — display-only per-user correction, no re-sort.
   */
  private async applyPerUserPreview<T extends GroupRoom>(
    rooms: T[],
    userId: string
  ): Promise<T[]> {
    if (!rooms.length) return rooms;
    const overrides = await resolveVisibleLastBulk(
      this.visibilitySource(),
      rooms.map((r) => ({
        roomId: r.roomId,
        sharedLastMessageId: r.lastMessageId,
      })),
      userId
    );
    const withDeleteOverlay = !overrides.size
      ? rooms
      : rooms.map((room) => {
          if (!overrides.has(room.roomId)) return room;
          const prev: VisibleLast | null = overrides.get(room.roomId) ?? null;
          const content = (prev?.content ?? null) as { text?: string } | null;
          return {
            ...room,
            // Preserve the GroupRoom.lastMessagePreview JSON shape so the wire
            // response is unchanged; only the per-viewer content differs.
            lastMessagePreview: prev
              ? {
                  text: content?.text ?? "",
                  senderId: prev.senderId,
                  senderName: prev.senderName,
                  messageType: prev.messageType,
                  createdAt: prev.createdAt,
                }
              : null,
          } as T;
        });
    return this.applyReactionOverlay(withDeleteOverlay, userId);
  }

  /**
   * Reaction OVERLAY read-time gate — see PrivateRoomService.enrichConversations
   * for the full rationale (identical semantics). Visible ONLY to its own actor
   * and (if different) the reacted-to message's owner, and ONLY while strictly
   * newer than the canonical lastMessageAt; every other member keeps the real
   * last message. Overwrites `lastMessagePreview` only — never lastMessageAt
   * (display-only, matches the delete-for-me overlay above).
   */
  private applyReactionOverlay<T extends GroupRoom>(
    rooms: T[],
    userId: string
  ): T[] {
    return rooms.map((room) => {
      const lastAt = room.lastMessageAt?.getTime() ?? 0;
      if (
        !room.reactionActivityAt ||
        room.reactionActivityAt.getTime() <= lastAt
      )
        return room;
      const isActor = room.reactionActivityActorId === userId;
      const isTarget = room.reactionActivityTargetId === userId;
      if (!isActor && !isTarget) return room;
      return {
        ...room,
        lastMessagePreview: {
          text: isActor
            ? (room.reactionActivityActorPreview ?? "")
            : (room.reactionActivityTargetPreview ?? ""),
          senderId: "",
          senderName: "",
          messageType: "SYSTEM",
          createdAt: room.reactionActivityAt,
        },
      } as T;
    });
  }

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

  /**
   * "Delete Conversation" for a group: clears the caller's own history view
   * (mirrors PrivateRoomService.deleteForMe) WITHOUT leaving the group — the
   * member stays ACTIVE, keeps receiving new messages, and the room reappears
   * in their inbox the moment one arrives, showing only messages sent after
   * this cutoff. Distinct from Leave, which removes membership entirely.
   */
  async clearConversation(roomId: string, userId: string): Promise<void> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    await this.memberRepo.setClearedAt(roomId, userId);

    // Notify the user's other devices the conversation was cleared from their view.
    this.redis
      .publish(
        `user:${userId}`,
        JSON.stringify({
          event: "conv:deleted",
          data: { roomId, deletedBy: userId, type: "GROUP" },
        })
      )
      .catch(() => {});
  }

  async getUserGroups(
    userId: string,
    params: { limit: number; cursor?: string | null; q?: string }
  ): Promise<GroupRoomMembership[]> {
    const memberships = await this.memberRepo.getActiveMemberships(userId);
    if (!memberships.length) return [];
    const clearedByRoom = new Map(
      memberships.map((m) => [m.roomId, m.clearedAt])
    );
    const roomIds = [...clearedByRoom.keys()];
    const rawRooms = (
      await this.roomRepo.getUserGroups(userId, roomIds, params)
    ).filter((r) => isVisibleAfterClear(r, clearedByRoom.get(r.roomId)));
    // Per-user visibility: swap in the viewer's previous-visible preview for any
    // room whose shared last message they have hidden (delete-for-me / global).
    const rooms = await this.applyPerUserPreview(rawRooms, userId);
    // Resolve every room logo on this page ONCE (deduped) → download URLs.
    const avatarUrls = await resolveMediaUrlMap(rooms.map((r) => r.avatar));
    // Every row here is a group the caller is an ACTIVE member of.
    return rooms.map((room) => ({
      ...room,
      avatar: urlFromMap(avatarUrls, room.avatar),
      isJoined: true,
    }));
  }

  async countUserGroups(userId: string, q?: string): Promise<number> {
    const memberships = await this.memberRepo.getActiveMemberships(userId);
    if (!memberships.length) return 0;
    const clearedByRoom = new Map(
      memberships.map((m) => [m.roomId, m.clearedAt])
    );
    const rows = await this.roomRepo.findLastMessageAtForRooms(
      [...clearedByRoom.keys()],
      q
    );
    return rows.filter((r) =>
      isVisibleAfterClear(r, clearedByRoom.get(r.roomId))
    ).length;
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
    /** V2 compound-cursor tiebreaker; omitted on V1 (inclusive bare-ts bound). */
    boundaryId?: string | null;
    inclusive?: boolean;
    limit: number;
  }): Promise<EnrichedGroupRoom[]> {
    const memberships = await this.memberRepo.getActiveMemberships(
      params.userId
    );
    if (!memberships.length) return [];

    const membershipByRoom = new Map(memberships.map((m) => [m.roomId, m]));
    const roomIds = memberships.map((m) => m.roomId);

    const rawRooms = (
      await this.roomRepo.getInboxGroups({
        roomIds,
        direction: params.direction,
        ts: params.ts,
        boundaryId: params.boundaryId,
        inclusive: params.inclusive,
        limit: params.limit,
      })
    ).filter((r) =>
      isVisibleAfterClear(r, membershipByRoom.get(r.roomId)?.clearedAt)
    );
    // Per-user visibility: swap in the viewer's previous-visible preview for any
    // room whose shared last message they have hidden (delete-for-me / global).
    const rooms = await this.applyPerUserPreview(rawRooms, params.userId);

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
