import type { PrismaClient, GroupMember } from "../generated/prisma/index.js";
import { withWriteConflictRetry } from "../lib/db-errors.js";

export class GroupMemberRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    roomId: string;
    userId: string;
    [key: string]: unknown;
  }): Promise<GroupMember> {
    return this.prisma.groupMember.create({
      data: {
        roomId: data.roomId,
        userId: data.userId,
        role: (data.role as string) ?? "MEMBER",
        status: (data.status as string) ?? "ACTIVE",
        joinedAt: (data.joinedAt as Date) ?? new Date(),
        invitedBy: (data.invitedBy as string) ?? null,
        leftAt: (data.leftAt as Date) ?? null,
        kickedAt: (data.kickedAt as Date) ?? null,
        kickedBy: (data.kickedBy as string) ?? null,
        kickReason: (data.kickReason as string) ?? null,
        bannedAt: (data.bannedAt as Date) ?? null,
        bannedBy: (data.bannedBy as string) ?? null,
        lastReadMessageId: (data.lastReadMessageId as string) ?? null,
        lastReadAt: (data.lastReadAt as Date) ?? null,
        unreadCount: (data.unreadCount as number) ?? 0,
        notificationSettings: (data.notificationSettings as object) ?? {
          mute: false,
          muteUntil: null,
        },
      },
    });
  }

  async findByRoomAndUser(
    roomId: string,
    userId: string
  ): Promise<GroupMember | null> {
    return this.prisma.groupMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
  }

  async findActiveByRoomAndUser(
    roomId: string,
    userId: string
  ): Promise<GroupMember | null> {
    return this.prisma.groupMember.findFirst({
      where: { roomId, userId, status: "ACTIVE" },
    });
  }

  async findActiveMembers(
    roomId: string,
    params?: { limit?: number; cursor?: string | null }
  ): Promise<GroupMember[]> {
    return this.prisma.groupMember.findMany({
      where: {
        roomId,
        status: "ACTIVE",
        ...(params?.cursor
          ? { joinedAt: { gt: new Date(params.cursor) } }
          : {}),
      },
      orderBy: { joinedAt: "asc" },
      ...(params?.limit ? { take: params.limit } : {}),
    });
  }

  async getActiveRoomIds(userId: string): Promise<string[]> {
    const members = await this.prisma.groupMember.findMany({
      where: { userId, status: "ACTIVE" },
      select: { roomId: true },
    });
    return members.map((m) => m.roomId);
  }

  /**
   * Active memberships for a user with the per-room fields the inbox needs to
   * enrich each group item (unread count, mute state, role) without a second
   * round trip per room.
   */
  async getActiveMemberships(userId: string): Promise<
    Array<{
      roomId: string;
      role: string;
      unreadCount: number;
      notificationSettings: GroupMember["notificationSettings"];
      clearedAt: Date | null;
    }>
  > {
    return this.prisma.groupMember.findMany({
      where: { userId, status: "ACTIVE" },
      select: {
        roomId: true,
        role: true,
        unreadCount: true,
        notificationSettings: true,
        clearedAt: true,
      },
    });
  }

  /**
   * "Delete Conversation" for a group: the member stays ACTIVE (unlike Leave)
   * but hides all history up to now — mirrors PrivateRoomRepository.setDeletedFor.
   * Also zeroes unread state so a phantom count doesn't survive the cutoff.
   */
  async setClearedAt(roomId: string, userId: string): Promise<void> {
    await this.prisma.groupMember.updateMany({
      where: { roomId, userId, status: "ACTIVE" },
      data: {
        clearedAt: new Date(),
        unreadCount: 0,
        lastReadAt: new Date(),
      },
    });
  }

  async updateStatus(
    roomId: string,
    userId: string,
    status: string,
    extra?: Record<string, unknown>
  ): Promise<GroupMember | null> {
    return this.prisma.groupMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { status, ...extra } as Parameters<
        typeof this.prisma.groupMember.update
      >[0]["data"],
    });
  }

  async updateRole(
    roomId: string,
    userId: string,
    role: string
  ): Promise<GroupMember | null> {
    return this.prisma.groupMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { role },
    });
  }

  /**
   * Personal (per-member) notification mute — mirrors PrivateRoomRepository's
   * setMuted/setUnmuted, but stored on the GroupMember row itself since group
   * mute is per-membership, not per-room. `notificationSettings.mute`/
   * `muteUntil` were already read by GroupRoomService.getInboxGroups; this was
   * the missing write path.
   */
  async setMuted(
    roomId: string,
    userId: string,
    muteUntil: Date | null
  ): Promise<GroupMember | null> {
    const existing = await this.prisma.groupMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!existing) return null;
    return this.prisma.groupMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: {
        notificationSettings: {
          mute: true,
          muteUntil: muteUntil ? muteUntil.toISOString() : null,
        },
      },
    });
  }

  async setUnmuted(
    roomId: string,
    userId: string
  ): Promise<GroupMember | null> {
    const existing = await this.prisma.groupMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!existing) return null;
    return this.prisma.groupMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { notificationSettings: { mute: false, muteUntil: null } },
    });
  }

  async markRead(
    roomId: string,
    userId: string,
    lastMessageId: string
  ): Promise<GroupMember | null> {
    // Only update if the member is ACTIVE
    const existing = await this.prisma.groupMember.findFirst({
      where: { roomId, userId, status: "ACTIVE" },
    });
    if (!existing) return null;

    return this.prisma.groupMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: {
        lastReadMessageId: lastMessageId,
        lastReadAt: new Date(),
        unreadCount: 0,
      },
    });
  }

  /**
   * Advance the member's read pointer to a specific message, forward-only: the
   * pointer is moved only when `messageCreatedAt` is newer than the stored
   * `lastReadAt` (never regresses). No-op if the member isn't ACTIVE.
   *
   * `remainingUnread` is the count of messages still newer than the NEW pointer
   * that are visible to this user (computed by the caller). We set `unreadCount`
   * to that instead of hard-zeroing, so viewing an OLD page (whose newest message
   * still post-dates messages the user hasn't seen) doesn't wrongly clear unread.
   */
  async advanceReadPointer(
    roomId: string,
    userId: string,
    messageId: string,
    messageCreatedAt: Date,
    remainingUnread: number
  ): Promise<GroupMember | null> {
    const existing = await this.prisma.groupMember.findFirst({
      where: { roomId, userId, status: "ACTIVE" },
    });
    if (!existing) return null;

    // Forward-only: skip if the stored pointer is already at/after this message.
    if (existing.lastReadAt && existing.lastReadAt >= messageCreatedAt) {
      return existing;
    }

    return this.prisma.groupMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: {
        lastReadMessageId: messageId,
        lastReadAt: messageCreatedAt,
        unreadCount: remainingUnread < 0 ? 0 : remainingUnread,
      },
    });
  }

  async incUnreadForRoom(
    roomId: string,
    excludeUserId: string,
    increment = 1
  ): Promise<void> {
    if (increment <= 0) return;
    // Same write-conflict-retry as GroupRoomRepository.updateLastMessage — this
    // `$inc updateMany` and that room bump land moments apart for every send;
    // without the retry, a transient P2034 here (and only here) desyncs the
    // inbox's unread badge from its already-bumped lastActivity/preview.
    await withWriteConflictRetry(() =>
      this.prisma.groupMember.updateMany({
        where: {
          roomId,
          status: "ACTIVE",
          userId: { not: excludeUserId },
        },
        data: { unreadCount: { increment } },
      })
    );
  }

  async decrementUnreadForMessage(params: {
    roomId: string;
    senderId: string | null;
    messageCreatedAt: Date;
  }): Promise<void> {
    await this.prisma.groupMember.updateMany({
      where: {
        roomId: params.roomId,
        status: "ACTIVE",
        unreadCount: { gt: 0 },
        ...(params.senderId ? { userId: { not: params.senderId } } : {}),
        OR: [
          { lastReadAt: null },
          { lastReadAt: { lt: params.messageCreatedAt } },
        ],
      },
      data: { unreadCount: { decrement: 1 } },
    });
  }

  async countActiveMembers(roomId: string): Promise<number> {
    return this.prisma.groupMember.count({
      where: { roomId, status: "ACTIVE" },
    });
  }

  /**
   * Admin Group Management: map each given roomId → its ACTIVE owner userId.
   * Rooms without an OWNER row are simply absent (callers fall back to
   * GroupRoom.createdBy).
   */
  async findOwnersForRooms(roomIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const ids = [...new Set(roomIds.filter(Boolean))];
    if (!ids.length) return map;
    const owners = await this.prisma.groupMember.findMany({
      where: { role: "OWNER", status: "ACTIVE", roomId: { in: ids } },
      select: { roomId: true, userId: true },
    });
    for (const o of owners) {
      if (!map.has(o.roomId)) map.set(o.roomId, o.userId);
    }
    return map;
  }

  /**
   * Admin Group Management: roomIds OWNED by any of the given userIds. Used to
   * widen the group-list `q` search to owner identity matches.
   */
  async findRoomIdsByOwnerUserIds(userIds: string[]): Promise<string[]> {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return [];
    const rows = await this.prisma.groupMember.findMany({
      where: { role: "OWNER", userId: { in: ids } },
      select: { roomId: true },
    });
    return [...new Set(rows.map((r) => r.roomId))];
  }

  /**
   * Admin Group Management: filterable/paginated ACTIVE members of one room.
   * `userIdsFromSearch` (free-text identity matches) and `qExactUserId` (a UUID
   * pasted verbatim) both constrain to a userId set when present.
   */
  async adminListMembers(params: {
    roomId: string;
    role?: string;
    userIdsFromSearch?: string[] | null;
    qExactUserId?: string | null;
    skip: number;
    take: number;
  }): Promise<{ rows: GroupMember[]; total: number }> {
    const { roomId, role, userIdsFromSearch, qExactUserId, skip, take } =
      params;

    const and: Array<Record<string, unknown>> = [
      { roomId },
      { status: "ACTIVE" },
    ];
    if (role) and.push({ role });
    if (userIdsFromSearch || qExactUserId) {
      const dedup = [
        ...new Set([
          ...(userIdsFromSearch ?? []),
          ...(qExactUserId ? [qExactUserId] : []),
        ]),
      ];
      and.push({ userId: { in: dedup } });
    }

    type FindArgs = Parameters<typeof this.prisma.groupMember.findMany>[0];
    type WhereArg = NonNullable<FindArgs>["where"];
    const where = { AND: and } as WhereArg;

    const [rows, total] = await Promise.all([
      this.prisma.groupMember.findMany({
        where,
        orderBy: { joinedAt: "asc" },
        skip,
        take,
      }),
      this.prisma.groupMember.count({ where }),
    ]);

    return { rows, total };
  }

  async upsert(
    roomId: string,
    userId: string,
    data: Record<string, unknown>
  ): Promise<GroupMember> {
    return this.prisma.groupMember.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: {
        roomId,
        userId,
        role: (data.role as string) ?? "MEMBER",
        status: (data.status as string) ?? "ACTIVE",
        joinedAt: (data.joinedAt as Date) ?? new Date(),
        invitedBy: (data.invitedBy as string) ?? null,
        unreadCount: (data.unreadCount as number) ?? 0,
        notificationSettings: (data.notificationSettings as object) ?? {
          mute: false,
          muteUntil: null,
        },
      },
      update: {
        ...data,
      } as Parameters<typeof this.prisma.groupMember.update>[0]["data"],
    });
  }
}
