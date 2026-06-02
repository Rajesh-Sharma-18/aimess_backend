import type { PrismaClient, GroupMember } from "../generated/prisma/index.js";

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

  async incUnreadForRoom(roomId: string, excludeUserId: string): Promise<void> {
    await this.prisma.groupMember.updateMany({
      where: {
        roomId,
        status: "ACTIVE",
        userId: { not: excludeUserId },
      },
      data: { unreadCount: { increment: 1 } },
    });
  }

  async countActiveMembers(roomId: string): Promise<number> {
    return this.prisma.groupMember.count({
      where: { roomId, status: "ACTIVE" },
    });
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
