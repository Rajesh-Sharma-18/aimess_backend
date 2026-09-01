import type {
  PrismaClient,
  GroupMessage,
  Prisma,
} from "../generated/prisma/index.js";
import { MEDIA_MESSAGE_TYPES } from "../constants/media-limits.js";
import { isHiddenForUser } from "../lib/message-hidden-for-user.js";
import type { GroupRoomRepository } from "./group-room.repository.js";
import {
  buildTextSearchPipeline,
  escapeRegex,
  orderByIds,
  parseSearchCursor,
  readTextSearchPage,
} from "./message-search.js";
import { logger } from "@aimess/logger";
import {
  shouldCountInUnread,
  UNREAD_COUNTABLE_RAW_MATCH,
} from "../lib/unread-count.js";
import {
  refreshQuoteDataForParent,
  type QuoteRefreshPatch,
} from "../lib/quote-refresh.js";
import {
  claimDueAutoDeletes,
  releaseAutoDeleteClaim,
  type AutoDeleteClaimDelegate,
  type ClaimedAutoDelete,
} from "../lib/auto-delete-claim.js";

/**
 * NOTE — zero-loss revision axis. Every CONTENT mutation in this file allocates a room
 * revision and stamps it on the row, so `/changes` can replay it. Allocation lives HERE
 * (not at the service layer, as community does) so a new caller cannot forget it.
 * Deliberate exception, which must NOT bump: `deleteForMe` — per-user view state, and
 * `revision` is a room-level axis with no per-viewer dimension.
 */
