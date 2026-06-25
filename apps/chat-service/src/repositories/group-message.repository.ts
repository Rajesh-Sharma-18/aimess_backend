import type {
  PrismaClient,
  GroupMessage,
  Prisma,
} from "../generated/prisma/index.js";
import { MEDIA_MESSAGE_TYPES } from "../constants/media-limits.js";
import { logger } from "@aimess/logger";

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
  /**
   * Shared `$match` for the group timeline (and its count) — the SINGLE source of
   * truth so `findByRoomIdTimeline` and `countTimeline` filter IDENTICALLY.
   * Group keeps deleted-for-everyone messages (`isDeleted:true`) so the client can
   * render the tombstone placeholder, and only removes the viewer's own
   * delete-for-me. `deletedForUserIds` is a Json array; Mongo's `$ne` on it matches
   * docs where NO element equals the user (i.e. "not deleted for this user").
   * `roomId` is a plain String column here (not an ObjectId).
   */
  private timelineMatch(params: {
    roomId: string;
    userId: string;
  }): Record<string, unknown> {
    return {
      roomId: params.roomId,
      deletedForUserIds: { $ne: params.userId },
    };
  }

  /**
   * Keyset history page (before_ts / after_ts).
   *
   * Why this is an `aggregateRaw` keyset (not findMany + in-memory filter): the
   * previous version fetched `limit + 1 + 10` rows then filtered delete-for-me in
   * memory, so `hasMore` (derived from the post-filter length) could underflow and
   * terminate infinite scroll early. And the cursor was a bare millisecond, so
   * messages sharing one millisecond were split across a page edge and silently
   * skipped/duplicated. Filtering in the DB makes the page exactly `limit` visible
   * rows; the `(createdAt, _id)` keyset gives a total order so every message is
   * reachable exactly once.
   *
   *  - `direction="before"` → older page, newest-first; boundary exclusive
   *    `createdAt < ts OR (createdAt == ts AND _id < boundaryId)`.
   *  - `direction="after"`  → newer page, oldest-first; the mirror.
   *  - No `boundaryId` → first page / coarse jump: `inclusive` picks `<=`/`>=`.
   */
  async findByRoomIdTimeline(params: {
    userId: string;
    roomId: string;
    direction: "before" | "after";
    ts: Date;
    /** ObjectId of the cursor row — the keyset tiebreaker for same-ms messages. */
    boundaryId?: string | null;
    /** Include rows whose createdAt == ts (first page); ignored when boundaryId set. */
    inclusive?: boolean;
    limit: number;
  }): Promise<{ messages: GroupMessage[]; hasMore: boolean }> {
    const before = params.direction === "before";
    const base = this.timelineMatch({
      roomId: params.roomId,
      userId: params.userId,
    });

    const date = { $date: params.ts.toISOString() };
    const match: Record<string, unknown> = { ...base };
    if (params.boundaryId) {
      match.$or = before
        ? [
            { createdAt: { $lt: date } },
            { createdAt: date, _id: { $lt: { $oid: params.boundaryId } } },
          ]
        : [
            { createdAt: { $gt: date } },
            { createdAt: date, _id: { $gt: { $oid: params.boundaryId } } },
          ];
    } else {
      match.createdAt = before
        ? params.inclusive
          ? { $lte: date }
          : { $lt: date }
        : params.inclusive
          ? { $gte: date }
          : { $gt: date };
    }

    const sort = before ? { createdAt: -1, _id: -1 } : { createdAt: 1, _id: 1 };

    // Over-fetch ONE extra row: detects `hasMore` AND lets us inspect the dropped
    // row's millisecond for the snap-to-ms guard below.
    const ordered = await this.runTimelinePage(match, sort, params.limit + 1);
    const hasMoreRaw = ordered.length > params.limit;
    let page = ordered.slice(0, params.limit);
    let hasMore = hasMoreRaw;

    // SNAP-TO-MILLISECOND — never end a page in the MIDDLE of a same-ms cluster.
    // A client paginating with a BARE millisecond cursor (`before_ts=<ms>` instead
    // of the compound `<ms>_<id>` we return) would otherwise skip the rest of the
    // boundary millisecond via the exclusive `$lt`/`$gt`. Trimming the trailing
    // same-ms rows makes every page end on a clean ms boundary, so bare-ms and
    // compound cursors are both lossless. No extra query in this common path.
    if (hasMoreRaw && page.length === params.limit) {
      const boundaryMs = page[page.length - 1]!.createdAt.getTime();
      const nextMs = ordered[params.limit]!.createdAt.getTime();
      if (boundaryMs === nextMs) {
        const trimmed = page.filter(
          (d) => d.createdAt.getTime() !== boundaryMs
        );
        if (trimmed.length > 0) {
          page = trimmed;
          hasMore = true;
        } else {
          // Degenerate: the WHOLE page is one millisecond with more rows at that
          // ms. Trimming would loop forever, so EXTEND to the full cluster
          // (bounded by TIMELINE_CLUSTER_CAP).
          const lastId = page[page.length - 1]!.id;
          const extra = await this.fetchSameMsBeyond(
            base,
            boundaryMs,
            lastId,
            before
          );
          page = page.concat(extra);
          hasMore = await this.existsBeyondMs(base, boundaryMs, before);
        }
      }
    }

    return { messages: page, hasMore };
  }

  /** Bound on rows pulled when EXTENDING past a degenerate single-millisecond
   *  page; a real chat never approaches it. */
  private readonly TIMELINE_CLUSTER_CAP = 5000;

  /** Run one keyset page: aggregateRaw for ordered ids, then re-fetch typed docs
   *  and restore that order. Shared by the main page and the same-ms extend. */
  private async runTimelinePage(
    match: Record<string, unknown>,
    sort: Record<string, number>,
    limit: number
  ): Promise<GroupMessage[]> {
    const raw = (await this.prisma.groupMessage.aggregateRaw({
      pipeline: [
        { $match: match },
        { $sort: sort },
        { $limit: limit },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{ _id?: { $oid?: string } | string }>;

    const ids = raw
      .map((doc) => (typeof doc._id === "string" ? doc._id : doc._id?.$oid))
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return [];

    const docs = await this.prisma.groupMessage.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(docs.map((d) => [d.id, d]));
    return ids
      .map((id) => byId.get(id))
      .filter((d): d is GroupMessage => Boolean(d));
  }

  /** Fetch the rest of a same-millisecond cluster beyond `lastId` (degenerate
   *  single-ms extend path only). */
  private async fetchSameMsBeyond(
    base: Record<string, unknown>,
    boundaryMs: number,
    lastId: string,
    before: boolean
  ): Promise<GroupMessage[]> {
    const date = { $date: new Date(boundaryMs).toISOString() };
    const match: Record<string, unknown> = {
      ...base,
      createdAt: date,
      _id: before ? { $lt: { $oid: lastId } } : { $gt: { $oid: lastId } },
    };
    const extra = await this.runTimelinePage(
      match,
      before ? { _id: -1 } : { _id: 1 },
      this.TIMELINE_CLUSTER_CAP
    );
    if (extra.length >= this.TIMELINE_CLUSTER_CAP) {
      logger.warn(
        `findByRoomIdTimeline|same-ms cluster at ${boundaryMs} hit TIMELINE_CLUSTER_CAP (${this.TIMELINE_CLUSTER_CAP}); page may still split`
      );
    }
    return extra;
  }

  /** Existence probe: is there a history-visible row strictly beyond `boundaryMs`
   *  (older for `before`, newer for `after`)? Sets `hasMore` after an extend. */
  private async existsBeyondMs(
    base: Record<string, unknown>,
    boundaryMs: number,
    before: boolean
  ): Promise<boolean> {
    const date = { $date: new Date(boundaryMs).toISOString() };
    const raw = (await this.prisma.groupMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            ...base,
            createdAt: before ? { $lt: date } : { $gt: date },
          },
        },
        { $limit: 1 },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as unknown[];
    return raw.length > 0;
  }

  /**
   * Count of history-visible messages for one viewer — SAME filter as
   * `findByRoomIdTimeline` (minus the keyset boundary), so the timeline `total`
   * matches what pagination can actually reach. Uses `aggregateRaw` because the
   * per-user `deletedForUserIds` Json array can't be filtered via the typed count.
   */
  async countTimeline(params: {
    roomId: string;
    userId: string;
  }): Promise<number> {
    const result = (await this.prisma.groupMessage.aggregateRaw({
      pipeline: [
        { $match: this.timelineMatch(params) },
        { $count: "total" },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{ total: number }>;
    return result[0]?.total ?? 0;
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
