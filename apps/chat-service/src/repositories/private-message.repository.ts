import type {
  PrismaClient,
  PrivateMessage,
  Prisma,
} from "../generated/prisma/index.js";
import { MEDIA_MESSAGE_TYPES } from "../constants/media-limits.js";
import { logger } from "@aimess/logger";
import { shouldCountInUnread } from "../lib/unread-count.js";
import {
  refreshQuoteDataForParent,
  type QuoteRefreshPatch,
} from "../lib/quote-refresh.js";
import type { PrivateRoomRepository } from "./private-room.repository.js";

/**
 * NOTE — zero-loss revision axis. Every CONTENT mutation in this file allocates a room
 * revision and stamps it on the row, so `/changes` can replay it. Allocation lives HERE
 * (not at the service layer, as community does) so a new caller cannot forget it.
 * Deliberate exceptions, which must NOT bump: `deleteForMe` and `markDeliveredUpTo` —
 * both are per-user view state, and `revision` is a room-level axis with no per-viewer
 * dimension.
 */
export class PrivateMessageRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly roomRepo: PrivateRoomRepository
  ) {}

  async createMessage(data: {
    roomId: string;
    senderId?: string;
    receiverId?: string;
    content?: object;
    messageType?: string;
    systemEvent?: string | null;
    systemData?: object | null;
    countInUnread?: boolean | null;
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
    const revision = await this.roomRepo.allocateRevision(data.roomId);
    return this.prisma.privateMessage.create({
      data: {
        roomId: data.roomId,
        sequenceNumber: (data.sequenceNumber as number) ?? 0,
        revision,
        senderId: data.senderId ?? null,
        receiverId: data.receiverId ?? null,
        content: (data.content as object) ?? { text: "", urls: [], files: [] },
        messageType: data.messageType ?? "TEXT",
        systemEvent: data.systemEvent ?? null,
        systemData: (data.systemData as object) ?? null,
        countInUnread: shouldCountInUnread({
          messageType: data.messageType ?? "TEXT",
          systemEvent: data.systemEvent ?? null,
          explicit: data.countInUnread ?? null,
        }),
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
    if (!/^[0-9a-f]{24}$/i.test(messageId)) return null;
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
    limit: number,
    cutoff?: Date
  ): Promise<PrivateMessage[]> {
    const ltDate = new Date(beforeTimestamp);

    // isDeleted: true means "deleted for everyone" — exclude at DB level.
    // "deleted for me" messages keep isDeleted: false and are caught below.
    const messages = await this.prisma.privateMessage.findMany({
      where: {
        roomId: room.roomId,
        isDeleted: false,
        createdAt: cutoff ? { lt: ltDate, gt: cutoff } : { lt: ltDate },
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
  /**
   * Shared `$match` for the private timeline (and its count) — the SINGLE source
   * of truth so `findByRoomIdTimeline` and `countTimeline` filter IDENTICALLY.
   * Excludes deleted-for-everyone (`isDeleted`) and the viewer's own delete-for-me
   * (`deletedFor` is a Json MAP `{ [userId]: ts }`, so the per-user key must be
   * ABSENT). `roomId` is a plain String column here (not an ObjectId).
   */
  private timelineMatch(params: {
    roomId: string;
    userId: string;
    /** Per-user "delete conversation" cutoff — excludes everything at/before it. */
    cutoff?: Date;
  }): Record<string, unknown> {
    const core = {
      roomId: params.roomId,
      isDeleted: false,
      [`deletedFor.${params.userId}`]: { $exists: false },
    };
    if (!params.cutoff) return core;
    // Wrapped in $and (rather than merged into `core.createdAt`) so callers can
    // freely layer their own createdAt bound (keyset boundary, $or tie-break) on
    // top without colliding operator keys on the same field.
    return {
      $and: [
        core,
        { createdAt: { $gt: { $date: params.cutoff.toISOString() } } },
      ],
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
    /** Per-user "delete conversation" cutoff — see {@link timelineMatch}. */
    cutoff?: Date;
  }): Promise<{ messages: PrivateMessage[]; hasMore: boolean }> {
    const before = params.direction === "before";
    const base = this.timelineMatch({
      roomId: params.roomId,
      userId: params.userId,
      cutoff: params.cutoff,
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
  ): Promise<PrivateMessage[]> {
    const raw = (await this.prisma.privateMessage.aggregateRaw({
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

    const docs = await this.prisma.privateMessage.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(docs.map((d) => [d.id, d]));
    return ids
      .map((id) => byId.get(id))
      .filter((d): d is PrivateMessage => Boolean(d));
  }

  /** Fetch the rest of a same-millisecond cluster beyond `lastId` (degenerate
   *  single-ms extend path only). */
  private async fetchSameMsBeyond(
    base: Record<string, unknown>,
    boundaryMs: number,
    lastId: string,
    before: boolean
  ): Promise<PrivateMessage[]> {
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
    const raw = (await this.prisma.privateMessage.aggregateRaw({
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
   * per-user `deletedFor` map key can't be filtered via the typed count API.
   */
  async countTimeline(params: {
    roomId: string;
    userId: string;
    cutoff?: Date;
  }): Promise<number> {
    const result = (await this.prisma.privateMessage.aggregateRaw({
      pipeline: [
        { $match: this.timelineMatch(params) },
        { $count: "total" },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{ total: number }>;
    return result[0]?.total ?? 0;
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
    cutoff?: Date;
  }): Promise<PrivateMessage[]> {
    const bound =
      params.direction === "before" ? { lt: params.seq } : { gt: params.seq };
    const order = params.direction === "before" ? "desc" : "asc";
    const messages = await this.prisma.privateMessage.findMany({
      where: {
        roomId: params.roomId,
        isDeleted: false,
        sequenceNumber: bound,
        ...(params.cutoff ? { createdAt: { gt: params.cutoff } } : {}),
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
    cutoff?: Date;
  }): Promise<PrivateMessage[]> {
    const half = Math.max(1, Math.floor(params.limit / 2));
    const cutoffWhere = params.cutoff
      ? { createdAt: { gt: params.cutoff } }
      : {};
    const [before, anchorAndAfter] = await Promise.all([
      this.prisma.privateMessage.findMany({
        where: {
          roomId: params.roomId,
          isDeleted: false,
          sequenceNumber: { lt: params.anchorSeq },
          ...cutoffWhere,
        },
        orderBy: { sequenceNumber: "desc" },
        take: half + 10,
      }),
      this.prisma.privateMessage.findMany({
        where: {
          roomId: params.roomId,
          isDeleted: false,
          sequenceNumber: { gte: params.anchorSeq },
          ...cutoffWhere,
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

  /**
   * Which of `ids` are still live (exist in this room and not deleted-for-
   * everyone). One batched query — used by the pins list to stamp each pin's
   * `isAvailable` so the banner can show a "pinned-but-deleted" state without
   * an N+1. Per-user delete-for-me is intentionally NOT considered here: it's a
   * per-viewer concern the client resolves via the message-context call when it
   * actually navigates (mirrors community's `deletedForAll`-based availability).
   */
  async findLiveIds(roomId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.privateMessage.findMany({
      where: { roomId, id: { in: ids }, isDeleted: false },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  async searchByText(
    roomId: string,
    query: string,
    limit: number,
    userId: string,
    skip = 0,
    cutoff?: Date
  ): Promise<PrivateMessage[]> {
    // content.text lives inside a Json column, which Prisma's `contains` can't
    // target — use a raw regex query to find matching ids, then re-fetch via
    // the typed client so results have the normal message shape. `deletedFor.
    // <userId>` mirrors the exact filter findPreviousVisibleForUser/the main
    // timeline reads use to hide messages this user deleted-for-me — without
    // it, search resurrects messages the user can no longer see anywhere else.
    // `cutoff` (delete-conversation) is the same idea at the whole-room level.
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const raw = (await this.prisma.privateMessage.findRaw({
      filter: {
        roomId,
        isDeleted: false,
        [`deletedFor.${userId}`]: { $exists: false },
        "content.text": { $regex: escaped, $options: "i" },
        ...(cutoff
          ? { createdAt: { $gt: { $date: cutoff.toISOString() } } }
          : {}),
      },
      options: { sort: { createdAt: -1 }, skip, limit },
    })) as unknown as Array<{ _id?: { $oid?: string } | string }>;

    const ids = raw
      .map((doc) => (typeof doc._id === "string" ? doc._id : doc._id?.$oid))
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return [];

    const rows = await this.prisma.privateMessage.findMany({
      where: { id: { in: ids } },
    });
    // findRaw already returned the correctly ordered/paged id window — the
    // typed re-fetch above is an unordered `IN` lookup, so re-apply that same
    // order here rather than re-sorting by createdAt (which would silently
    // undo the pagination window on same-timestamp rows).
    const order = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  async addReactions(
    messageId: string,
    roomId: string,
    reactions: Record<string, unknown[]>
  ): Promise<PrivateMessage | null> {
    const revision = await this.roomRepo.allocateRevision(roomId);
    return this.prisma.privateMessage.update({
      where: { id: messageId },
      data: {
        reactions: reactions as unknown as Prisma.InputJsonValue,
        revision,
      },
    });
  }

  /**
   * Compare-and-swap reaction write — see GeneralRoomMessageRepository.updateReactionsCas
   * for the full rationale. Returns false on a lost race so the caller re-reads
   * and retries, closing the non-atomic reaction read-modify-write gap.
   */
  async updateReactionsCas(
    messageId: string,
    roomId: string,
    reactions: Record<string, unknown[]>,
    expectedRevision: number
  ): Promise<boolean> {
    const revision = await this.roomRepo.allocateRevision(roomId);
    const result = await this.prisma.privateMessage.updateMany({
      where: { id: messageId, revision: expectedRevision },
      data: {
        reactions: reactions as unknown as Prisma.InputJsonValue,
        revision,
      },
    });
    return result.count > 0;
  }

  async editMessage(
    messageId: string,
    roomId: string,
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

    const revision = await this.roomRepo.allocateRevision(roomId);
    return this.prisma.privateMessage.update({
      where: { id: messageId },
      data: {
        content: content as unknown as Prisma.InputJsonValue,
        editedAt: now,
        editHistory: updatedHistory as unknown as Prisma.InputJsonValue,
        revision,
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

  // NO revision bump: delete-for-me is per-user view state, and `revision` is a
  // room-level axis the /changes payload cannot express per-viewer. See class KDoc.
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
    roomId: string,
    userId: string
  ): Promise<PrivateMessage> {
    const revision = await this.roomRepo.allocateRevision(roomId);
    return this.prisma.privateMessage.update({
      where: { id: messageId },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        deletedFor: { type: "forEveryone" } as unknown as Prisma.InputJsonValue,
        revision,
      },
    });
  }

  /** Refresh `quoteData.preview`/`.isDeleted` on every reply to `parentMessageId`. */
  async refreshReplyQuotes(
    parentMessageId: string,
    patch: QuoteRefreshPatch
  ): Promise<void> {
    await refreshQuoteDataForParent(
      this.prisma,
      "private_messages",
      parentMessageId,
      patch
    );
  }

  async countSearchResults(
    roomId: string,
    query: string,
    userId: string,
    cutoff?: Date
  ): Promise<number> {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const result = (await this.prisma.privateMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId,
            isDeleted: false,
            [`deletedFor.${userId}`]: { $exists: false },
            "content.text": { $regex: escaped, $options: "i" },
            ...(cutoff
              ? { createdAt: { $gt: { $date: cutoff.toISOString() } } }
              : {}),
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

  /** All rows from one album send (base id + `base:N` siblings), seq-ordered. */
  async findAlbumBatchByClientMessageId(
    roomId: string,
    senderId: string,
    baseClientMessageId: string
  ): Promise<PrivateMessage[]> {
    return this.prisma.privateMessage.findMany({
      where: {
        roomId,
        senderId,
        OR: [
          { clientMessageId: baseClientMessageId },
          {
            clientMessageId: { startsWith: `${baseClientMessageId}:` },
          },
        ],
      },
      orderBy: { sequenceNumber: "asc" },
    });
  }

  async createForwardedMessage(data: {
    roomId: string;
    senderId: string;
    receiverId: string;
    content: object;
    messageType: string;
    countInUnread?: boolean | null;
    forwardData: object;
    clientMessageId?: string | null;
    sequenceNumber?: number;
  }): Promise<PrivateMessage> {
    const revision = await this.roomRepo.allocateRevision(data.roomId);
    return this.prisma.privateMessage.create({
      data: {
        roomId: data.roomId,
        sequenceNumber: (data.sequenceNumber as number) ?? 0,
        revision,
        senderId: data.senderId,
        receiverId: data.receiverId,
        content: data.content as Prisma.InputJsonValue,
        messageType: data.messageType,
        countInUnread: shouldCountInUnread({
          messageType: data.messageType,
          explicit: data.countInUnread ?? null,
        }),
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

  /**
   * ZERO-LOSS CHANGES FEED — the mutation-aware catch-up query.
   *
   * Every message whose room CHANGE `revision > sinceRevision`, current state, ordered
   * `revision ASC`. Unlike `after_seq` (inserts only) this returns an OLD message's current
   * state after an edit/reaction/delete-for-everyone, because a mutation bumps that row's
   * `revision` while its `sequenceNumber` never moves.
   *
   * Tombstones (`isDeleted`) are INCLUDED so a delete replays. Only the viewer's own
   * delete-for-me is filtered, and in memory — `deletedFor` is a Json MAP keyed by userId
   * (group's equivalent is an array), which Mongo can't index-filter here.
   *
   * `nextRevision` is the MAX revision of the raw page, NOT the last VISIBLE row's — so a
   * page fully filtered by delete-for-me still lets the client make progress. Revision is
   * monotonic, so advancing past a filtered row can never skip a visible change.
   */
  async findByRoomIdRevisionSince(params: {
    roomId: string;
    userId: string;
    sinceRevision: number;
    limit: number;
    cutoff?: Date;
  }): Promise<{
    messages: PrivateMessage[];
    hasMore: boolean;
    nextRevision: number | null;
  }> {
    const raw = await this.prisma.privateMessage.findMany({
      where: {
        roomId: params.roomId,
        revision: { gt: params.sinceRevision },
      },
      orderBy: { revision: "asc" },
      take: params.limit + 1,
    });

    const hasMore = raw.length > params.limit;
    const page = raw.slice(0, params.limit);
    const nextRevision = page.length ? page[page.length - 1]!.revision : null;

    const messages = page.filter((msg) => {
      const deletedFor = (msg.deletedFor ?? {}) as Record<string, unknown>;
      if (params.userId in deletedFor) return false;
      if (params.cutoff && msg.createdAt <= params.cutoff) return false;
      return true;
    });

    return { messages, hasMore, nextRevision };
  }

  /** Returns the stored reactor map plus the owning roomId — the caller needs the
   *  latter to allocate a revision, and it rides along on this same read for free. */
  async getReactions(
    messageId: string
  ): Promise<{ reactions: Record<string, unknown>; roomId: string } | null> {
    const msg = await this.prisma.privateMessage.findUnique({
      where: { id: messageId },
      select: { reactions: true, roomId: true },
    });
    if (!msg) return null;
    return {
      reactions: msg.reactions as Record<string, unknown>,
      roomId: msg.roomId,
    };
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
    cutoff?: Date;
  }): Promise<PrivateMessage[]> {
    const mediaTypes = MEDIA_MESSAGE_TYPES;
    const createdAt: { lt?: Date; gt?: Date } = {};
    if (params.cursor) createdAt.lt = new Date(params.cursor);
    if (params.cutoff) createdAt.gt = params.cutoff;
    const messages = await this.prisma.privateMessage.findMany({
      where: {
        roomId: params.roomId,
        isDeleted: false,
        messageType: params.type ? params.type : { in: [...mediaTypes] },
        ...(Object.keys(createdAt).length ? { createdAt } : {}),
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

  /**
   * Given a list of message IDs, returns those that are NOT visible to userId
   * (globally deleted OR personally hidden by that user).
   * Used as a single batch check before the per-user fallback in list endpoints
   * so we avoid N+1 queries for every conversation in the list.
   */
  async filterHiddenFromUser(
    messageIds: string[],
    userId: string
  ): Promise<Set<string>> {
    if (!messageIds.length) return new Set();
    const raw = (await this.prisma.privateMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            _id: { $in: messageIds.map((id) => ({ $oid: id })) },
            $or: [
              { isDeleted: true },
              { [`deletedFor.${userId}`]: { $exists: true } },
            ],
          },
        },
        { $project: { _id: 1 } },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{ _id?: { $oid?: string } | string }>;
    return new Set(
      raw
        .map((d) => (typeof d._id === "string" ? d._id : (d._id?.$oid ?? "")))
        .filter(Boolean)
    );
  }

  /**
   * Most recent non-deleted message in a room — used to recalculate the
   * lastMessage preview after a delete-for-everyone removes the current one.
   */
  async findPreviousVisible(roomId: string): Promise<PrivateMessage | null> {
    return this.prisma.privateMessage.findFirst({
      where: { roomId, isDeleted: false },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Most recent message visible to a specific user — excludes globally-deleted
   * messages (isDeleted) AND messages the user hid for themselves (deletedFor).
   * Used to recalculate the per-user list preview after a delete-for-me on the
   * last message. Uses aggregateRaw so we can match on the dynamic
   * `deletedFor.<userId>` key without loading every message in memory.
   */
  async findPreviousVisibleForUser(
    roomId: string,
    userId: string,
    cutoff?: Date
  ): Promise<PrivateMessage | null> {
    const raw = (await this.prisma.privateMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId,
            isDeleted: false,
            [`deletedFor.${userId}`]: { $exists: false },
            ...(cutoff
              ? { createdAt: { $gt: { $date: cutoff.toISOString() } } }
              : {}),
          },
        },
        { $sort: { createdAt: -1 } },
        { $limit: 1 },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{ _id?: { $oid?: string } | string }>;
    if (!raw.length) return null;
    const id = typeof raw[0]._id === "string" ? raw[0]._id : raw[0]._id?.$oid;
    if (!id) return null;
    return this.prisma.privateMessage.findUnique({ where: { id } });
  }
}
