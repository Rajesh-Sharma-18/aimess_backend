import { BadRequestError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import { publishChatUserEvent } from "@aimess/redis";

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
import type { UserSnapshotService } from "./user-snapshot.service.js";
import { resolveDisplayName } from "./user-snapshot.service.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
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
  /**
   * Telegram-style tick for the last message, but ONLY meaningful when the
   * CALLER sent it (null otherwise). Three tiers, matching Telegram/WhatsApp:
   *  - SENT: no other active member has been marked delivered yet.
   *  - DELIVERED: at least one other active member is in the message's
   *    `deliveredTo` (populated at send-time from live presence, and topped
   *    up by the presence-connect backfill).
   *  - READ: every other active member's `lastReadMessageId` cursor has caught
   *    up to the last message's sequenceNumber.
   */
  lastMessageReadStatus: "SENT" | "DELIVERED" | "READ" | null;
};

export class GroupRoomService {
  constructor(
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository,
    private readonly inviteLinkRepo: GroupInviteLinkRepository,
    private readonly sysMsg: GroupSystemMessageService,
    private readonly redis: Redis | Cluster,
    private readonly messageRepo: GroupMessageRepository,
    private readonly userSnapshotService?: UserSnapshotService,
    private readonly cacheRepo?: CacheRepository
  ) {}

