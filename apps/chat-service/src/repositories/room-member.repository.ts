import type { PrismaClient, RoomMember } from "../generated/prisma/index.js";

export class RoomMemberRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByRoomAndUser(
    roomId: string,
    userId: string
  ): Promise<RoomMember | null> {
    return this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
  }

  async upsert(
    roomId: string,
    userId: string,
    data: Record<string, unknown>
  ): Promise<RoomMember> {
    return this.prisma.roomMember.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: {
        roomId,
        userId,
        status: (data.status as string) ?? "active",
        role: (data.role as string) ?? "member",
        joinedAt: (data.joinedAt as Date) ?? new Date(),
        leftAt: (data.leftAt as Date) ?? null,
        bannedAt: (data.bannedAt as Date) ?? null,
        banInfo: (data.banInfo as object) ?? null,
      },
      update: {
        ...data,
      } as Parameters<typeof this.prisma.roomMember.update>[0]["data"],
    });
  }

  async updateStatus(
    roomId: string,
    userId: string,
    status: string,
    extra?: Record<string, unknown>
  ): Promise<RoomMember | null> {
    return this.prisma.roomMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { status, ...extra } as Parameters<
        typeof this.prisma.roomMember.update
      >[0]["data"],
    });
  }

  /**
   * Advance the member's read pointer to a specific message, forward-only: the
   * pointer is moved only when `messageCreatedAt` is newer than the stored
   * `lastReadAt` (never regresses). No-op if the member isn't active.
   */
  async advanceReadPointer(
    roomId: string,
    userId: string,
    messageId: string,
    messageCreatedAt: Date
  ): Promise<RoomMember | null> {
    const existing = await this.prisma.roomMember.findFirst({
      where: { roomId, userId, status: "active" },
    });
    if (!existing) return null;

    // Forward-only: skip if the stored pointer is already at/after this message.
    if (existing.lastReadAt && existing.lastReadAt >= messageCreatedAt) {
      return existing;
    }

    return this.prisma.roomMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: {
        lastReadMessageId: messageId,
        lastReadAt: messageCreatedAt,
      },
    });
  }

  /** Mark every active member of a room as left (community disbanded/deleted). */
  async markAllLeft(roomId: string): Promise<void> {
    await this.prisma.roomMember.updateMany({
      where: { roomId, status: "active" },
      data: { status: "left", leftAt: new Date() },
    });
  }

  async isBanned(roomId: string, userId: string): Promise<boolean> {
    const member = await this.prisma.roomMember.findFirst({
      where: { roomId, userId, status: "banned" },
    });
    return member !== null;
  }

  async findActiveByRoom(roomId: string): Promise<RoomMember[]> {
    return this.prisma.roomMember.findMany({
      where: { roomId, status: "active" },
    });
  }

  async attachSenderRoomStatus(
    roomId: string,
    messages: Array<Record<string, unknown>>
  ): Promise<Array<Record<string, unknown>>> {
    const senderIds = [
      ...new Set(messages.map((m) => String(m.sentBy || "")).filter(Boolean)),
    ];
    if (!senderIds.length) return messages;

    const members = await this.prisma.roomMember.findMany({
      where: {
        roomId,
        userId: { in: senderIds },
      },
      select: { userId: true, status: true, role: true },
    });

    const statusMap = new Map(members.map((m) => [m.userId, m]));

    return messages.map((msg) => {
      const memberInfo = statusMap.get(String(msg.sentBy || ""));
      return {
        ...msg,
        senderRoomStatus: memberInfo?.status || null,
        senderRoomRole: memberInfo?.role || null,
      };
    });
  }
}
