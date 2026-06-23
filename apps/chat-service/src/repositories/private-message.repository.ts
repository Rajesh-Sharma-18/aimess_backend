import type {
  PrismaClient,
  PrivateMessage,
  Prisma,
} from "../generated/prisma/index.js";
import { MEDIA_MESSAGE_TYPES } from "../constants/media-limits.js";

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
    sequenceNumber?: number;
    [key: string]: unknown;
  }): Promise<PrivateMessage> {
    return this.prisma.privateMessage.create({
      data: {
        roomId: data.roomId,
        sequenceNumber: (data.sequenceNumber as number) ?? 0,
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

  async findAfterSeq(
    roomId: string,
    sinceSeq: number,
    limit: number
  ): Promise<PrivateMessage[]> {
    return this.prisma.privateMessage.findMany({
      where: { roomId, sequenceNumber: { gt: sinceSeq } },
      orderBy: { sequenceNumber: "asc" },
      take: limit + 1,
    });
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

  /**
   * Timestamp-bounded message page for the message-list endpoint.
   * - direction "before": createdAt <= ts, newest-first (desc).
   * - direction "after" : createdAt >= ts, oldest-first (asc).
   * Excludes deleted-for-everyone (isDeleted) at the DB level; per-user
   * "delete for me" is filtered in memory (deletedFor: { [userId]: ts }).
   * Over-fetches a small buffer to absorb in-memory deletions, then returns
   * up to `limit + 1` survivors so the caller can compute exact `hasMore`.
   */
  async findByRoomIdTimeline(params: {
    userId: string;
    roomId: string;
    direction: "before" | "after";
    ts: Date;
    limit: number;
  }): Promise<PrivateMessage[]> {
    const bound =
      params.direction === "before" ? { lte: params.ts } : { gte: params.ts };
    const order = params.direction === "before" ? "desc" : "asc";
    const messages = await this.prisma.privateMessage.findMany({
      where: {
        roomId: params.roomId,
        isDeleted: false,
        createdAt: bound,
      },
      // `sequenceNumber` is the secondary sort key so messages sharing the same
      // createdAt millisecond have a deterministic, total order — without it,
      // ms-tie messages can be skipped or duplicated across pages even though
      // the boundary is inclusive and clients de-dupe by id. It is the per-room
      // monotonic ordering key and is covered by the (roomId, isDeleted,
      // createdAt, sequenceNumber) index so the sort stays index-backed.
      orderBy: [{ createdAt: order }, { sequenceNumber: order }],
      take: params.limit + 1 + 10,
    });

    return messages
      .filter((msg) => {
        const deletedFor = (msg.deletedFor ?? {}) as Record<string, unknown>;
        return !(params.userId in deletedFor);
      })
      .slice(0, params.limit + 1);
  }

  /**
   * V2 §3.2/§5.2: seq-based keyset page. Unlike timestamp paging, a per-room
   * monotonic `sequenceNumber` cursor can never skip a same-millisecond message.
   * - direction "before": sequenceNumber < seq, newest-first (desc).
   * - direction "after" : sequenceNumber > seq, oldest-first (asc).
   * Over-fetches a buffer to absorb in-memory delete-for-me filtering, returns
   * up to `limit + 1` survivors so the caller can compute exact `hasMore`.
   */
  async findByRoomIdSeq(params: {
    userId: string;
    roomId: string;
    direction: "before" | "after";
    seq: number;
    limit: number;
  }): Promise<PrivateMessage[]> {
    const bound =
      params.direction === "before" ? { lt: params.seq } : { gt: params.seq };
    const order = params.direction === "before" ? "desc" : "asc";
    const messages = await this.prisma.privateMessage.findMany({
      where: {
        roomId: params.roomId,
        isDeleted: false,
        sequenceNumber: bound,
      },
      orderBy: { sequenceNumber: order },
      take: params.limit + 1 + 10,
    });
    return messages
      .filter((msg) => {
        const deletedFor = (msg.deletedFor ?? {}) as Record<string, unknown>;
        return !(params.userId in deletedFor);
      })
      .slice(0, params.limit + 1);
  }

  /**
   * V2 §3.2: jump-to-message anchor — `limit` messages centered on `anchorSeq`
   * (half before, the anchor, half after). Used for reply-tap / search-result
   * navigation. Returns the window ascending by sequenceNumber.
   *
   * If the requesting user has done "delete for me" on the anchor itself, the
   * anchor is correctly omitted (you must not surface a message a user deleted);
   * the surrounding window is still returned at full size.
   */
  async findAroundSeq(params: {
    userId: string;
    roomId: string;
    anchorSeq: number;
    limit: number;
  }): Promise<PrivateMessage[]> {
    const half = Math.max(1, Math.floor(params.limit / 2));
    const [before, anchorAndAfter] = await Promise.all([
      this.prisma.privateMessage.findMany({
        where: {
          roomId: params.roomId,
          isDeleted: false,
          sequenceNumber: { lt: params.anchorSeq },
        },
        orderBy: { sequenceNumber: "desc" },
        take: half + 10,
      }),
      this.prisma.privateMessage.findMany({
        where: {
          roomId: params.roomId,
          isDeleted: false,
          sequenceNumber: { gte: params.anchorSeq },
        },
        orderBy: { sequenceNumber: "asc" },
        take: half + 1 + 10,
      }),
    ]);
    const keep = (msg: PrivateMessage): boolean => {
      const deletedFor = (msg.deletedFor ?? {}) as Record<string, unknown>;
      return !(params.userId in deletedFor);
    };
    const beforeKept = before.filter(keep).slice(0, half).reverse();
    const afterKept = anchorAndAfter.filter(keep).slice(0, half + 1);
    return [...beforeKept, ...afterKept];
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
    sequenceNumber?: number;
  }): Promise<PrivateMessage> {
    return this.prisma.privateMessage.create({
      data: {
        roomId: data.roomId,
        sequenceNumber: (data.sequenceNumber as number) ?? 0,
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

  /**
   * List media/document messages in a room, newest first, cursor on createdAt.
   * Excludes messages deleted-for-everyone; per-user "delete for me" is filtered
   * in memory (deletedFor shape: { [userId]: ISO-timestamp }).
   */
  async listMedia(params: {
    roomId: string;
    userId: string;
    type?: string;
    cursor?: string | null;
    limit: number;
  }): Promise<PrivateMessage[]> {
    const mediaTypes = MEDIA_MESSAGE_TYPES;
    const messages = await this.prisma.privateMessage.findMany({
      where: {
        roomId: params.roomId,
        isDeleted: false,
        messageType: params.type ? params.type : { in: [...mediaTypes] },
        ...(params.cursor
          ? { createdAt: { lt: new Date(params.cursor) } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: params.limit + 10,
    });

    return messages
      .filter((msg) => {
        const deletedFor = (msg.deletedFor ?? {}) as Record<string, unknown>;
        return !(params.userId in deletedFor);
      })
      .slice(0, params.limit);
  }
}
