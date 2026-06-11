import type {
  PrismaClient,
  GeneralRoomMessage,
  Prisma,
} from "../generated/prisma/index.js";
import {
  COMMUNITY_MEDIA_MESSAGE_TYPES,
  mapCommunityMediaType,
} from "../constants/media-limits.js";

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

  /**
   * Timestamp-keyset page for community messages. Over-fetches by 1 so the
   * caller can detect `hasMore` without a separate count query.
   * `direction="before"` → createdAt <= ts, newest-first (the default load).
   * `direction="after"`  → createdAt >= ts, oldest-first (upward scroll).
   * Per-user deletedBy filtering is done in memory (Prisma/Mongo limitation).
   */
  async findByRoomIdTimeline(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    ts: Date;
    limit: number;
  }): Promise<GeneralRoomMessage[]> {
    const messages = await this.prisma.generalRoomMessage.findMany({
      where: {
        roomId: params.roomId,
        deletedForAll: false,
        createdAt:
          params.direction === "before"
            ? { lte: params.ts }
            : { gte: params.ts },
      },
      orderBy: {
        createdAt: params.direction === "before" ? "desc" : "asc",
      },
      take: params.limit + 1,
    });

    return messages.filter((msg) => {
      const deletedBy = (msg.deletedBy ?? []) as string[];
      return !deletedBy.includes(params.userId);
    });
  }

  /**
   * Jump-to-message window for community rooms (no sequenceNumber, anchors on
   * createdAt). Fetches ~half the limit on each side of the anchor message.
   */
  async findAroundDate(params: {
    roomId: string;
    userId: string;
    anchorDate: Date;
    limit: number;
  }): Promise<GeneralRoomMessage[]> {
    const half = Math.floor(params.limit / 2);

    const [older, newer] = await Promise.all([
      // anchor-inclusive older half (desc → reversed to asc before merge)
      this.prisma.generalRoomMessage.findMany({
        where: {
          roomId: params.roomId,
          deletedForAll: false,
          createdAt: { lte: params.anchorDate },
        },
        orderBy: { createdAt: "desc" },
        take: half + 1,
      }),
      // strictly newer half
      this.prisma.generalRoomMessage.findMany({
        where: {
          roomId: params.roomId,
          deletedForAll: false,
          createdAt: { gt: params.anchorDate },
        },
        orderBy: { createdAt: "asc" },
        take: half,
      }),
    ]);

    return [...older.reverse(), ...newer].filter((msg) => {
      const deletedBy = (msg.deletedBy ?? []) as string[];
      return !deletedBy.includes(params.userId);
    });
  }

  /**
   * Mongo `$match` for a community conversation page: not deleted-for-all, older
   * than `beforeMs`, and not deleted-for-me by this user. `deletedBy` is a Json
   * array (not a Prisma scalar list), so the per-user exclusion can't use the typed
   * `has` filter — Mongo's `$ne` on the array matches docs where no element equals
   * userId, i.e. "not deleted for this user". Building the filter at the DB level
   * (vs. fetch-extra + in-memory slice) keeps skip/take boundaries correct.
   *
   * roomId is an ObjectId column here, so it must be matched as `{ $oid }`.
   */
  private conversationMatch(params: {
    roomId: string;
    userId: string;
    beforeMs: number;
  }): Prisma.InputJsonObject {
    return {
      roomId: { $oid: params.roomId },
      deletedForAll: false,
      createdAt: { $lt: { $date: new Date(params.beforeMs).toISOString() } },
      deletedBy: { $ne: params.userId },
    };
  }

  /**
   * Offset-paginated conversation page for a community room: messages with
   * `createdAt < beforeMs`, newest first, skipping `skip` and taking `take`.
   * Excludes deleted-for-all AND messages this user deleted-for-me. The deletion
   * filter is applied at the DB level via a raw Mongo match (see
   * `conversationMatch`), so the page is exactly `take` rows with correct offsets.
   */
  async listConversationMessages(params: {
    roomId: string;
    userId: string;
    beforeMs: number;
    skip: number;
    take: number;
  }): Promise<GeneralRoomMessage[]> {
    const raw = (await this.prisma.generalRoomMessage.findRaw({
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
    const docs = await this.prisma.generalRoomMessage.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(docs.map((d) => [d.id, d]));
    return ids
      .map((id) => byId.get(id))
      .filter((d): d is GeneralRoomMessage => Boolean(d));
  }

  /**
   * Count for the conversation page — SAME filter as `listConversationMessages`
   * (createdAt < beforeMs, not deleted-for-all, not deleted-for-me), so
   * total/hasMore line up with the returned page. Uses `aggregateRaw` because
   * the per-user `deletedBy` Json array can't be filtered via the typed `count` API.
   */
  async countConversation(params: {
    roomId: string;
    userId: string;
    beforeMs: number;
  }): Promise<number> {
    const result = (await this.prisma.generalRoomMessage.aggregateRaw({
      pipeline: [
        { $match: this.conversationMatch(params) },
        { $count: "total" },
      ],
    })) as unknown as Array<{ total: number }>;
    return result[0]?.total ?? 0;
  }

  /**
   * Count of messages in the room still newer than `afterDate` that are visible
   * to this user (not deleted-for-all, not deleted-for-me). Used to recompute
   * remaining unread after advancing a read pointer to a non-newest page.
   */
  async countUnreadAfter(params: {
    roomId: string;
    userId: string;
    afterDate: Date;
  }): Promise<number> {
    const result = (await this.prisma.generalRoomMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId: { $oid: params.roomId },
            deletedForAll: false,
            createdAt: { $gt: { $date: params.afterDate.toISOString() } },
            deletedBy: { $ne: params.userId },
          },
        },
        { $count: "total" },
      ],
    })) as unknown as Array<{ total: number }>;
    return result[0]?.total ?? 0;
  }

  /**
   * Bulk unread counts for many rooms in ONE aggregateRaw: for each room, count
   * visible messages (not deleted-for-all, not deleted-for-me) created strictly
   * after that room's per-user read threshold. A `$switch` selects the right
   * threshold per roomId (default epoch 0 for never-read rooms). Returns a
   * Record<roomId(hex), number>; rooms with no matching docs are absent (treat
   * as 0 by the caller).
   *
   * `roomId` is an ObjectId column, so thresholds are matched via `{ $oid }` and
   * the grouped `_id` comes back as extended JSON `{ $oid: "<hex>" }`.
   */
  async countUnreadBulk(params: {
    userId: string;
    thresholds: Array<{ roomId: string; afterDate: Date }>;
  }): Promise<Record<string, number>> {
    if (!params.thresholds.length) return {};

    const oids = params.thresholds.map((t) => ({ $oid: t.roomId }));
    const branches = params.thresholds.map((t) => ({
      case: { $eq: ["$roomId", { $oid: t.roomId }] },
      then: { $date: t.afterDate.toISOString() },
    }));

    const result = (await this.prisma.generalRoomMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId: { $in: oids },
            deletedForAll: false,
            deletedBy: { $ne: params.userId },
          },
        },
        {
          $addFields: {
            _thr: {
              $switch: {
                branches,
                default: { $date: "1970-01-01T00:00:00.000Z" },
              },
            },
          },
        },
        { $match: { $expr: { $gt: ["$createdAt", "$_thr"] } } },
        { $group: { _id: "$roomId", total: { $sum: 1 } } },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{
      _id: { $oid?: string } | string;
      total: number;
    }>;

    const counts: Record<string, number> = {};
    for (const row of result) {
      const hex = typeof row._id === "string" ? row._id : row._id?.$oid;
      if (hex) counts[hex] = row.total;
    }
    return counts;
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

  async editMessage(
    messageId: string,
    text: string
  ): Promise<GeneralRoomMessage> {
    // `message` is a top-level String field here (community schema), so we edit
    // it directly while pushing the prior text into editHistory.
    const existing = await this.prisma.generalRoomMessage.findUnique({
      where: { id: messageId },
    });
    const now = new Date();
    const history = Array.isArray(existing?.editHistory)
      ? (existing!.editHistory as unknown[])
      : [];
    const updatedHistory = [
      ...history,
      { text: existing?.message ?? "", editedAt: now.toISOString() },
    ];

    return this.prisma.generalRoomMessage.update({
      where: { id: messageId },
      data: {
        message: text,
        editedAt: now,
        editHistory: updatedHistory as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * List media/document messages in a community room, newest first, cursor on
   * createdAt. Community types are lowercase, so the caller's upper-case `type`
   * filter is mapped down. Excludes deleted-for-all; per-user deletes filtered
   * in memory.
   */
  async listMedia(params: {
    roomId: string;
    userId: string;
    type?: string;
    cursor?: string | null;
    limit: number;
  }): Promise<GeneralRoomMessage[]> {
    // Community enum is lowercase (e.g. "image"); GIF/VIDEO/DOCUMENT are carried
    // as "custom" today. Map the incoming upper-case filter to its community
    // storage value (IMAGE→image, VIDEO/GIF/DOCUMENT→custom, …). An unknown
    // mapped value would never match any stored doc, so we don't fall back to the
    // full set — that's the bug we're fixing (the filter must actually filter).
    const mediaTypes = [...COMMUNITY_MEDIA_MESSAGE_TYPES];
    const mappedType = params.type
      ? mapCommunityMediaType(params.type)
      : undefined;

    const messages = await this.prisma.generalRoomMessage.findMany({
      where: {
        roomId: params.roomId,
        deletedForAll: false,
        messageType: params.type
          ? // A requested type with no mapping yields no media (empty result)
            // instead of silently returning everything.
            (mappedType ?? "__none__")
          : { in: mediaTypes },
        ...(params.cursor
          ? { createdAt: { lt: new Date(params.cursor) } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: params.limit + 10,
    });

    return messages
      .filter((msg) => {
        const deletedBy = (msg.deletedBy ?? []) as string[];
        return !deletedBy.includes(params.userId);
      })
      .slice(0, params.limit);
  }

  /**
   * Catch-up query: returns messages in `roomId` with `_id > sinceId`, oldest
   * first, up to `limit + 1` rows (caller checks `raw.length > limit` for
   * hasMore). Uses aggregateRaw so the ObjectId `$gt` comparison is exact and
   * the per-user `deletedBy` array is filtered at the DB level.
   * When `sinceId` is empty the constraint is omitted (returns oldest N rows —
   * callers that want the latest N should use findByRoomIdTimeline instead).
   */
  async findSinceId(params: {
    roomId: string;
    userId: string;
    sinceId: string;
    limit: number;
  }): Promise<{ messages: GeneralRoomMessage[]; hasMore: boolean }> {
    // Note: deletedForAll is intentionally NOT filtered here so that tombstones
    // are visible to the client. The client uses `isDeleted` to reconcile
    // offline deletes it missed; per-user "delete for me" is still filtered via
    // the deletedBy array below.
    const matchStage: Record<string, unknown> = {
      roomId: { $oid: params.roomId },
      deletedBy: { $ne: params.userId },
    };
    if (params.sinceId) {
      matchStage["_id"] = { $gt: { $oid: params.sinceId } };
    }

    const raw = (await this.prisma.generalRoomMessage.aggregateRaw({
      pipeline: [
        { $match: matchStage },
        { $sort: { _id: 1 } },
        { $limit: params.limit + 1 },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{ _id?: { $oid?: string } | string }>;

    const hasMore = raw.length > params.limit;
    const ids = raw
      .slice(0, params.limit)
      .map((doc) => (typeof doc._id === "string" ? doc._id : doc._id?.$oid))
      .filter((id): id is string => Boolean(id));

    if (!ids.length) return { messages: [], hasMore: false };

    const docs = await this.prisma.generalRoomMessage.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(docs.map((d) => [d.id, d]));
    return {
      messages: ids
        .map((id) => byId.get(id))
        .filter((d): d is GeneralRoomMessage => Boolean(d)),
      hasMore,
    };
  }

  /**
   * Incremental sync: returns ALL messages (including tombstones) whose
   * `updatedAt >= fromTs`. This covers new messages, edits, reaction changes,
   * and deletes in a single query — designed for offline-first mobile clients
   * doing a catch-up sync after returning from the background.
   *
   * Unlike `findByRoomIdTimeline`, tombstones (`deletedForAll=true`) are
   * included so the client can reconcile deletes it missed while offline.
   * Per-user `deletedBy` filtering is still applied.
   *
   * Over-fetches by 1 so the caller can detect `hasMore`. Results are sorted
   * by `updatedAt` asc — the client stores the last item's `updatedAt` as the
   * next `after_ts`.
   */
  async findUpdatedAtSince(params: {
    roomId: string;
    userId: string;
    fromTs: Date;
    limit: number;
  }): Promise<{ messages: GeneralRoomMessage[]; hasMore: boolean }> {
    const raw = await this.prisma.generalRoomMessage.findMany({
      where: {
        roomId: params.roomId,
        updatedAt: { gte: params.fromTs },
        // deletedForAll intentionally NOT filtered — tombstones must be
        // included so the client can reconcile deletes missed while offline.
      },
      orderBy: { updatedAt: "asc" },
      take: params.limit + 1,
    });

    const hasMore = raw.length > params.limit;
    const messages = raw.slice(0, params.limit).filter((msg) => {
      // Per-user deletedBy filtered in memory (Prisma/Mongo limitation).
      const deletedBy = (msg.deletedBy ?? []) as string[];
      return !deletedBy.includes(params.userId);
    });

    return { messages, hasMore };
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
