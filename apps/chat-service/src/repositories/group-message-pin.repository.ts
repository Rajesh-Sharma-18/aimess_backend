import type {
  PrismaClient,
  GroupMessagePin,
} from "../generated/prisma/index.js";

export class GroupMessagePinRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createPin(data: {
    roomId: string;
    messageId: string;
    pinnedBy: string;
    messageCreatedAt: Date;
    senderId: string;
    [key: string]: unknown;
  }): Promise<GroupMessagePin> {
    return this.prisma.groupMessagePin.create({
      data: {
        roomId: data.roomId,
        messageId: data.messageId,
        pinnedBy: data.pinnedBy,
        pinnedAt: (data.pinnedAt as Date) ?? new Date(),
        messageCreatedAt: data.messageCreatedAt,
        senderId: data.senderId,
        senderDisplayName: (data.senderDisplayName as string) ?? "",
        senderAvatar: (data.senderAvatar as string) ?? "",
        contentPinned: (data.contentPinned as object) ?? {
          text: "",
          urls: [],
          files: [],
        },
      },
    });
  }

  async deletePin(
    roomId: string,
    messageId: string
  ): Promise<{ deletedCount: number }> {
    const existing = await this.prisma.groupMessagePin.findFirst({
      where: { roomId, messageId },
    });
    if (!existing) return { deletedCount: 0 };

    await this.prisma.groupMessagePin.delete({ where: { id: existing.id } });
    return { deletedCount: 1 };
  }

  async countPinsByRoom(roomId: string): Promise<number> {
    return this.prisma.groupMessagePin.count({ where: { roomId } });
  }

  async findPinsByRoom(
    roomId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<GroupMessagePin[]> {
    return this.prisma.groupMessagePin.findMany({
      where: {
        roomId,
        ...(params.cursor ? { pinnedAt: { lt: new Date(params.cursor) } } : {}),
      },
      orderBy: { pinnedAt: "desc" },
      take: params.limit,
    });
  }
}
