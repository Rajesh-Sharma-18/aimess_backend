import type {
  PrismaClient,
  GroupMessage,
  Prisma,
} from "../generated/prisma/index.js";

export class GroupMessageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    roomId: string;
    [key: string]: unknown;
  }): Promise<GroupMessage> {
    return this.prisma.groupMessage.create({
      data: {
        roomId: data.roomId,
        clientMessageId: (data.clientMessageId as string) ?? null,
        senderId: (data.senderId as string) ?? null,
        senderName: (data.senderName as string) ?? "",
        senderAvatar: (data.senderAvatar as string) ?? "",
        messageType: (data.messageType as string) ?? "TEXT",
        content: (data.content as object) ?? { text: "", urls: [], files: [] },
        systemEvent: (data.systemEvent as string) ?? null,
        systemData: (data.systemData as object) ?? null,
        inviteLinkData: (data.inviteLinkData as object) ?? null,
        parentMessageId: (data.parentMessageId as string) ?? null,
        quoteData: (data.quoteData as object) ?? null,
        reactions: (data.reactions as object) ?? {},
        isForwarded: (data.isForwarded as boolean) ?? false,
        forwardData: (data.forwardData as object) ?? null,
        isDeleted: (data.isDeleted as boolean) ?? false,
        deletedType: (data.deletedType as string) ?? null,
        deletedPlaceholder: (data.deletedPlaceholder as string) ?? "",
        deletedAt: (data.deletedAt as Date) ?? null,
        deletedBy: (data.deletedBy as string) ?? null,
        createdAt: (data.createdAt as Date) ?? new Date(),
      },
    });
  }

  async findById(messageId: string): Promise<GroupMessage | null> {
    return this.prisma.groupMessage.findUnique({ where: { id: messageId } });
  }

  async findByRoomIdWithTime(
    roomId: string,
    beforeTimestamp: string,
    limit: number,
    userId?: string
  ): Promise<GroupMessage[]> {
    const messages = await this.prisma.groupMessage.findMany({
      where: {
        roomId,
        createdAt: { lt: new Date(beforeTimestamp) },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    if (!userId) return messages;
    return messages.filter((msg) => {
      const raw = msg as unknown as { deletedForUserIds?: unknown };
      const deletedFor = (raw.deletedForUserIds ?? []) as string[];
      return !deletedFor.includes(userId);
    });
  }

  async searchByText(
    roomId: string,
    query: string,
    limit: number
  ): Promise<GroupMessage[]> {
    // content.text is inside a Json column — use a raw regex query for matching
    // ids, then re-fetch via the typed client for the normal message shape.
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const raw = (await this.prisma.groupMessage.findRaw({
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

    return this.prisma.groupMessage.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: "desc" },
    });
  }

  async findByClientMessageId(
    roomId: string,
    senderIdOrClientMessageId: string,
    clientMessageId?: string
  ): Promise<GroupMessage | null> {
    // Supports two call signatures:
    // findByClientMessageId(roomId, senderId, clientMessageId)  — original
    // findByClientMessageId(roomId, clientMessageId)            — for forward idempotency
    if (clientMessageId !== undefined) {
      return this.prisma.groupMessage.findFirst({
        where: { roomId, senderId: senderIdOrClientMessageId, clientMessageId },
      });
    }
    return this.prisma.groupMessage.findFirst({
      where: { roomId, clientMessageId: senderIdOrClientMessageId },
    });
  }

  async addReactions(
    messageId: string,
    reactions: Record<string, unknown[]>
  ): Promise<GroupMessage | null> {
    return this.prisma.groupMessage.update({
      where: { id: messageId },
      data: { reactions: reactions as unknown as Prisma.InputJsonValue },
    });
  }

  async deleteForEveryone(
    messageId: string,
    userId: string,
    deletedType: string
  ): Promise<GroupMessage | null> {
    return this.prisma.groupMessage.update({
      where: { id: messageId },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        deletedType,
        deletedPlaceholder: "This message was deleted",
      },
    });
  }

  async deleteForMe(
    messageId: string,
    userId: string
  ): Promise<GroupMessage | null> {
    const message = await this.prisma.groupMessage.findUnique({
      where: { id: messageId },
    });
    if (!message) return null;

    const raw = message as unknown as { deletedForUserIds?: unknown };
    const existing = (raw.deletedForUserIds ?? []) as string[];
    if (existing.includes(userId)) return message;

    return this.prisma.groupMessage.update({
      where: { id: messageId },
      // deletedForUserIds will be in the generated types after `prisma generate`
      data: { deletedForUserIds: [...existing, userId] } as unknown as Record<
        string,
        unknown
      >,
    });
  }

  async countSearchResults(roomId: string, query: string): Promise<number> {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const result = (await this.prisma.groupMessage.aggregateRaw({
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
    return this.prisma.groupMessage.count({
      where: { roomId, isDeleted: false },
    });
  }

  async createForwardedMessage(data: {
    roomId: string;
    senderId: string;
    senderName: string;
    senderAvatar: string;
    content: object;
    messageType: string;
    forwardData: object;
    clientMessageId?: string | null;
  }): Promise<GroupMessage> {
    return this.prisma.groupMessage.create({
      data: {
        roomId: data.roomId,
        senderId: data.senderId,
        senderName: data.senderName,
        senderAvatar: data.senderAvatar,
        content: data.content as Prisma.InputJsonValue,
        messageType: data.messageType,
        isForwarded: true,
        forwardData: data.forwardData as Prisma.InputJsonValue,
        clientMessageId: data.clientMessageId ?? null,
        reactions: {},
        isDeleted: false,
        deletedForUserIds: [],
      },
    });
  }

  async getReactions(
    messageId: string
  ): Promise<Record<string, unknown> | null> {
    const msg = await this.prisma.groupMessage.findUnique({
      where: { id: messageId },
      select: { reactions: true },
    });
    if (!msg) return null;
    return msg.reactions as Record<string, unknown>;
  }
}
