import type {
  PrismaClient,
  PrivateMessagePin,
} from "../generated/prisma/index.js";

export class PrivateMessagePinRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createPin(
    data: {
      roomId: string;
      messageId: string;
      pinnedBy: string;
      messageCreatedAt: Date;
      senderId: string;
      senderDisplayName?: string;
      senderAvatar?: string;
      contentPinned?: object;
      deletedFor?: object;
      [key: string]: unknown;
    },
    _options?: { session?: unknown }
  ): Promise<PrivateMessagePin> {
    return this.prisma.privateMessagePin.create({
      data: {
        roomId: data.roomId,
        messageId: data.messageId,
        pinnedBy: data.pinnedBy,
        messageCreatedAt: data.messageCreatedAt,
        senderId: data.senderId,
        senderDisplayName: data.senderDisplayName ?? "",
        senderAvatar: data.senderAvatar ?? "",
        contentPinned: (data.contentPinned as object) ?? {
          text: "",
          urls: [],
          files: [],
        },
        deletedFor: (data.deletedFor as object) ?? {},
        pinnedAt: (data.pinnedAt as Date) ?? new Date(),
      },
    });
  }

  async deletePin(
    params: { roomId: string; messageId: string; pinnedBy: string },
    _options?: { session?: unknown }
  ): Promise<{ deletedCount: number }> {
    const existing = await this.prisma.privateMessagePin.findFirst({
      where: {
        roomId: params.roomId,
        messageId: params.messageId,
        pinnedBy: params.pinnedBy,
      },
    });
    if (!existing) return { deletedCount: 0 };

    await this.prisma.privateMessagePin.delete({ where: { id: existing.id } });
    return { deletedCount: 1 };
  }

  async countPinsByRoom(
    roomId: string,
    _options?: { session?: unknown }
  ): Promise<number> {
    return this.prisma.privateMessagePin.count({ where: { roomId } });
  }

  async findPinsByRoom(
    roomId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<PrivateMessagePin[]> {
    return this.prisma.privateMessagePin.findMany({
      where: {
        roomId,
        ...(params.cursor ? { pinnedAt: { lt: new Date(params.cursor) } } : {}),
      },
      orderBy: { pinnedAt: "desc" },
      take: params.limit,
    });
  }

  async findByRoomAndMessage(
    roomId: string,
    messageId: string
  ): Promise<PrivateMessagePin | null> {
    return this.prisma.privateMessagePin.findFirst({
      where: { roomId, messageId },
    });
  }
}