export class GroupMessageRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly roomRepo: GroupRoomRepository
  ) {}

  /** Refresh `quoteData.preview`/`.isDeleted` on every reply to `parentMessageId`. */
  async refreshReplyQuotes(
    parentMessageId: string,
    patch: QuoteRefreshPatch
  ): Promise<void> {
    await refreshQuoteDataForParent(
      this.prisma,
      "group_messages",
      parentMessageId,
      patch
    );
  }

  async create(data: {
    roomId: string;
    [key: string]: unknown;
  }): Promise<GroupMessage> {
    const revision = await this.roomRepo.allocateRevision(data.roomId);
    return this.prisma.groupMessage.create({
      data: {
        roomId: data.roomId,
        sequenceNumber: (data.sequenceNumber as number) ?? 0,
        revision,
        clientMessageId: (data.clientMessageId as string) ?? null,
        clientInfo: (data.clientInfo as object) ?? null,
        senderId: (data.senderId as string) ?? null,
        senderName: (data.senderName as string) ?? "",
        senderAvatar: (data.senderAvatar as string) ?? "",
        messageType: (data.messageType as string) ?? "TEXT",
        countInUnread: shouldCountInUnread({
          messageType: (data.messageType as string) ?? "TEXT",
          systemEvent: (data.systemEvent as string) ?? null,
          explicit: data.countInUnread as boolean | null | undefined,
        }),
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
        autoDeleteAt: (data.autoDeleteAt as Date | null) ?? null,
        autoDeleteAfterView: (data.autoDeleteAfterView as boolean) ?? false,
      },
    });
  }

  // ───────────────────────── auto-delete (disappearing messages) ────────────
  // Direct mirror of PrivateMessageRepository's block — read its comments for
  // the reasoning behind the `not: null` guards in `lib/auto-delete-claim.ts`,
  // which are load-bearing rather than defensive.
  //
  // There is deliberately NO `armAfterViewing` here. A group message carries one
  // GLOBAL deadline, so arming on the first member's read receipt deleted the
  // message for members who had never opened it — presented as a feature
  // ("don't wait for the slowest member"), but in practice a silent
  // delete-for-everyone triggered by one reader. Group AFTER_VIEWING is now
  // rejected at the settings endpoint instead; re-introducing it needs
  // per-member visibility/deadline state, not a re-added method.

  /**
   * Lease one page of due group messages to THIS worker — same guarantees and
   * the same shared implementation as private. See `lib/auto-delete-claim.ts`.
   */
  async claimDueAutoDeletes(params: {
    now: Date;
    limit: number;
    token: string;
    leaseSeconds?: number;
  }): Promise<ClaimedAutoDelete[]> {
    return claimDueAutoDeletes(
      this.prisma.groupMessage as unknown as AutoDeleteClaimDelegate,
      params
    );
  }

  /** Hand a claimed row back after a failed delete, with bounded backoff. */
  async releaseAutoDeleteClaim(params: {
    id: string;
    attempts: number;
    error: string;
    now: Date;
  }): Promise<void> {
    await releaseAutoDeleteClaim(
      this.prisma.groupMessage as unknown as AutoDeleteClaimDelegate,
      params
    );
  }

  /**
   * Re-stamp still-pending messages after an admin CHANGES the timer (both
   * lengthening and shortening apply to messages already counting down). Only
   * rows that ALREADY have a timer are touched — a change never retroactively
   * puts a deadline on messages sent while the feature was off.
   *
   * Unlike private this needs no sender filter: one timer governs the whole
   * group, so every member's pending messages move together.
   *
   * `autoDeleteAt = createdAt + ttl` is per-row arithmetic, which the typed
   * client can't express in one `updateMany`; same raw-command pattern as
   * `lib/quote-refresh.ts` so it stays a single indexed write.
   */
  async restampPendingAutoDeletes(params: {
    roomId: string;
    /** TIMER: seconds from createdAt. AFTER_VIEWING: null. */
    ttlSeconds: number | null;
    afterView: boolean;
  }): Promise<void> {
    const { roomId, ttlSeconds, afterView } = params;
    const set = afterView
      ? { autoDeleteAfterView: true, autoDeleteAt: null }
      : {
          autoDeleteAfterView: false,
          autoDeleteAt: {
            $add: ["$createdAt", Math.round((ttlSeconds ?? 0) * 1000)],
          },
        };
    await this.prisma.$runCommandRaw({
      update: "group_messages",
      updates: [
        {
          q: {
            roomId,
            isDeleted: false,
            $or: [
              { autoDeleteAt: { $ne: null } },
              { autoDeleteAfterView: true },
            ],
          },
          // Pipeline form — required for the `$createdAt + ttl` expression.
          u: [{ $set: set }],
          multi: true,
        },
      ],
    });
  }

  async findById(messageId: string): Promise<GroupMessage | null> {
    if (!/^[0-9a-f]{24}$/i.test(messageId)) return null;
    return this.prisma.groupMessage.findUnique({ where: { id: messageId } });
  }

  /** Mirrors CommunityMessageRepository/GeneralRoomMessageRepository's addReport. */
  async addReport(
    messageId: string,
    report: { userReportId: string; userReportReason: string }
  ): Promise<GroupMessage | null> {
    const existing = await this.prisma.groupMessage.findUnique({
      where: { id: messageId },
    });
    if (!existing) return null;

    const reports = (existing.reports ?? []) as Array<Record<string, unknown>>;
    reports.push({ ...report, reportedAt: new Date() });

    return this.prisma.groupMessage.update({
      where: { id: messageId },
      data: { reports: reports as unknown as Prisma.InputJsonValue },
    });
  }

  /** Batch findById — used to resolve a page's own-last-message read ticks in one query. */
  async findManyByIds(ids: string[]): Promise<GroupMessage[]> {
    const validIds = [...new Set(ids)].filter((id) =>
      /^[0-9a-f]{24}$/i.test(id)
    );
    if (!validIds.length) return [];
    return this.prisma.groupMessage.findMany({
      where: { id: { in: validIds } },
    });
  }

  /**
   * Every other member's DELIVERED high-water mark (`userId` → `sequenceNumber`),
   * derived from the newest of MY messages each member appears in `deliveredTo` on.
   * Group's answer to PrivateMessageRepository.getNewestDeliveredSeq — one indexed
   * query for the whole roster instead of one per member, since a single desc scan
   * of my own messages yields every member's first (= newest) hit.
   */
  async getMemberDeliveredSeqs(
    roomId: string,
    senderId: string
  ): Promise<Record<string, number>> {
    const rows = await this.prisma.groupMessage.findMany({
      where: { roomId, senderId, isDeleted: false },
      orderBy: { sequenceNumber: "desc" },
      take: 50,
      select: { sequenceNumber: true, deliveredTo: true },
    });
    const cursors: Record<string, number> = {};
    for (const row of rows) {
      const list = Array.isArray(row.deliveredTo)
        ? (row.deliveredTo as unknown as string[])
        : [];
      for (const userId of list) {
        if (userId === senderId) continue;
        if (cursors[userId] === undefined)
          cursors[userId] = row.sequenceNumber ?? 0;
      }
    }
    return cursors;
  }

  /**
   * Presence-driven delivery: append `recipientId` to `deliveredTo` on every
   * message in `roomId` at or before `upToMessageId` that was sent by someone
   * OTHER than the recipient and that they aren't already listed in. Returns
   * the touched ids so the caller can publish one `message:delivered` per
   * batch. Mirrors PrivateMessageRepository.markDeliveredUpTo. 200-row cap
   * keeps a big offline-then-online catch-up from stalling the presence recompute.
   */
  async markDeliveredUpTo(
    roomId: string,
    recipientId: string,
    upToMessageId: string
  ): Promise<{ count: number; messageIds: string[] }> {
    if (!/^[0-9a-f]{24}$/i.test(upToMessageId))
      return { count: 0, messageIds: [] };
    const upTo = await this.prisma.groupMessage.findUnique({
      where: { id: upToMessageId },
    });
    if (!upTo) return { count: 0, messageIds: [] };

    const candidates = await this.prisma.groupMessage.findMany({
      where: {
        roomId,
        senderId: { not: recipientId },
        createdAt: { lte: upTo.createdAt },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    const updatedIds: string[] = [];
    for (const msg of candidates) {
      const deliveredTo = (msg as unknown as { deliveredTo?: unknown })
        .deliveredTo;
      const list = Array.isArray(deliveredTo) ? (deliveredTo as string[]) : [];
      if (list.includes(recipientId)) continue;
      await this.prisma.groupMessage.update({
        where: { id: msg.id },
        data: { deliveredTo: [...list, recipientId] },
      });
      updatedIds.push(msg.id);
    }
    return { count: updatedIds.length, messageIds: updatedIds };
  }

  /**
   * Which of `ids` are still live (exist in this room, not deleted-for-
   * everyone). One batched query — used by the pins list to stamp each pin's
   * `isAvailable` so the banner can show a "pinned-but-deleted" state without
   * an N+1. Per-user delete-for-me is intentionally NOT considered (per-viewer
   * concern the client resolves via message-context on navigation).
   */
  async findLiveIds(roomId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.groupMessage.findMany({
      where: { roomId, id: { in: ids }, isDeleted: false },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Of `ids`, the ones `userId` has hidden with delete-for-me. Filtered in
   * memory (same as every other `deletedForUserIds` read path in this repo);
   * `ids` is a single page, so the read stays bounded.
   */
  async findHiddenIdsForUser(
    roomId: string,
    ids: string[],
    userId: string
  ): Promise<Set<string>> {
    if (ids.length === 0 || !userId) return new Set();
    const rows = await this.prisma.groupMessage.findMany({
      where: { roomId, id: { in: ids } },
      select: { id: true, deletedForUserIds: true },
    });
    return new Set(
      rows.filter((r) => isHiddenForUser(r, userId)).map((r) => r.id)
    );
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
    userId?: string,
    cutoff?: Date
  ): Promise<GroupMessage[]> {
    const ltDate = new Date(beforeTimestamp);
    const messages = await this.prisma.groupMessage.findMany({
      where: {
        roomId,
        // isDeleted: true means "deleted for everyone" — exclude at DB level,
        // same as the private equivalent. Delete-for-me keeps isDeleted:false
        // and is filtered in memory below.
        isDeleted: false,
        createdAt: cutoff ? { lt: ltDate, gt: cutoff } : { lt: ltDate },
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
   * Matches the legacy `findByRoomIdWithTime` visibility: deleted-for-everyone
   * messages are excluded at the DB level, and per-user "delete for me"
   * (deletedForUserIds Json array) is filtered in memory.
   * Over-fetches a small buffer, then returns up to `limit + 1` survivors so the
   * caller can compute exact `hasMore`.
   */
  /**
   * Shared `$match` for the group timeline (and its count) — the SINGLE source of
   * truth so `findByRoomIdTimeline` and `countTimeline` filter IDENTICALLY.
   * Excludes deleted-for-everyone (`isDeleted`) — same as private/community history,
   * `conversationMatch` and `countByRoom`, so a delete stays deleted across a reload
   * — and the viewer's own delete-for-me. Tombstones still replay on the catch-up
   * axes (`findAfterSeq` / `findByRoomIdRevisionSince`), which is where a client
   * learns about a delete it missed. `deletedForUserIds` is a Json array; Mongo's `$ne` on it matches
   * docs where NO element equals the user (i.e. "not deleted for this user").
   * `roomId` is a plain String column here (not an ObjectId).
   */
  private timelineMatch(params: {
    roomId: string;
    userId: string;
    /** Per-user "delete conversation" cutoff — excludes everything at/before it. */
    cutoff?: Date;
    /** A member who left keeps read access only up to (inclusive of) this instant. */
    readCutoffBefore?: Date;
  }): Record<string, unknown> {
    const core = {
      roomId: params.roomId,
      isDeleted: false,
      deletedForUserIds: { $ne: params.userId },
    };
    const bounds: Record<string, unknown>[] = [];
    if (params.cutoff) {
      bounds.push({
        createdAt: { $gt: { $date: params.cutoff.toISOString() } },
      });
    }
    if (params.readCutoffBefore) {
      bounds.push({
        createdAt: { $lte: { $date: params.readCutoffBefore.toISOString() } },
      });
    }
    if (bounds.length === 0) return core;
    return { $and: [core, ...bounds] };
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
    /** A member who left keeps read access only up to this instant — see {@link timelineMatch}. */
    readCutoffBefore?: Date;
  }): Promise<{ messages: GroupMessage[]; hasMore: boolean }> {
    const before = params.direction === "before";
    const base = this.timelineMatch({
      roomId: params.roomId,
      userId: params.userId,
      cutoff: params.cutoff,
      readCutoffBefore: params.readCutoffBefore,
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
    cutoff?: Date;
    readCutoffBefore?: Date;
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
    /** null = no lower bound, i.e. the newest page. */
    seq: number | null;
    limit: number;
    cutoff?: Date;
    /** A member who left keeps read access only up to this instant — see {@link timelineMatch}. */
    readCutoffBefore?: Date;
  }): Promise<GroupMessage[]> {
    const bound =
      params.seq == null
        ? undefined
        : params.direction === "before"
          ? { lt: params.seq }
          : { gt: params.seq };
    const order = params.direction === "before" ? "desc" : "asc";
    const messages = await this.prisma.groupMessage.findMany({
      where: {
        roomId: params.roomId,
        isDeleted: false,
        sequenceNumber: bound,
        ...(params.cutoff || params.readCutoffBefore
          ? {
              createdAt: {
                ...(params.cutoff ? { gt: params.cutoff } : {}),
                ...(params.readCutoffBefore
                  ? { lte: params.readCutoffBefore }
                  : {}),
              },
            }
          : {}),
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
    cutoff?: Date;
    /** A member who left keeps read access only up to this instant — see {@link timelineMatch}. */
    readCutoffBefore?: Date;
  }): Promise<GroupMessage[]> {
    const half = Math.max(1, Math.floor(params.limit / 2));
    const keep = (msg: GroupMessage): boolean => {
      const raw = msg as unknown as { deletedForUserIds?: unknown };
      const deletedFor = (raw.deletedForUserIds ?? []) as string[];
      return !deletedFor.includes(params.userId);
    };
    const cutoffWhere =
      params.cutoff || params.readCutoffBefore
        ? {
            createdAt: {
              ...(params.cutoff ? { gt: params.cutoff } : {}),
              ...(params.readCutoffBefore
                ? { lte: params.readCutoffBefore }
                : {}),
            },
          }
        : {};
    const [before, anchorAndAfter] = await Promise.all([
      this.prisma.groupMessage.findMany({
        where: {
          roomId: params.roomId,
          isDeleted: false,
          sequenceNumber: { lt: params.anchorSeq },
          ...cutoffWhere,
        },
        orderBy: { sequenceNumber: "desc" },
        take: half + 10,
      }),
      this.prisma.groupMessage.findMany({
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
    cutoff?: Date;
  }): Prisma.InputJsonObject {
    return {
      roomId: params.roomId,
      isDeleted: false,
      createdAt: {
        $lt: { $date: new Date(params.beforeMs).toISOString() },
        ...(params.cutoff
          ? { $gt: { $date: params.cutoff.toISOString() } }
          : {}),
      },
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
    cutoff?: Date;
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
    cutoff?: Date;
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
    cutoff?: Date;
  }): Promise<number> {
    // The read pointer never sits before the user's own delete-conversation
    // cutoff, but clamp defensively so unread can never count pre-cutoff rows.
    const effectiveAfter =
      params.cutoff && params.cutoff > params.afterDate
        ? params.cutoff
        : params.afterDate;
    const result = (await this.prisma.groupMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId: params.roomId,
            isDeleted: false,
            createdAt: { $gt: { $date: effectiveAfter.toISOString() } },
            deletedForUserIds: { $ne: params.userId },
            // Own messages never count toward the caller's unread — mirrors
            // community countUnreadBulk (`sentBy: { $ne: userId }`) and private
            // markReadUpTo (`senderId: { not: userId }`). Without this, mark-read
            // / getConversation recompute inflated unread whenever the user had
            // sent anything after the new pointer.
            senderId: { $ne: params.userId },
            // Hard-exclude SYSTEM rows even if a legacy doc is missing
            // countInUnread:false (UNREAD_COUNTABLE_RAW_MATCH treats missing as
            // countable).
            messageType: { $ne: "SYSTEM" },
            systemEvent: null,
            ...UNREAD_COUNTABLE_RAW_MATCH,
          },
        },
        { $count: "total" },
      ],
    })) as unknown as Array<{ total: number }>;
    return result[0]?.total ?? 0;
  }

  async searchByText(params: {
    roomId: string;
    query: string;
    limit: number;
    userId: string;
    cursor?: string | null;
    cutoff?: Date;
  }): Promise<{
    messages: GroupMessage[];
    scores: Map<string, number>;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const pipeline = buildTextSearchPipeline({
      match: {
        roomId: params.roomId,
        isDeleted: false,
        deletedForUserIds: { $ne: params.userId },
        ...(params.cutoff
          ? { createdAt: { $gt: { $date: params.cutoff.toISOString() } } }
          : {}),
      },
      field: "content.text",
      query: params.query,
      cursor: parseSearchCursor(params.cursor),
      limit: params.limit,
    });

    const raw = (await this.prisma.groupMessage.aggregateRaw({
      pipeline: pipeline as unknown as Prisma.InputJsonValue[],
    })) as unknown as Parameters<typeof readTextSearchPage>[0];
    const page = readTextSearchPage(raw ?? [], params.limit);
    if (!page.ids.length) {
      return {
        messages: [],
        scores: page.scores,
        hasMore: false,
        nextCursor: null,
      };
    }

    const rows = await this.prisma.groupMessage.findMany({
      where: { id: { in: page.ids } },
    });
    return {
      messages: orderByIds(rows, page.ids),
      scores: page.scores,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
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

  /** All rows from one album send (base id + `base:N` siblings), seq-ordered. */
  async findAlbumBatchByClientMessageId(
    roomId: string,
    senderId: string,
    baseClientMessageId: string
  ): Promise<GroupMessage[]> {
    return this.prisma.groupMessage.findMany({
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

  /**
   * Bump this message's CHANGE cursor WITHOUT touching its content — for
   * mutations that live outside the message row but still change what a client
   * should render (pin/unpin, moderation). Without this, a pin never appeared
   * on the `/changes` feed, so an offline client had no way to learn about it.
   * Best-effort by contract: callers treat a failure as non-fatal.
   */
  async touchRevision(roomId: string, messageId: string): Promise<number> {
    const revision = await this.roomRepo.allocateRevision(roomId);
    await this.prisma.groupMessage.update({
      where: { id: messageId },
      data: { revision },
    });
    return revision;
  }

  async addReactions(
    messageId: string,
    roomId: string,
    reactions: Record<string, unknown[]>
  ): Promise<GroupMessage | null> {
    const revision = await this.roomRepo.allocateRevision(roomId);
    return this.prisma.groupMessage.update({
      where: { id: messageId },
      data: {
        reactions: reactions as unknown as Prisma.InputJsonValue,
        revision,
      },
    });
  }

  /** See PrivateMessageRepository.updateReactionsCas — identical CAS semantics. */
  async updateReactionsCas(
    messageId: string,
    roomId: string,
    reactions: Record<string, unknown[]>,
    expectedRevision: number
  ): Promise<boolean> {
    const revision = await this.roomRepo.allocateRevision(roomId);
    const result = await this.prisma.groupMessage.updateMany({
      where: { id: messageId, revision: expectedRevision },
      data: {
        reactions: reactions as unknown as Prisma.InputJsonValue,
        revision,
      },
    });
    return result.count > 0;
  }

  async deleteForEveryone(
    messageId: string,
    roomId: string,
    userId: string,
    deletedType: string
  ): Promise<GroupMessage | null> {
    const revision = await this.roomRepo.allocateRevision(roomId);
    return this.prisma.groupMessage.update({
      where: { id: messageId },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        deletedType,
        deletedPlaceholder: "This message was deleted",
        revision,
      },
    });
  }

  // NO revision bump: delete-for-me is per-user view state, and `revision` is a
  // room-level axis the /changes payload cannot express per-viewer. See class KDoc.
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

  async countSearchResults(
    roomId: string,
    query: string,
    userId: string,
    cutoff?: Date
  ): Promise<number> {
    const escaped = escapeRegex(query);
    const result = (await this.prisma.groupMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId,
            isDeleted: false,
            deletedForUserIds: { $ne: userId },
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
    countInUnread?: boolean | null;
    forwardData: object;
    clientMessageId?: string | null;
    sequenceNumber?: number;
    /** Auto-delete stamp of the TARGET room — a forward is a brand new message there. */
    autoDeleteAt?: Date | null;
    autoDeleteAfterView?: boolean;
  }): Promise<GroupMessage> {
    const revision = await this.roomRepo.allocateRevision(data.roomId);
    return this.prisma.groupMessage.create({
      data: {
        roomId: data.roomId,
        sequenceNumber: (data.sequenceNumber as number) ?? 0,
        revision,
        senderId: data.senderId,
        senderName: data.senderName,
        senderAvatar: data.senderAvatar,
        content: data.content as Prisma.InputJsonValue,
        messageType: data.messageType,
        countInUnread: shouldCountInUnread({
          messageType: data.messageType,
          explicit: data.countInUnread ?? null,
        }),
        isForwarded: true,
        forwardData: data.forwardData as Prisma.InputJsonValue,
        clientMessageId: data.clientMessageId ?? null,
        reactions: {},
        isDeleted: false,
        deletedForUserIds: [],
        autoDeleteAt: data.autoDeleteAt ?? null,
        autoDeleteAfterView: data.autoDeleteAfterView ?? false,
      },
    });
  }

  /**
   * ZERO-LOSS CHANGES FEED — the mutation-aware catch-up query. See the private repo's
   * equivalent for the full rationale; the ONLY difference here is that group's per-viewer
   * hide is `deletedForUserIds` (a Json ARRAY) rather than private's `deletedFor` map.
   *
   * Tombstones (`isDeleted`) are INCLUDED so a delete replays. `nextRevision` is the MAX
   * revision of the raw page, NOT the last VISIBLE row's, so a fully-filtered page still
   * lets the client make progress.
   */
  async findByRoomIdRevisionSince(params: {
    roomId: string;
    userId: string;
    sinceRevision: number;
    limit: number;
    cutoff?: Date;
  }): Promise<{
    messages: GroupMessage[];
    hasMore: boolean;
    nextRevision: number | null;
  }> {
    const raw = await this.prisma.groupMessage.findMany({
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
      const hidden = ((msg as unknown as { deletedForUserIds?: unknown })
        .deletedForUserIds ?? []) as string[];
      if (hidden.includes(params.userId)) return false;
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
    const msg = await this.prisma.groupMessage.findUnique({
      where: { id: messageId },
      select: { reactions: true, roomId: true },
    });
    if (!msg) return null;
    return {
      reactions: msg.reactions as Record<string, unknown>,
      roomId: msg.roomId,
    };
  }

  async editMessage(
    messageId: string,
    roomId: string,
    content: object
  ): Promise<GroupMessage> {
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

    const revision = await this.roomRepo.allocateRevision(roomId);
    return this.prisma.groupMessage.update({
      where: { id: messageId },
      data: {
        content: content as unknown as Prisma.InputJsonValue,
        editedAt: now,
        editHistory: updatedHistory as unknown as Prisma.InputJsonValue,
        revision,
      },
    });
  }

  /**
   * GROUP twin of `PrivateMessageRepository.updateCallState` — in-place state
   * transition of an existing CALL row, so one call stays one timeline row for
   * its whole lifecycle. Not `editMessage`: no `editedAt`/`editHistory` stamp
   * (a call card must never render as "edited"), but it does allocate a fresh
   * room revision so the change rides `/changes` and `sinceRevision` catch-up.
   */
  async updateCallState(params: {
    messageId: string;
    roomId: string;
    content: object;
    messageType: string;
    systemEvent: string | null;
    systemData: object | null;
    countInUnread: boolean;
  }): Promise<GroupMessage> {
    const revision = await this.roomRepo.allocateRevision(params.roomId);
    return this.prisma.groupMessage.update({
      where: { id: params.messageId },
      data: {
        content: params.content as unknown as Prisma.InputJsonValue,
        messageType: params.messageType,
        systemEvent: params.systemEvent,
        systemData: params.systemData as unknown as Prisma.InputJsonValue,
        countInUnread: params.countInUnread,
        revision,
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
    cutoff?: Date;
  }): Promise<GroupMessage[]> {
    const mediaTypes = MEDIA_MESSAGE_TYPES;
    const createdAt: { lt?: Date; gt?: Date } = {};
    if (params.cursor) createdAt.lt = new Date(params.cursor);
    if (params.cutoff) createdAt.gt = params.cutoff;
    // Resolve composite aliases (mirrors PrivateMessageRepository). Without
    // this a `type=media` filter would try to match the literal string "media"
    // and silently return zero rows for group chats.
    const typeFilter = (() => {
      if (!params.type) return { in: [...mediaTypes] };
      if (params.type === "media") return { in: ["IMAGE", "VIDEO"] };
      if (params.type === "file") return { in: ["DOCUMENT", "AUDIO"] };
      return params.type;
    })();
    const messages = await this.prisma.groupMessage.findMany({
      where: {
        roomId: params.roomId,
        isDeleted: false,
        messageType: typeFilter,
        ...(Object.keys(createdAt).length ? { createdAt } : {}),
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

  /**
   * Most recent non-deleted message in a room — used to recalculate the
   * lastMessage preview after a delete-for-everyone removes the current one.
   */
  async findPreviousVisible(roomId: string): Promise<GroupMessage | null> {
    return this.prisma.groupMessage.findFirst({
      where: { roomId, isDeleted: false },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Batch visibility check for the per-user list resolver: of the supplied
   * message ids, which are hidden from `userId` — either globally deleted
   * (`isDeleted`) OR personally hidden via delete-for-me (`userId` is an element
   * of the `deletedForUserIds` ARRAY). Mirrors PrivateMessageRepository
   * `filterHiddenFromUser` (which uses the `deletedFor` MAP) against the group
   * ARRAY shape. Single aggregateRaw so list endpoints avoid N+1 hidden-checks.
   * `roomId` is a plain String column here; ids are matched on `_id` (ObjectId).
   */
  async filterHiddenFromUser(
    messageIds: string[],
    userId: string
  ): Promise<Set<string>> {
    if (!messageIds.length) return new Set();
    const raw = (await this.prisma.groupMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            _id: { $in: messageIds.map((id) => ({ $oid: id })) },
            // `deletedForUserIds: userId` matches docs where the ARRAY contains
            // userId (Mongo scalar-vs-array equality), the mirror of the history
            // `timelineMatch` filter `{ $ne: userId }`.
            $or: [{ isDeleted: true }, { deletedForUserIds: userId }],
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
   * Most recent message visible to a specific user — excludes globally-deleted
   * messages (`isDeleted`) AND messages the user hid for themselves
   * (`userId` in `deletedForUserIds`). The per-user mirror of `findPreviousVisible`,
   * used to recompute a viewer's effective last-message preview after a
   * delete-for-me. `$ne` on the ARRAY matches docs where NO element equals the
   * user (i.e. not hidden for them) — identical predicate to the group history
   * `timelineMatch`.
   */
  async findPreviousVisibleForUser(
    roomId: string,
    userId: string,
    cutoff?: Date
  ): Promise<GroupMessage | null> {
    const raw = (await this.prisma.groupMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId,
            isDeleted: false,
            deletedForUserIds: { $ne: userId },
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
    return this.prisma.groupMessage.findUnique({ where: { id } });
  }
}
