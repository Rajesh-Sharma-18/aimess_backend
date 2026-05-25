import type {
  PrismaClient,
  GeneralRoomMessage,
  Prisma,
} from "../generated/prisma/index.js";

export class GeneralRoomMessageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async save(data: {
    roomId: string;
    sentBy: string;
    [key: string]: unknown;
  }): Promise<GeneralRoomMessage> {
    return this.prisma.generalRoomMessage.create({
      data: {
        roomId: data.roomId,
        sentBy: data.sentBy,
        senderName: (data.senderName as string) ?? null,
        senderAvatar: (data.senderAvatar as string) ?? null,
        message: (data.message as string) ?? null,
        reactions: (data.reactions as object) ?? {},
        parentMessageId: (data.parentMessageId as string) ?? null,
        quoteData: (data.quoteData as object) ?? null,
        messageType: (data.messageType as string) ?? "text",
        attachments: (data.attachments as object) ?? [],
        clientMessageId: (data.clientMessageId as string) ?? null,
        deletedBy: (data.deletedBy as object) ?? [],
        deletedForAll: (data.deletedForAll as boolean) ?? false,
        reports: (data.reports as object) ?? [],
      },
    });
  }

  async findById(messageId: string): Promise<GeneralRoomMessage | null> {
    return this.prisma.generalRoomMessage.findUnique({
      where: { id: messageId },
    });
  }

  async findOne(
    filter: Record<string, unknown>
  ): Promise<GeneralRoomMessage | null> {
    // Map common filter patterns to Prisma where clause
    const where: Record<string, unknown> = {};
    if (filter.roomId) where.roomId = filter.roomId;
    if (filter.sentBy) where.sentBy = filter.sentBy;
    if (filter.clientMessageId) where.clientMessageId = filter.clientMessageId;
    if (filter._id) where.id = filter._id;

    return this.prisma.generalRoomMessage.findFirst({ where });
  }

  async findByRoomIdWithTime(
    roomId: string,
    beforeTimestamp: string,
    _direction: string,
    limit: number,
    userId: string
  ): Promise<GeneralRoomMessage[]> {
    // Prisma MongoDB doesn't support $nin on JSON arrays directly.
    // Fetch and filter in memory for deletedBy.
    const messages = await this.prisma.generalRoomMessage.findMany({
      where: {
        roomId,
        createdAt: { lt: new Date(beforeTimestamp) },
        deletedForAll: false,
      },
      orderBy: { createdAt: "desc" },
      take: limit + 10,
    });

    // Filter out messages where this user is in deletedBy
    return messages
      .filter((msg) => {
        const deletedBy = (msg.deletedBy ?? []) as string[];
        return !deletedBy.includes(userId);
      })
      .slice(0, limit);
  }

  async searchByText(
    roomId: string,
    query: string,
    limit: number,
    userId: string
  ): Promise<GeneralRoomMessage[]> {
    // `message` is a top-level String field, so a case-insensitive `contains`
    // works directly.
    const messages = await this.prisma.generalRoomMessage.findMany({
      where: {
        roomId,
        deletedForAll: false,
        message: { contains: query, mode: "insensitive" },
      },
      orderBy: { createdAt: "desc" },
      take: limit + 10,
    });

    return messages
      .filter((msg) => {
        const deletedBy = (msg.deletedBy ?? []) as string[];
        return !deletedBy.includes(userId);
      })
      .slice(0, limit);
  }

  async countSearchResults(roomId: string, query: string): Promise<number> {
    return this.prisma.generalRoomMessage.count({
      where: {
        roomId,
        deletedForAll: false,
        message: { contains: query, mode: "insensitive" },
      },
    });
  }

  async countByRoom(roomId: string): Promise<number> {
    return this.prisma.generalRoomMessage.count({
      where: { roomId, deletedForAll: false },
    });
  }

  async updateById(
    _roomId: string,
    messageId: string,
    reactions: Record<string, unknown[]>
  ): Promise<GeneralRoomMessage | null> {
    return this.prisma.generalRoomMessage.update({
      where: { id: messageId },
      data: { reactions: reactions as unknown as Prisma.InputJsonValue },
    });
  }

  async deleteForUser(messageId: string, userId: string): Promise<void> {
    const existing = await this.prisma.generalRoomMessage.findUnique({
      where: { id: messageId },
    });
    if (!existing) return;

    const deletedBy = (existing.deletedBy ?? []) as string[];
    if (!deletedBy.includes(userId)) {
      deletedBy.push(userId);
    }

    await this.prisma.generalRoomMessage.update({
      where: { id: messageId },
      data: { deletedBy },
    });
  }

  async deleteForAll(messageId: string): Promise<GeneralRoomMessage | null> {
    return this.prisma.generalRoomMessage.update({
      where: { id: messageId },
      data: { deletedForAll: true },
    });
  }

  async addReport(
    messageId: string,
    report: { userReportId: string; userReportReason: string }
  ): Promise<GeneralRoomMessage | null> {
    const existing = await this.prisma.generalRoomMessage.findUnique({
      where: { id: messageId },
    });
    if (!existing) return null;

    const reports = (existing.reports ?? []) as Array<Record<string, unknown>>;
    reports.push({ ...report, reportedAt: new Date() });

    return this.prisma.generalRoomMessage.update({
      where: { id: messageId },
      data: { reports: reports as unknown as Prisma.InputJsonValue },
    });
  }
}