  /**
   * Overwrite each row's `lastMessagePreview.senderName` with the live snapshot's
   * display name. Old rows persisted before the sender-name resolution fix carry
   * an empty `senderName` frozen in the JSON, which strands the sidebar without
   * a preview prefix — resolving at read time makes those self-heal without a
   * data migration. Silently returns rooms untouched when the snapshot service
   * hasn't been wired (test harnesses).
   */
  private async enrichLastMessageSenderNames<
    T extends {
      roomId: string;
      lastMessagePreview: unknown;
    },
  >(rooms: T[]): Promise<T[]> {
    if (!rooms.length || !this.userSnapshotService || !this.cacheRepo)
      return rooms;
    const senderIds = new Set<string>();
    for (const r of rooms) {
      const lp = r.lastMessagePreview as Record<string, unknown> | null;
      const senderId = (lp?.senderId as string) || "";
      if (senderId) senderIds.add(senderId);
    }
    if (!senderIds.size) return rooms;
    const snaps = await this.userSnapshotService.getUserSnapshotsMap(
      [...senderIds],
      this.cacheRepo
    );
    return rooms.map((r) => {
      const lp = r.lastMessagePreview as Record<string, unknown> | null;
      if (!lp) return r;
      const senderId = (lp.senderId as string) || "";
      const live = senderId ? resolveDisplayName(snaps.get(senderId)) : "";
      const liveName = live && live !== "Unknown User" ? live : "";
      // Prefer the live name whenever we have one — this is the whole point of
      // resolve-on-read (stored value may be empty or stale after a rename).
      // Falls back to the stored senderName only when the snapshot lookup missed.
      const nextSenderName = liveName || (lp.senderName as string) || "";
      return {
        ...r,
        lastMessagePreview: { ...lp, senderName: nextSenderName },
      } as T;
    });
  }

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
   * Batch-resolves the "did every other active member read the caller's last
   * message" tick for a page of rooms — one shared query pass instead of N+1.
   * Rows whose last message wasn't sent by `userId` are left unset (null tick).
   */
  private async computeLastMessageReadStatuses(
    rooms: Array<{
      roomId: string;
      lastMessageId: string | null;
      lastMessagePreview: unknown;
    }>,
    userId: string
  ): Promise<Map<string, "SENT" | "DELIVERED" | "READ">> {
    const result = new Map<string, "SENT" | "DELIVERED" | "READ">();
    const ownRoomIds: string[] = [];
    const lastMessageIdByRoom = new Map<string, string>();
    for (const room of rooms) {
      const senderId = (room.lastMessagePreview as { senderId?: string } | null)
        ?.senderId;
      if (senderId !== userId || !room.lastMessageId) continue;
      ownRoomIds.push(room.roomId);
      lastMessageIdByRoom.set(room.roomId, room.lastMessageId);
    }
    if (!ownRoomIds.length) return result;

    const activeMembersByRoom = new Map(
      await Promise.all(
        ownRoomIds.map(
          async (roomId) =>
            [roomId, await this.memberRepo.findActiveMembers(roomId)] as const
        )
      )
    );

    const idsToResolve = new Set<string>();
    for (const roomId of ownRoomIds) {
      idsToResolve.add(lastMessageIdByRoom.get(roomId) as string);
      for (const member of activeMembersByRoom.get(roomId) ?? []) {
        if (member.userId !== userId && member.lastReadMessageId)
          idsToResolve.add(member.lastReadMessageId);
      }
    }
    const resolvedMessages = idsToResolve.size
      ? await this.messageRepo.findManyByIds([...idsToResolve])
      : [];
    const seqById = new Map(
      resolvedMessages.map((m) => [
        m.id,
        (m as { sequenceNumber?: number }).sequenceNumber ?? 0,
      ])
    );

    // Also pull the full last-message docs (already in resolvedMessages) so
    // we can read `deliveredTo` for the DELIVERED tier without a second query.
    const lastMessageById = new Map(resolvedMessages.map((m) => [m.id, m]));

    for (const roomId of ownRoomIds) {
      const lastMessageId = lastMessageIdByRoom.get(roomId) as string;
      const lastSeq = seqById.get(lastMessageId) ?? 0;
      const others = (activeMembersByRoom.get(roomId) ?? []).filter(
        (m) => m.userId !== userId
      );
      const allRead =
        others.length > 0 &&
        lastSeq > 0 &&
        others.every(
          (m) =>
            (m.lastReadMessageId
              ? (seqById.get(m.lastReadMessageId) ?? 0)
              : 0) >= lastSeq
        );
      if (allRead) {
        result.set(roomId, "READ");
        continue;
      }
      const lastMsg = lastMessageById.get(lastMessageId) as
        | { deliveredTo?: unknown }
        | undefined;
      const deliveredTo = Array.isArray(lastMsg?.deliveredTo)
        ? (lastMsg.deliveredTo as string[])
        : [];
      const otherIds = new Set(others.map((m) => m.userId));
      const anyDelivered = deliveredTo.some((id) => otherIds.has(id));
      result.set(roomId, anyDelivered ? "DELIVERED" : "SENT");
    }
    return result;
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
      memberLimit: params.memberLimit || 256,
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
    const finalRoom = fresh ?? room;

    // Creator isn't in `conv:<roomId>` yet (joined only via explicit client
    // `conv:join`), so push the new group to their personal `user:<id>` channel
    // — same `group:added` shape group-member.service.ts uses for later adds,
    // so the existing frontend listener upserts it into the inbox with no
    // client-side change. Fire-and-forget: a publish failure must never fail
    // creation (mirrors PrivateRoomService's conv:created).
    publishChatUserEvent(this.redis, params.createdBy, "group:added", {
      type: "GROUP",
      roomId: finalRoom.roomId,
      lastMessageAt: finalRoom.lastMessageAt,
      lastMessageId: finalRoom.lastMessageId,
      lastMessage: finalRoom.lastMessagePreview ?? null,
      unreadCount: 0,
      isMuted: false,
      pinnedCount: finalRoom.pinnedCount,
      peer: null,
      name: finalRoom.name,
      avatar: finalRoom.avatar,
      description: finalRoom.description,
      memberCount: finalRoom.memberCount,
      role: member.role,
      isJoined: true,
      addedAt: member.joinedAt,
    }).catch((err: unknown) => {
      logger.warn(
        `GroupRoomService|createGroup|group:added publish failed room=${roomId} user=${params.createdBy}: ${String(err)}`
      );
    });

    return { room: finalRoom, member };
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

    // Real-time meta fan-out so every member's inbox row + open group header
    // updates without a refresh (parity with community:meta:updated). Fires only
    // when a presentational field changed. Resolves the avatar object-key to a
    // presigned URL at the publish boundary — raw keys must never leak on the wire.
    const nameChanged = data.name != null && data.name !== room.name;
    const avatarChanged = data.avatar != null && data.avatar !== room.avatar;
    const descriptionChanged =
      data.description != null && data.description !== room.description;
    if (nameChanged || avatarChanged || descriptionChanged) {
      void (async () => {
        try {
          const members = await this.memberRepo.findActiveMembers(roomId);
          if (!members.length) return;
          const resolvedAvatar = await resolveMediaUrl(updated.avatar ?? "");
          const payload = {
            type: "GROUP" as const,
            roomId,
            name: updated.name,
            avatar: resolvedAvatar,
            description: updated.description,
            memberCount: updated.memberCount,
            updatedBy: userId,
            updatedAt: Date.now(),
          };
          const pipeline = this.redis.pipeline();
          for (const m of members) {
            pipeline.publish(
              `user:${m.userId}`,
              JSON.stringify({ event: "group:meta:updated", data: payload })
            );
          }
          await pipeline.exec();
        } catch (err) {
          logger.warn(
            `GroupRoomService|updateRoom|group:meta:updated publish failed room=${roomId}: ${String(err)}`
          );
        }
      })();
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
    const rooms = await this.enrichLastMessageSenderNames(
      await this.applyPerUserPreview(rawRooms, userId)
    );
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
    const rooms = await this.enrichLastMessageSenderNames(
      await this.applyPerUserPreview(rawRooms, params.userId)
    );

    // Resolve every room logo on this page ONCE (deduped) → download URLs, so
    // the unified inbox renders a usable avatar instead of a raw object key.
    const avatarUrls = await resolveMediaUrlMap(rooms.map((r) => r.avatar));
    const readStatusByRoom = await this.computeLastMessageReadStatuses(
      rooms,
      params.userId
    );

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
        lastMessageReadStatus: readStatusByRoom.get(room.roomId) ?? null,
      };
    });
  }
}
