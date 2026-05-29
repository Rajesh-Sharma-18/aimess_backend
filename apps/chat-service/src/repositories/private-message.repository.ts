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
    clientMessageId?: string | null;
    isForwarded?: boolean;
    forwardData?: object | null;
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
        clientMessageId: data.clientMessageId ?? null,
        isForwarded: data.isForwarded ?? false,
        forwardData: (data.forwardData as object) ?? null,
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
    room: { roomId: string },
    beforeTimestamp: string,
    limit: number
  ): Promise<PrivateMessage[]> {
    const ltDate = new Date(beforeTimestamp);

    // isDeleted: true means "deleted for everyone" — exclude at DB level.
    // "deleted for me" messages keep isDeleted: false and are caught below.
    const messages = await this.prisma.privateMessage.findMany({
      where: {
        roomId: room.roomId,
        isDeleted: false,
        createdAt: { lt: ltDate },
      },
      orderBy: { createdAt: "desc" },
      take: limit + 10,
    });

    // Filter out messages where this user has done "delete for me".
    // deletedFor shape: { [userId]: ISO-timestamp, ... }
    return messages
      .filter((msg) => {
        const deletedFor = (msg.deletedFor ?? {}) as Record<string, unknown>;
        return !(userId in deletedFor);
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

  async editMessage(
    messageId: string,
    content: object
  ): Promise<PrivateMessage> {
    // Read-then-write so we can push the prior content snapshot into editHistory
    // (mirrors deleteForMe's read-then-write of a Json field).
    const existing = await this.prisma.privateMessage.findUnique({
      where: { id: messageId },
    });
    const now = new Date();
    const history = Array.isArray(existing?.editHistory)
      ? (existing!.editHistory as unknown[])
      : [];
    const priorText =
      ((existing?.content ?? {}) as Record<string, unknown>)?.text ?? "";
    const updatedHistory = [
      ...history,
      { text: priorText, editedAt: now.toISOString() },
    ];

    return this.prisma.privateMessage.update({
      where: { id: messageId },
      data: {
        content: content as unknown as Prisma.InputJsonValue,
        editedAt: now,
        editHistory: updatedHistory as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async markDeliveredUpTo(
    roomId: string,
    recipientId: string,
    upToMessageId: string
  ): Promise<{ count: number; messageIds: string[] }> {
    const upToMessage = await this.prisma.privateMessage.findUnique({
      where: { id: upToMessageId },
    });
    if (!upToMessage) return { count: 0, messageIds: [] };

    // Candidate messages: same room, created at/before the boundary, not sent by
    // the recipient, not deleted-for-everyone. Bound the batch to 200.
    const candidates = await this.prisma.privateMessage.findMany({
      where: {
        roomId,
        isDeleted: false,
        senderId: { not: recipientId },
        createdAt: { lte: upToMessage.createdAt },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    const now = new Date().toISOString();
    const updatedIds: string[] = [];

    for (const msg of candidates) {
      const deliveredTo = Array.isArray(msg.deliveredTo)
        ? (msg.deliveredTo as string[])
        : [];
      // Idempotent: skip if already delivered to this recipient.
      if (deliveredTo.includes(recipientId)) continue;
      // Skip messages the recipient deleted for themselves.
      const deletedFor = (msg.deletedFor ?? {}) as Record<string, unknown>;
      if (recipientId in deletedFor) continue;

      const deliveredAt = (msg.deliveredAt ?? {}) as Record<string, string>;
      deliveredAt[recipientId] = now;

      await this.prisma.privateMessage.update({
        where: { id: msg.id },
        data: {
          deliveredTo: [
            ...deliveredTo,
            recipientId,
          ] as unknown as Prisma.InputJsonValue,
          deliveredAt: deliveredAt as unknown as Prisma.InputJsonValue,
        },
      });
      updatedIds.push(msg.id);
    }

    return { count: updatedIds.length, messageIds: updatedIds };
  }

  async deleteForMe(
    messageId: string,
    userId: string
  ): Promise<PrivateMessage> {
    // Read existing deletedFor so both users can independently delete for themselves.
    // Shape: { [userId]: ISO-timestamp }  — the fetch filter checks `userId in deletedFor`.
    const existing = await this.prisma.privateMessage.findUnique({
      where: { id: messageId },
    });
    const current = (existing?.deletedFor ?? {}) as Record<string, unknown>;
    const updated = { ...current, [userId]: new Date().toISOString() };

    return this.prisma.privateMessage.update({
      where: { id: messageId },
      data: {
        // isDeleted stays false — message still exists for the other participant
        deletedFor: updated as unknown as Prisma.InputJsonValue,
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

  async findByClientMessageId(
    roomId: string,
    senderId: string,
    clientMessageId: string
  ): Promise<PrivateMessage | null> {
    return this.prisma.privateMessage.findFirst({
      where: { roomId, senderId, clientMessageId },
    });
  }

  async createForwardedMessage(data: {
    roomId: string;
    senderId: string;
    receiverId: string;
    content: object;
    messageType: string;
    forwardData: object;
    clientMessageId?: string | null;
  }): Promise<PrivateMessage> {
    return this.prisma.privateMessage.create({
      data: {
        roomId: data.roomId,
        senderId: data.senderId,
        receiverId: data.receiverId,
        content: data.content as Prisma.InputJsonValue,
        messageType: data.messageType,
        isForwarded: true,
        forwardData: data.forwardData as Prisma.InputJsonValue,
        clientMessageId: data.clientMessageId ?? null,
        readBy: [],
        reactions: {},
        deletedFor: {},
        isDeleted: false,
      },
    });
  }

  async getReactions(
    messageId: string
  ): Promise<Record<string, unknown> | null> {
    const msg = await this.prisma.privateMessage.findUnique({
      where: { id: messageId },
      select: { reactions: true },
    });
    if (!msg) return null;
    return msg.reactions as Record<string, unknown>;
  }
}
