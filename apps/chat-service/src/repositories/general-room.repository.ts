import type { PrismaClient, GeneralRoom } from "../generated/prisma/index.js";

export class GeneralRoomRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findRoomById(roomId: string): Promise<GeneralRoom | null> {
    return this.prisma.generalRoom.findUnique({ where: { id: roomId } });
  }

  async findActiveRooms(): Promise<GeneralRoom[]> {
    return this.prisma.generalRoom.findMany({
      where: { status: "active" },
      orderBy: [{ displayOrder: "asc" }, { lastMessageAt: "desc" }],
    });
  }

  async searchRooms(query: string): Promise<GeneralRoom[]> {
    // Prisma MongoDB doesn't support $regex via the standard API.
    // Use raw query for regex-based search.
    return this.prisma.generalRoom.findMany({
      where: {
        status: "active",
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { title: { contains: query, mode: "insensitive" } },
          { tags: { has: query.toLowerCase() } },
        ],
      },
      orderBy: { memberNumber: "desc" },
      take: 20,
    });
  }

  async countActiveRooms(): Promise<number> {
    return this.prisma.generalRoom.count({ where: { status: "active" } });
  }

  async countSearchResults(query: string): Promise<number> {
    return this.prisma.generalRoom.count({
      where: {
        status: "active",
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { title: { contains: query, mode: "insensitive" } },
          { tags: { has: query.toLowerCase() } },
        ],
      },
    });
  }

  async addLastestMessageToRoom(
    roomId: string,
    message: {
      _id: unknown;
      sentBy: string;
      senderName: string;
      message: string;
      messageType: string;
      createdAt: Date;
    }
  ): Promise<GeneralRoom | null> {
    return this.prisma.generalRoom.update({
      where: { id: roomId },
      data: {
        lastMessageId: String(message._id),
        lastMessageAt: message.createdAt,
        lastMessage: {
          content: message.message,
          senderId: message.sentBy,
          senderName: message.senderName,
          messageType: message.messageType,
          createdAt: message.createdAt,
        },
      },
    });
  }

  async incMemberNumber(roomId: string, inc: number): Promise<void> {
    await this.prisma.generalRoom.update({
      where: { id: roomId },
      data: { memberNumber: { increment: inc } },
    });
  }

  async isRoomMember(_roomId: string, _userId: string): Promise<boolean> {
    // Community rooms are open -- membership is tracked in room_members
    // Return true as a default for general rooms (open communities)
    return true;
  }
}
