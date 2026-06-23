import type {
  PrismaClient,
  GroupMessage,
  Prisma,
} from "../generated/prisma/index.js";
import { MEDIA_MESSAGE_TYPES } from "../constants/media-limits.js";

export class GroupMessageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    roomId: string;
    [key: string]: unknown;
  }): Promise<GroupMessage> {
    return this.prisma.groupMessage.create({
      data: {
        roomId: data.roomId,
        sequenceNumber: (data.sequenceNumber as number) ?? 0,
        clientMessageId: (data.clientMessageId as string) ?? null,
        clientInfo: (data.clientInfo as object) ?? null,
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

  async findAfterSeq(
    roomId: string,
    sinceSeq: number,
    limit: number
  ): Promise<GroupMessage[]> {
    return this.prisma.groupMessage.findMany({
      where: { roomId, sequenceNumber: { gt: sinceSeq } },
      orderBy: { sequenceNumber: "asc" },
      take: limit + 1,
    });
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

  /**
   * Timestamp-bounded message page for the message-list endpoint.
   * - direction "before": createdAt <= ts, newest-first (desc).
   * - direction "after" : createdAt >= ts, oldest-first (asc).
   * Matches the legacy `findByRoomIdWithTime` visibility (deleted-for-everyone
   * messages are kept so the client can render the placeholder); only per-user
   * "delete for me" (deletedForUserIds Json array) is filtered in memory.
   * Over-fetches a small buffer, then returns up to `limit + 1` survivors so the
   * caller can compute exact `hasMore`.
   */
  async findByRoomIdTimeline(params: {
    userId: string;
    roomId: string;
    direction: "before" | "after";
    ts: Date;
    limit: number;
  }): Promise<GroupMessage[]> {
    const bound =
      params.direction === "before" ? { lte: params.ts } : { gte: params.ts };
    const order = params.direction === "before" ? "desc" : "asc";
    const messages = await this.prisma.groupMessage.findMany({
      where: {
        roomId: params.roomId,
        createdAt: bound,
      },
      // `sequenceNumber` is the secondary sort key so messages sharing the same
      // createdAt millisecond have a deterministic, total order — without it,
      // ms-tie messages can be skipped or duplicated across pages even though
      // the boundary is inclusive and clients de-dupe by id. It is the per-room
      // monotonic ordering key and is covered by the (roomId, createdAt,
      // sequenceNumber) index so the sort stays index-backed.
      orderBy: [{ createdAt: order }, { sequenceNumber: order }],
      take: params.limit + 1 + 10,
    });

    return messages
      .filter((msg) => {
        const raw = msg as unknown as { deletedForUserIds?: unknown };
        const deletedFor = (raw.deletedForUserIds ?? []) as string[];
        return !deletedFor.includes(params.userId);
      })
      .slice(0, params.limit + 1);
  }

  /**
   * V2 §3.2/§5.2: seq-based keyset page (see private-message.repository for the
   * rationale). before → sequenceNumber < seq desc; after → > seq asc.
   */
  async findByRoomIdSeq(params: {
    userId: string;
    roomId: string;
    direction: "before" | "after";
    seq: number;
    limit: number;
  }): Promise<GroupMessage[]> {
    const bound =
      params.direction === "before" ? { lt: params.seq } : { gt: params.seq };
    const order = params.direction === "before" ? "desc" : "asc";
    const messages = await this.prisma.groupMessage.findMany({
      where: {
        roomId: params.roomId,
        sequenceNumber: bound,
      },
      orderBy: { sequenceNumber: order },
      take: params.limit + 1 + 10,
    });
    return messages
      .filter((msg) => {
        const raw = msg as unknown as { deletedForUserIds?: unknown };
        const deletedFor = (raw.deletedForUserIds ?? []) as string[];
        return !deletedFor.includes(params.userId);
      })
      .slice(0, params.limit + 1);
  }

  /**
   * V2 §3.2: jump-to-message anchor window centered on `anchorSeq`.
   */
  async findAroundSeq(params: {
    userId: string;
    roomId: string;
    anchorSeq: number;
    limit: number;
  }): Promise<GroupMessage[]> {
    const half = Math.max(1, Math.floor(params.limit / 2));
    const keep = (msg: GroupMessage): boolean => {
      const raw = msg as unknown as { deletedForUserIds?: unknown };
      const deletedFor = (raw.deletedForUserIds ?? []) as string[];
      return !deletedFor.includes(params.userId);
    };
    const [before, anchorAndAfter] = await Promise.all([
      this.prisma.groupMessage.findMany({
        where: {
          roomId: params.roomId,
          sequenceNumber: { lt: params.anchorSeq },
        },
        orderBy: { sequenceNumber: "desc" },
        take: half + 10,
      }),
      this.prisma.groupMessage.findMany({
        where: {
          roomId: params.roomId,
          sequenceNumber: { gte: params.anchorSeq },
        },
        orderBy: { sequenceNumber: "asc" },
        take: half + 1 + 10,
      }),
    ]);
    const beforeKept = before.filter(keep).slice(0, half).reverse();
    const afterKept = anchorAndAfter.filter(keep).slice(0, half + 1);
    return [...beforeKept, ...afterKept];
  }

  /**
   * Mongo `$match` for a group conversation page: not deleted-for-everyone,
   * older than `beforeMs`, and not deleted-for-me by this user. `deletedForUserIds`
   * is a Json array (not a Prisma scalar list), so the per-user exclusion can't use
   * the typed `has` filter — Mongo's `$ne` on the array matches docs where no element
   * equals userId, i.e. "not deleted for this user". Building the filter at the DB
   * level (vs. fetch-extra + in-memory slice) keeps skip/take boundaries correct.
   */
  private conversationMatch(params: {
    roomId: string;
    userId: string;
    beforeMs: number;
  }): Prisma.InputJsonObject {
    return {
      roomId: params.roomId,
      isDeleted: false,
      createdAt: { $lt: { $date: new Date(params.beforeMs).toISOString() } },
      deletedForUserIds: { $ne: params.userId },
    };
  }

  /**
   * Offset-paginated conversation page for a group room: messages with
   * `createdAt < beforeMs`, newest first, skipping `skip` and taking `take`.
   * Excludes deleted-for-everyone AND messages this user deleted-for-me. The
   * deletion filter is applied at the DB level via a raw Mongo match (see
   * `conversationMatch`), so the page is exactly `take` rows with correct offsets.
   */
  async listConversationMessages(params: {
    roomId: string;
    userId: string;
    beforeMs: number;
    skip: number;
    take: number;
  }): Promise<GroupMessage[]> {
    const raw = (await this.prisma.groupMessage.findRaw({
      filter: this.conversationMatch(params),
      options: {
        sort: { createdAt: -1 },
        skip: params.skip,
        limit: params.take,
      },
    })) as unknown as Array<{ _id?: { $oid?: string } | string }>;

    const ids = raw
      .map((doc) => (typeof doc._id === "string" ? doc._id : doc._id?.$oid))
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return [];

    // findRaw preserves order; re-fetch typed docs and restore that order.
    const docs = await this.prisma.groupMessage.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(docs.map((d) => [d.id, d]));
    return ids
      .map((id) => byId.get(id))
      .filter((d): d is GroupMessage => Boolean(d));
  }

  /**
   * Count for the conversation page — SAME filter as `listConversationMessages`
   * (createdAt < beforeMs, not deleted-for-all, not deleted-for-me), so
   * total/hasMore line up with the returned page. Uses `aggregateRaw` because
   * the per-user `deletedForUserIds` Json array can't be filtered via the typed
   * `count` API.
   */
  async countConversation(params: {
    roomId: string;
    userId: string;
    beforeMs: number;
  }): Promise<number> {
    const result = (await this.prisma.groupMessage.aggregateRaw({
      pipeline: [
        { $match: this.conversationMatch(params) },
        { $count: "total" },
      ],
    })) as unknown as Array<{ total: number }>;
    return result[0]?.total ?? 0;
  }

  /**
   * Count of messages in the room still newer than `afterDate` that are visible
   * to this user (not deleted-for-everyone, not deleted-for-me). Used to recompute
   * remaining unread after advancing a read pointer to a non-newest page.
   */
  async countUnreadAfter(params: {
    roomId: string;
    userId: string;
    afterDate: Date;
  }): Promise<number> {
    const result = (await this.prisma.groupMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId: params.roomId,
            isDeleted: false,
            createdAt: { $gt: { $date: params.afterDate.toISOString() } },
            deletedForUserIds: { $ne: params.userId },
          },
        },
        { $count: "total" },
      ],
    })) as unknown as Array<{ total: number }>;
    return result[0]?.total ?? 0;
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
    sequenceNumber?: number;
  }): Promise<GroupMessage> {
    return this.prisma.groupMessage.create({
      data: {
        roomId: data.roomId,
        sequenceNumber: (data.sequenceNumber as number) ?? 0,
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

  async editMessage(messageId: string, content: object): Promise<GroupMessage> {
    // Read-then-write so we can push the prior content snapshot into editHistory
    // (mirrors PrivateMessageRepository.editMessage).
    const existing = await this.prisma.groupMessage.findUnique({
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

    return this.prisma.groupMessage.update({
      where: { id: messageId },
      data: {
        content: content as unknown as Prisma.InputJsonValue,
        editedAt: now,
        editHistory: updatedHistory as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * List media/document messages in a room, newest first, cursor on createdAt.
   * Excludes messages deleted-for-everyone; per-user "delete for me" is filtered
   * in memory (Mongo can't $nin a JSON array).
   */
  async listMedia(params: {
    roomId: string;
    userId: string;
    type?: string;
    cursor?: string | null;
    limit: number;
  }): Promise<GroupMessage[]> {
    const mediaTypes = MEDIA_MESSAGE_TYPES;
    const messages = await this.prisma.groupMessage.findMany({
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
        const raw = msg as unknown as { deletedForUserIds?: unknown };
        const deletedFor = (raw.deletedForUserIds ?? []) as string[];
        return !deletedFor.includes(params.userId);
      })
      .slice(0, params.limit);
  }
}
