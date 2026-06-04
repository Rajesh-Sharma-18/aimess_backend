import type { PrismaClient, GroupRoom } from "../generated/prisma/index.js";

export class GroupRoomRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    roomId: string;
    name: string;
    createdBy: string;
    [key: string]: unknown;
  }): Promise<GroupRoom> {
    return this.prisma.groupRoom.create({
      data: {
        roomId: data.roomId,
        type: (data.type as string) ?? "GROUP",
        name: data.name,
        avatar: (data.avatar as string) ?? "",
        description: (data.description as string) ?? "",
        createdBy: data.createdBy,
        status: (data.status as string) ?? "ACTIVE",
        memberLimit: (data.memberLimit as number) ?? 50,
        memberCount: (data.memberCount as number) ?? 1,
        settings: (data.settings as object) ?? {
          allowMemberInviteLink: true,
          allowMemberSendInviteLink: true,
          allowReply: true,
          allowPin: true,
        },
        lastMessageId: (data.lastMessageId as string) ?? null,
        lastMessageAt: (data.lastMessageAt as Date) ?? null,
        lastMessagePreview: (data.lastMessagePreview as object) ?? null,
        pinnedCount: (data.pinnedCount as number) ?? 0,
        lastPinnedAt: (data.lastPinnedAt as Date) ?? null,
        disbandedAt: (data.disbandedAt as Date) ?? null,
        disbandedBy: (data.disbandedBy as string) ?? null,
      },
    });
  }

  /** Count of active group rooms — admin dashboard aggregate. */
  async countActive(): Promise<number> {
    return this.prisma.groupRoom.count({ where: { status: "ACTIVE" } });
  }

  async allocateSequence(roomId: string): Promise<number> {
    const r = await this.prisma.groupRoom.update({
      where: { roomId },
      data: { lastSequence: { increment: 1 } },
      select: { lastSequence: true },
    });
    return r.lastSequence;
  }

  async findByRoomId(roomId: string): Promise<GroupRoom | null> {
    return this.prisma.groupRoom.findUnique({ where: { roomId } });
  }

  async findActiveByRoomId(roomId: string): Promise<GroupRoom | null> {
    return this.prisma.groupRoom.findFirst({
      where: { roomId, status: "ACTIVE" },
    });
  }

  async updateRoom(
    roomId: string,
    data: Record<string, unknown>
  ): Promise<GroupRoom | null> {
    return this.prisma.groupRoom.update({
      where: { roomId },
      data: data as Parameters<typeof this.prisma.groupRoom.update>[0]["data"],
    });
  }

  async updateLastMessage(
    roomId: string,
    message: {
      _id: unknown;
      senderId: string | null;
      senderName: string;
      messageType: string;
      content: { text: string };
      createdAt: Date;
    }
  ): Promise<GroupRoom | null> {
    return this.prisma.groupRoom.update({
      where: { roomId },
      data: {
        lastMessageId: String(message._id),
        lastMessageAt: message.createdAt,
        lastMessagePreview: {
          text: message.content?.text || "",
          senderId: message.senderId,
          senderName: message.senderName,
          messageType: message.messageType,
          createdAt: message.createdAt,
        },
      },
    });
  }

  async incMemberCount(roomId: string, inc: number): Promise<GroupRoom | null> {
    return this.prisma.groupRoom.update({
      where: { roomId },
      data: { memberCount: { increment: inc } },
    });
  }

  async incPinnedCount(roomId: string, inc: number): Promise<GroupRoom | null> {
    return this.prisma.groupRoom.update({
      where: { roomId },
      data: {
        pinnedCount: { increment: inc },
        ...(inc > 0 ? { lastPinnedAt: new Date() } : {}),
      },
    });
  }

  async disband(roomId: string, userId: string): Promise<GroupRoom | null> {
    return this.prisma.groupRoom.update({
      where: { roomId },
      data: {
        status: "DISBANDED",
        disbandedAt: new Date(),
        disbandedBy: userId,
      },
    });
  }

  async getUserGroups(
    _userId: string,
    roomIds: string[],
    params: { limit: number; cursor?: string | null }
  ): Promise<GroupRoom[]> {
    return this.prisma.groupRoom.findMany({
      where: {
        roomId: { in: roomIds },
        status: "ACTIVE",
        ...(params.cursor
          ? { lastMessageAt: { lt: new Date(params.cursor) } }
          : {}),
      },
      orderBy: { lastMessageAt: "desc" },
      take: params.limit,
    });
  }

  async countUserGroups(roomIds: string[]): Promise<number> {
    return this.prisma.groupRoom.count({
      where: { roomId: { in: roomIds }, status: "ACTIVE" },
    });
  }

  /**
   * Timestamp-bounded group fetch for the unified inbox.
   * - direction "before": lastMessageAt <= ts, newest-first (desc).
   * - direction "after" : lastMessageAt >= ts, oldest-first (asc).
   * Only ACTIVE groups the user belongs to (roomIds) with a lastMessageAt.
   */
  async getInboxGroups(params: {
    roomIds: string[];
    direction: "before" | "after";
    ts: Date;
    limit: number;
  }): Promise<GroupRoom[]> {
    const bound =
      params.direction === "before"
        ? { lte: params.ts, not: null }
        : { gte: params.ts, not: null };
    const dir = params.direction === "before" ? "desc" : "asc";
    return this.prisma.groupRoom.findMany({
      where: {
        roomId: { in: params.roomIds },
        status: "ACTIVE",
        lastMessageAt: bound,
      },
      orderBy: [{ lastMessageAt: dir }, { roomId: dir }],
      take: params.limit,
    });
  }
}
