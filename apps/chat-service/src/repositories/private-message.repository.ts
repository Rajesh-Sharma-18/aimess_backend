import type {
  PrismaClient,
  PrivateMessage,
  Prisma,
} from "../generated/prisma/index.js";

export class PrivateMessageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createMessage(data: {
    roomId: string;
    senderId?: string;
    receiverId?: string;
    content?: object;
    messageType?: string;
    systemEvent?: string | null;
    systemData?: object | null;
    readBy?: unknown[];
    reactions?: object;
    inviteLinkData?: object | null;
    parentMessageId?: string | null;
    quoteData?: object | null;
    clientInfo?: object | null;
    deletedFor?: object;
    isDeleted?: boolean;
    [key: string]: unknown;
  }): Promise<PrivateMessage> {
    return this.prisma.privateMessage.create({
      data: {
        roomId: data.roomId,
        senderId: data.senderId ?? null,
        receiverId: data.receiverId ?? null,
        content: (data.content as object) ?? { text: "", urls: [], files: [] },
        messageType: data.messageType ?? "TEXT",
        systemEvent: data.systemEvent ?? null,
        systemData: (data.systemData as object) ?? null,
        readBy: (data.readBy as object) ?? [],
        reactions: (data.reactions as object) ?? {},
        inviteLinkData: (data.inviteLinkData as object) ?? null,
        parentMessageId: data.parentMessageId ?? null,
        quoteData: (data.quoteData as object) ?? null,
        clientInfo: (data.clientInfo as object) ?? null,
        deletedFor: (data.deletedFor as object) ?? {},
        isDeleted: data.isDeleted ?? false,
        createdAt: (data.createdAt as Date) ?? new Date(),
      },
    });
  }

  async findById(messageId: string): Promise<PrivateMessage | null> {
    return this.prisma.privateMessage.findUnique({ where: { id: messageId } });
  }

  async findMessageMeta(
    params: { roomId: string; messageId: string },
    _options?: { session?: unknown }
  ): Promise<PrivateMessage | null> {
    return this.prisma.privateMessage.findFirst({
      where: {
        id: params.messageId,
        roomId: params.roomId,
      },
    });
  }

  async findByRoomIdWithTime(
    userId: string,
    room: { roomId: string; deletedFor?: Record<string, unknown> | null },
    beforeTimestamp: string,
    limit: number
  ): Promise<PrivateMessage[]> {
    // Build time constraint
    const ltDate = new Date(beforeTimestamp);
    let gtDate: Date | undefined;

    const deletedFor = room.deletedFor;
    if (deletedFor) {
      const deletedAt = deletedFor[userId];
      if (deletedAt) {
        gtDate = new Date(deletedAt as string);
      }
    }

    // Prisma doesn't support filtering "key not in JSON map" directly for MongoDB.
    // We fetch and filter in memory for the deletedFor check on the message level.
    const messages = await this.prisma.privateMessage.findMany({
      where: {
        roomId: room.roomId,
        createdAt: {
          lt: ltDate,
          ...(gtDate ? { gt: gtDate } : {}),
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit + 10, // fetch extra to account for filtering
    });

    // Filter out messages deleted for this user
    return messages
      .filter((msg) => {
        const msgDeletedFor = (msg.deletedFor ?? {}) as Record<string, unknown>;
        return !(userId in msgDeletedFor);
      })
      .slice(0, limit);
  }

  async searchByText(
    roomId: string,
    query: string,
    limit: number
  ): Promise<PrivateMessage[]> {
    // content.text lives inside a Json column, which Prisma's `contains` can't
    // target — use a raw regex query to find matching ids, then re-fetch via
    // the typed client so results have the normal message shape.
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const raw = (await this.prisma.privateMessage.findRaw({
      filter: {
        roomId,
        isDeleted: false,
        "content.text": { $regex: escaped, $options: "i" },
      },
      options: { sort: { createdAt: -1 }, limit },
    })) as unknown as Array<{ _id?: { $oid?: string } | string }>;

    const ids = raw
      .map((doc) => (typeof doc._id === "string" ? doc._id : doc._id?.$oid))
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return [];

    return this.prisma.privateMessage.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: "desc" },
    });
  }

  async addReactions(
    messageId: string,
    reactions: Record<string, unknown[]>
  ): Promise<PrivateMessage | null> {
    return this.prisma.privateMessage.update({
      where: { id: messageId },
      data: { reactions: reactions as unknown as Prisma.InputJsonValue },
    });
  }

  async deleteForMe(
    messageId: string,
    userId: string
  ): Promise<PrivateMessage> {
    return this.prisma.privateMessage.update({
      where: { id: messageId },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        deletedFor: { type: "forMe" } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async deleteForEveryone(
    messageId: string,
    userId: string
  ): Promise<PrivateMessage> {
    return this.prisma.privateMessage.update({
      where: { id: messageId },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        deletedFor: { type: "forEveryone" } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async countSearchResults(roomId: string, query: string): Promise<number> {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const result = (await this.prisma.privateMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId,
            isDeleted: false,
            "content.text": { $regex: escaped, $options: "i" },
          },
        },
        { $count: "total" },
      ],
    })) as unknown as Array<{ total: number }>;
    return result[0]?.total ?? 0;
  }

  async countByRoom(roomId: string): Promise<number> {
    return this.prisma.privateMessage.count({
      where: { roomId, isDeleted: false },
    });
  }
}
