import { logger } from "@aimess/logger";
import type {
  PrismaClient,
  GeneralRoomMessage,
  Prisma,
} from "../generated/prisma/index.js";
import {
  COMMUNITY_MEDIA_MESSAGE_TYPES,
  mapCommunityMediaType,
} from "../constants/media-limits.js";
import {
  PERSONAL_JOIN_SESSION_TYPES,
  HIDDEN_SYSTEM_MESSAGE_TYPES,
  isPersonalJoinSessionType,
  isHiddenSystemMessage,
} from "@aimess/constants";
import {
  shouldCountInUnread,
  UNREAD_COUNTABLE_RAW_MATCH,
} from "../lib/unread-count.js";
import {
  refreshQuoteDataForParent,
  type QuoteRefreshPatch,
} from "../lib/quote-refresh.js";

/**
 * PERSONAL system-message visibility check (applied in memory for Prisma
 * `findMany` reads). A message is visible to `userId` when it has no target
 * (`visibleToUserId` null OR absent — Prisma's `{ field: null }` filter does NOT
 * match field-absent Mongo docs, so this MUST be done in memory, not in the
 * where-clause) or it is targeted at this user. Raw aggregateRaw paths use
 * `$in: [null, userId]` instead, which matches missing fields natively.
 *
 * `viewerIsActiveMember` is the membership-session guard: personal JOIN-session
 * onboarding lines ("You joined the community") belong only to the CURRENT
 * membership session, so a non-active viewer (left / banned) browsing PUBLIC
 * community history must never see a prior session's join line — even though it
 * is targeted at them. The hard-delete-on-leave cleanup is the primary removal;
 * this is the read-time safety net for the window before (or if) it lands.
 */
function isVisibleToUser(
  msg: {
    visibleToUserId?: string | null;
    systemMessageType?: string | null;
    systemMetadata?: unknown;
    sentBy?: string | null;
  },
  userId: string,
  viewerIsActiveMember = true
): boolean {
  // Hidden membership-lifecycle lines (left / joined) are never shown in the
  // chat timeline. MEMBER_REMOVED / MEMBER_BANNED / MEMBER_UNBANNED are NOT
  // hidden — moderation actions are visible (Telegram parity). This also kills
  // the duplicate "You joined the community" the joiner saw: the legacy
  // MEMBER_JOINED was personalized to "You joined…", doubling the personal
  // COMMUNITY_JOINED line; hiding MEMBER_JOINED leaves exactly one personal line.
  // Applies regardless of membership/visibility, so it runs first.
  if (isHiddenSystemMessage(msg.systemMessageType)) {
    return false;
  }
  if (msg.visibleToUserId && msg.visibleToUserId !== userId) {
    return false;
  }
  // Membership-session guard: hide the viewer's OWN join-session onboarding line
  // once they are no longer an active member (a prior session's line).
  if (
    !viewerIsActiveMember &&
    msg.visibleToUserId === userId &&
    isPersonalJoinSessionType(msg.systemMessageType)
  ) {
    return false;
  }
  return true;
}

function personalJoinSessionGuard(
  userId: string,
  latestPersonalJoinMessageId: string | null
): Record<string, unknown> {
  const personalJoin = {
    visibleToUserId: userId,
    systemMessageType: { $in: [...PERSONAL_JOIN_SESSION_TYPES] },
  };
  if (!latestPersonalJoinMessageId) {
    return { $nor: [personalJoin] };
  }
  return {
    $or: [
      { $nor: [personalJoin] },
      { _id: { $eq: { $oid: latestPersonalJoinMessageId } } },
    ],
  };
}

function isLatestPersonalJoinSessionForUser(
  msg: {
    id: string;
    visibleToUserId?: string | null;
    systemMessageType?: string | null;
  },
  userId: string,
  latestPersonalJoinMessageId: string | null
): boolean {
  if (
    msg.visibleToUserId === userId &&
    isPersonalJoinSessionType(msg.systemMessageType)
  ) {
    return latestPersonalJoinMessageId === msg.id;
  }
  return true;
}

export class GeneralRoomMessageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private async findLatestPersonalJoinMessageId(
    roomId: string,
    userId: string
  ): Promise<string | null> {
    const raw = (await this.prisma.generalRoomMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId: { $oid: roomId },
            visibleToUserId: userId,
            systemMessageType: { $in: [...PERSONAL_JOIN_SESSION_TYPES] },
            deletedForAll: false,
            deletedBy: { $ne: userId },
          },
        },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: 1 },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{ _id?: { $oid?: string } | string }>;
    const id = raw[0]?._id;
    return typeof id === "string" ? id : (id?.$oid ?? null);
  }

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
        countInUnread: shouldCountInUnread({
          messageType: (data.messageType as string) ?? "text",
          explicit: data.countInUnread as boolean | null | undefined,
        }),
        reactions: (data.reactions as object) ?? {},
        parentMessageId: (data.parentMessageId as string) ?? null,
        quoteData: (data.quoteData as object) ?? null,
        messageType: (data.messageType as string) ?? "text",
        attachments: (data.attachments as object) ?? [],
        clientMessageId: (data.clientMessageId as string) ?? null,
        sequenceNumber: (data.sequenceNumber as number) ?? 0,
        revision: (data.revision as number) ?? 0,
        deletedBy: (data.deletedBy as object) ?? [],
        deletedForAll: (data.deletedForAll as boolean) ?? false,
        reports: (data.reports as object) ?? [],
        isForwarded: (data.isForwarded as boolean) ?? false,
        ...(data.forwardData
          ? { forwardData: data.forwardData as object }
          : {}),
      },
    });
  }

  async createSystemMessage(params: {
    roomId: string;
    systemMessageType: string;
    metadata: Record<string, unknown>;
    triggeredByUserId: string;
    triggeredByName: string;
    sequenceNumber: number;
    /** Room CHANGE revision for this insert (zero-loss changes feed). */
    revision?: number;
    fallbackText: string;
    /** When set, the message is PERSONAL: only this user sees it in history. */
    visibleToUserId?: string | null;
    /**
     * Deterministic idempotency key for the originating event, stored in the
     * (internal) `clientMessageId` column so a REDELIVERED `community.system_message`
     * event can't create a duplicate timeline line. Relies on the existing unique
     * partial index `{roomId, sentBy, clientMessageId}` (server.ts ensureIndex):
     * a second insert with the same key throws a duplicate-key error the caller
     * treats as an idempotent replay. Stripped from the wire for SYSTEM rows.
     * Omit for direct/local posts (pin/unpin) that aren't queue-redelivered.
     */
    clientMessageId?: string | null;
  }): Promise<GeneralRoomMessage> {
    return this.prisma.generalRoomMessage.create({
      data: {
        roomId: params.roomId,
        sentBy: params.triggeredByUserId,
        senderName: params.triggeredByName,
        senderAvatar: null,
        message: params.fallbackText,
        messageType: "SYSTEM",
        systemMessageType: params.systemMessageType,
        systemMetadata: params.metadata as Prisma.InputJsonValue,
        countInUnread: shouldCountInUnread({
          messageType: "SYSTEM",
          systemMessageType: params.systemMessageType,
        }),
        visibleToUserId: params.visibleToUserId ?? null,
        clientMessageId: params.clientMessageId ?? null,
        reactions: {},
        attachments: [],
        deletedBy: [],
        deletedForAll: false,
        reports: [],
        sequenceNumber: params.sequenceNumber,
        revision: params.revision ?? 0,
      },
    });
  }

  async findById(messageId: string): Promise<GeneralRoomMessage | null> {
    if (!/^[0-9a-f]{24}$/i.test(messageId)) return null;
    return this.prisma.generalRoomMessage.findUnique({
      where: { id: messageId },
    });
  }

  /**
   * The most recent still-visible PERSONAL MEMBER_MUTED line for one user in
   * one room, if any — the "You are muted until …" line from the CURRENT mute
   * session. Retracted (soft-deleted) when that session ends via unmute, so
   * the mute + unmute lines never stack together in the affected member's
   * history (Telegram parity: only the current state is shown).
   */
  async findLatestActiveMutedMessageId(params: {
    roomId: string;
    userId: string;
  }): Promise<string | null> {
    const row = await this.prisma.generalRoomMessage.findFirst({
      where: {
        roomId: params.roomId,
        visibleToUserId: params.userId,
        systemMessageType: "MEMBER_MUTED",
        deletedForAll: false,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return row?.id ?? null;
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

  /** All rows from one album send (base id + `base:N` siblings), seq-ordered. */
  async findAlbumBatchByClientMessageId(
    roomId: string,
    sentBy: string,
    baseClientMessageId: string
  ): Promise<GeneralRoomMessage[]> {
    return this.prisma.generalRoomMessage.findMany({
      where: {
        roomId,
        sentBy,
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

  async findByRoomIdWithTime(
    roomId: string,
    beforeTimestamp: string,
    _direction: string,
    limit: number,
    userId: string,
    viewerIsActiveMember = true,
    /** Upper bound for a BANNED viewer — see {@link timelineMatch}. */
    readCutoff?: Date | null
  ): Promise<GeneralRoomMessage[]> {
    // A banned viewer's window can never extend past their ban cutoff, even if
    // `beforeTimestamp` (the scroll cursor) is later.
    const upperBound =
      readCutoff && readCutoff < new Date(beforeTimestamp)
        ? new Date(readCutoff.getTime() + 1)
        : new Date(beforeTimestamp);
    // Prisma MongoDB doesn't support $nin on JSON arrays directly.
    // Fetch and filter in memory for deletedBy + personal visibility.
    const [messages, latestPersonalJoinMessageId] = await Promise.all([
      this.prisma.generalRoomMessage.findMany({
        where: {
          roomId,
          createdAt: { lt: upperBound },
          deletedForAll: false,
        },
        orderBy: { createdAt: "desc" },
        take: limit + 10,
      }),
      viewerIsActiveMember
        ? this.findLatestPersonalJoinMessageId(roomId, userId)
        : Promise.resolve(null),
    ]);

    // Filter out messages this user deleted-for-me + PERSONAL messages targeted
    // at someone else (in memory — see isVisibleToUser).
    return messages
      .filter((msg) => {
        const deletedBy = (msg.deletedBy ?? []) as string[];
        return (
          !deletedBy.includes(userId) &&
          isVisibleToUser(msg, userId, viewerIsActiveMember) &&
          isLatestPersonalJoinSessionForUser(
            msg,
            userId,
            latestPersonalJoinMessageId
          )
        );
      })
      .slice(0, limit);
  }

  /**
   * Shared `$match` for the community history timeline (and its count) — the
   * SINGLE source of truth so `findByRoomIdTimeline` and `countTimeline` filter
   * IDENTICALLY (otherwise `total` overstates what pagination can actually reach,
   * and infinite-scroll appears to "lose" messages). Mirrors `isVisibleToUser`
   * but expressed for Mongo so the filtering happens in the DB:
   *
   *  - `deletedForAll:false`        — tombstones never appear in history.
   *  - `deletedBy: { $ne }`         — messages this viewer deleted-for-me.
   *  - `visibleToUserId: $in[null,u]` — PERSONAL targeting; `$in:[null,…]` also
   *      matches field-absent docs natively (the reason the legacy findMany path
   *      had to filter in memory — Prisma's `{ field: null }` does NOT).
   *  - `systemMessageType: $nin HIDDEN` — high-churn lifecycle lines (joined/left)
   *      are hidden for everyone; `$nin` keeps field-absent regular messages.
   *  - `$nor` (only when the viewer is NOT an active member) — a left/non-member
   *      browsing PUBLIC history must not see their OWN prior-session join line.
   *
   * `roomId` is an ObjectId column, so it is matched as `{ $oid }`.
   */
  private timelineMatch(params: {
    roomId: string;
    userId: string;
    viewerIsActiveMember: boolean;
    latestPersonalJoinMessageId?: string | null;
    /**
     * Upper bound for a BANNED viewer: only messages created at/before their
     * ban timestamp are visible (Telegram parity — pre-ban history stays
     * readable, nothing newer ever is, including after unban/rejoin resync).
     */
    readCutoff?: Date | null;
  }): Record<string, unknown> {
    const match: Record<string, unknown> = {
      roomId: { $oid: params.roomId },
      deletedForAll: false,
      deletedBy: { $ne: params.userId },
      visibleToUserId: { $in: [null, params.userId] },
      systemMessageType: { $nin: [...HIDDEN_SYSTEM_MESSAGE_TYPES] },
    };
    const andClauses: Record<string, unknown>[] = [];
    if (!params.viewerIsActiveMember) {
      match.$nor = [
        {
          visibleToUserId: params.userId,
          systemMessageType: { $in: [...PERSONAL_JOIN_SESSION_TYPES] },
        },
      ];
    } else {
      andClauses.push(
        personalJoinSessionGuard(
          params.userId,
          params.latestPersonalJoinMessageId ?? null
        )
      );
    }
    if (params.readCutoff) {
      andClauses.push({
        createdAt: { $lte: { $date: params.readCutoff.toISOString() } },
      });
    }
    if (andClauses.length) match.$and = andClauses;
    return match;
  }

  /**
   * Keyset history page for community messages.
   *
   * Why this is an `aggregateRaw` keyset (not a `findMany` + in-memory filter):
   * the previous implementation over-fetched `limit + 1` rows and then removed
   * hidden/personal/deleted-for-me rows in memory. That made `hasMore` (derived
   * from the post-filter length) UNDERFLOW whenever a single hidden row landed in
   * the window — so infinite scroll terminated early and older messages became
   * unreachable. Doing ALL filtering in the DB means the page is exactly `limit`
   * visible rows and the `+1` over-fetch detects `hasMore` reliably.
   *
   * The cursor is a `(createdAt, _id)` keyset, NOT a bare timestamp. With a
   * millisecond-only cursor, messages sharing one millisecond get split across a
   * page boundary and silently skipped (or duplicated). The `_id` tiebreaker
   * gives a total order so every message is reachable exactly once.
   *
   *  - `direction="before"` → older page, newest-first; boundary is exclusive
   *    `createdAt < ts OR (createdAt == ts AND _id < boundaryId)`.
   *  - `direction="after"`  → newer page, oldest-first; boundary is the mirror.
   *  - No `boundaryId` → first page (or a coarse timestamp jump): `inclusive`
   *    picks `<=`/`>=` (initial newest page) vs `<`/`>` (legacy bare-ms cursor).
   */
  async findByRoomIdTimeline(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    ts: Date;
    /** ObjectId of the cursor row — the keyset tiebreaker for same-ms messages. */
    boundaryId?: string | null;
    /** Include rows whose createdAt == ts (first page); ignored when boundaryId set. */
    inclusive?: boolean;
    limit: number;
    viewerIsActiveMember?: boolean;
    /** Upper bound for a BANNED viewer — see {@link timelineMatch}. */
    readCutoff?: Date | null;
  }): Promise<{ messages: GeneralRoomMessage[]; hasMore: boolean }> {
    const before = params.direction === "before";
    const viewerIsActiveMember = params.viewerIsActiveMember ?? true;
    const latestPersonalJoinMessageId = viewerIsActiveMember
      ? await this.findLatestPersonalJoinMessageId(params.roomId, params.userId)
      : null;
    const base = this.timelineMatch({
      roomId: params.roomId,
      userId: params.userId,
      viewerIsActiveMember,
      latestPersonalJoinMessageId,
      readCutoff: params.readCutoff,
    });

    const date = { $date: params.ts.toISOString() };
    const match: Record<string, unknown> = { ...base };
    if (params.boundaryId) {
      // Exclusive keyset boundary with an `_id` tiebreaker.
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

    // Over-fetch ONE extra row: it both detects `hasMore` and lets us inspect the
    // dropped row's millisecond for the snap-to-ms guard below.
    const ordered = await this.runTimelinePage(match, sort, params.limit + 1);
    const hasMoreRaw = ordered.length > params.limit;
    let page = ordered.slice(0, params.limit);
    let hasMore = hasMoreRaw;

    // SNAP-TO-MILLISECOND — never end a page in the MIDDLE of a same-millisecond
    // cluster. Messages stamped in the same millisecond are ordered only by the
    // `_id` tiebreaker. If the boundary row shares its ms with the dropped next
    // row, the cluster straddles the page edge — and a client that paginates with
    // a BARE millisecond cursor (`before_ts=<ms>` instead of the compound
    // `<ms>_<id>` we hand back) skips the rest of that ms via the exclusive
    // `$lt`/`$gt`, silently losing messages. Trimming the trailing same-ms rows
    // makes EVERY page end on a clean ms boundary, so bare-ms and compound cursors
    // are both lossless. Compound clients are unaffected for correctness; they
    // just get a slightly smaller page next to a cluster. No extra query in this
    // common path — it's an in-memory trim.
    if (hasMoreRaw && page.length === params.limit) {
      const boundaryMs = page[page.length - 1]!.createdAt.getTime();
      const nextMs = ordered[params.limit]!.createdAt.getTime();
      if (boundaryMs === nextMs) {
        const trimmed = page.filter(
          (d) => d.createdAt.getTime() !== boundaryMs
        );
        if (trimmed.length > 0) {
          // The trimmed same-ms rows (and the dropped next row) are reachable on
          // the next page; the new boundary now sits on a strictly different ms.
          page = trimmed;
          hasMore = true;
        } else {
          // Degenerate: the WHOLE page is a single millisecond with yet more rows
          // at that ms. Trimming would empty the page and loop forever, so EXTEND
          // to the full cluster instead — a clean boundary at the cost of a larger
          // page (bounded by TIMELINE_CLUSTER_CAP).
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

  /** Max rows pulled when EXTENDING past a degenerate single-millisecond page
   *  (every row in the page shares one ms). A real chat never approaches this; the
   *  cap is a safety bound so a pathological burst can't load an unbounded page. */
  private readonly TIMELINE_CLUSTER_CAP = 5000;

  /**
   * Run one keyset page: aggregateRaw for the ordered ids, then re-fetch typed
   * docs and restore that exact order (aggregateRaw returns extended-JSON, not
   * Prisma entities). Shared by the main page and the same-ms extend query.
   */
  private async runTimelinePage(
    match: Record<string, unknown>,
    sort: Record<string, number>,
    limit: number
  ): Promise<GeneralRoomMessage[]> {
    const raw = (await this.prisma.generalRoomMessage.aggregateRaw({
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

    const docs = await this.prisma.generalRoomMessage.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(docs.map((d) => [d.id, d]));
    return ids
      .map((id) => byId.get(id))
      .filter((d): d is GeneralRoomMessage => Boolean(d));
  }

  /**
   * Fetch the rest of a same-millisecond cluster beyond `lastId` (used only by the
   * degenerate single-ms extend path). `before` walks older `_id`s; `after` walks
   * newer ones — same direction as the page so the appended rows keep order.
   */
  private async fetchSameMsBeyond(
    base: Record<string, unknown>,
    boundaryMs: number,
    lastId: string,
    before: boolean
  ): Promise<GeneralRoomMessage[]> {
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

  /**
   * Cheap existence probe: is there at least one history-visible row strictly
   * beyond `boundaryMs` (older for `before`, newer for `after`)? Used to set
   * `hasMore` after the extend path without a full page fetch.
   */
  private async existsBeyondMs(
    base: Record<string, unknown>,
    boundaryMs: number,
    before: boolean
  ): Promise<boolean> {
    const date = { $date: new Date(boundaryMs).toISOString() };
    const raw = (await this.prisma.generalRoomMessage.aggregateRaw({
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
   * Count of history-visible messages in a room for one viewer — the SAME filter
   * as `findByRoomIdTimeline` (minus the keyset boundary). Used so the timeline
   * response's `total` equals the number of messages pagination can actually
   * reach, instead of `countByRoom`'s raw total (which counts hidden/personal/
   * deleted-for-me rows the client will never receive).
   */
  async countTimeline(params: {
    roomId: string;
    userId: string;
    viewerIsActiveMember?: boolean;
    /** Upper bound for a BANNED viewer — see {@link timelineMatch}. */
    readCutoff?: Date | null;
  }): Promise<number> {
    const viewerIsActiveMember = params.viewerIsActiveMember ?? true;
    const latestPersonalJoinMessageId = viewerIsActiveMember
      ? await this.findLatestPersonalJoinMessageId(params.roomId, params.userId)
      : null;
    const result = (await this.prisma.generalRoomMessage.aggregateRaw({
      pipeline: [
        {
          $match: this.timelineMatch({
            roomId: params.roomId,
            userId: params.userId,
            viewerIsActiveMember,
            latestPersonalJoinMessageId,
            readCutoff: params.readCutoff,
          }),
        },
        { $count: "total" },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{ total: number }>;
    return result[0]?.total ?? 0;
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
    viewerIsActiveMember?: boolean;
    /** Upper bound for a BANNED viewer — see {@link timelineMatch}. */
    readCutoff?: Date | null;
  }): Promise<GeneralRoomMessage[]> {
    const half = Math.floor(params.limit / 2);
    const newerUpperBound =
      params.readCutoff && params.readCutoff < params.anchorDate
        ? params.readCutoff
        : null;

    const [older, newer, latestPersonalJoinMessageId] = await Promise.all([
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
      // strictly newer half — never past the ban cutoff for a banned viewer.
      newerUpperBound
        ? Promise.resolve([])
        : this.prisma.generalRoomMessage.findMany({
            where: {
              roomId: params.roomId,
              deletedForAll: false,
              createdAt: {
                gt: params.anchorDate,
                ...(params.readCutoff ? { lte: params.readCutoff } : {}),
              },
            },
            orderBy: { createdAt: "asc" },
            take: half,
          }),
      (params.viewerIsActiveMember ?? true)
        ? this.findLatestPersonalJoinMessageId(params.roomId, params.userId)
        : Promise.resolve(null),
    ]);

    return [...older.reverse(), ...newer].filter((msg) => {
      const deletedBy = (msg.deletedBy ?? []) as string[];
      return (
        !deletedBy.includes(params.userId) &&
        isVisibleToUser(
          msg,
          params.userId,
          params.viewerIsActiveMember ?? true
        ) &&
        isLatestPersonalJoinSessionForUser(
          msg,
          params.userId,
          latestPersonalJoinMessageId
        )
      );
    });
  }

  /**
   * V2 sequence keyset history page — the gap-safe counterpart to
   * `findByRoomIdTimeline`. `sequenceNumber` is a per-room MONOTONIC, UNIQUE
   * counter (`allocateSequence`), so — unlike the `(createdAt,_id)` timestamp
   * keyset — it needs no `_id` tiebreaker and no snap-to-millisecond cluster
   * handling: every message is reachable exactly once and pages can never split
   * a same-millisecond burst.
   *
   * Reuses the EXACT community visibility rules by building on `timelineMatch`
   * (deletedForAll / deletedBy / visibleToUserId / hidden-system / personal-join
   * / ban `readCutoff`) and executing through `runTimelinePage` (aggregateRaw →
   * typed re-fetch → order restore). Only the boundary + sort differ from the
   * timestamp path. NOTE: this deliberately does NOT copy the private/group
   * `findByRoomIdSeq` (a typed `findMany` with a `deletedFor`-map filter) — that
   * simpler filter would drop community's visibleToUserId / system-message /
   * personal-join rules.
   *
   *  - `direction="before"` → older page, newest-first; `sequenceNumber < seq`.
   *  - `direction="after"`  → newer page, oldest-first; `sequenceNumber > seq`.
   *  - `seq === null`       → first page (no lower bound), newest-first.
   *
   * Over-fetches ONE row to detect `hasMore` exactly (the DB does all filtering,
   * so the surviving count is authoritative — no early-termination underflow).
   */
  async findByRoomIdSeq(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    /** Exclusive boundary; null for the newest page (no lower bound). */
    seq: number | null;
    limit: number;
    viewerIsActiveMember?: boolean;
    /** Upper bound for a BANNED viewer — see {@link timelineMatch}. */
    readCutoff?: Date | null;
  }): Promise<{ messages: GeneralRoomMessage[]; hasMore: boolean }> {
    const before = params.direction === "before";
    const viewerIsActiveMember = params.viewerIsActiveMember ?? true;
    const latestPersonalJoinMessageId = viewerIsActiveMember
      ? await this.findLatestPersonalJoinMessageId(params.roomId, params.userId)
      : null;
    const match: Record<string, unknown> = this.timelineMatch({
      roomId: params.roomId,
      userId: params.userId,
      viewerIsActiveMember,
      latestPersonalJoinMessageId,
      readCutoff: params.readCutoff,
    });
    if (params.seq != null) {
      match.sequenceNumber = before ? { $lt: params.seq } : { $gt: params.seq };
    }

    const sort = before ? { sequenceNumber: -1 } : { sequenceNumber: 1 };
    const ordered = await this.runTimelinePage(match, sort, params.limit + 1);
    const hasMore = ordered.length > params.limit;
    return { messages: ordered.slice(0, params.limit), hasMore };
  }

  /**
   * V2 sequence jump-to-message window — the seq counterpart to
   * `findAroundDate`. Fetches ~half the limit on each side of the anchor's
   * `sequenceNumber`, anchor-inclusive on the newer side. Reuses `timelineMatch`
   * + `runTimelinePage`, so the anchor is correctly omitted when the viewer has
   * hidden it (deleted-for-me / personal-visibility) while the surrounding window
   * stays full-size. Returned oldest→newest for `computeSeqAroundCursors`.
   */
  async findAroundSeq(params: {
    roomId: string;
    userId: string;
    anchorSeq: number;
    limit: number;
    viewerIsActiveMember?: boolean;
    /** Upper bound for a BANNED viewer — see {@link timelineMatch}. */
    readCutoff?: Date | null;
  }): Promise<GeneralRoomMessage[]> {
    const half = Math.max(1, Math.floor(params.limit / 2));
    const viewerIsActiveMember = params.viewerIsActiveMember ?? true;
    const latestPersonalJoinMessageId = viewerIsActiveMember
      ? await this.findLatestPersonalJoinMessageId(params.roomId, params.userId)
      : null;
    const base = this.timelineMatch({
      roomId: params.roomId,
      userId: params.userId,
      viewerIsActiveMember,
      latestPersonalJoinMessageId,
      readCutoff: params.readCutoff,
    });
    const [before, anchorAndAfter] = await Promise.all([
      this.runTimelinePage(
        { ...base, sequenceNumber: { $lt: params.anchorSeq } },
        { sequenceNumber: -1 },
        half
      ),
      this.runTimelinePage(
        { ...base, sequenceNumber: { $gte: params.anchorSeq } },
        { sequenceNumber: 1 },
        half + 1
      ),
    ]);
    return [...before.reverse(), ...anchorAndAfter];
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
    latestPersonalJoinMessageId?: string | null;
  }): Prisma.InputJsonObject {
    return {
      roomId: { $oid: params.roomId },
      deletedForAll: false,
      createdAt: { $lt: { $date: new Date(params.beforeMs).toISOString() } },
      deletedBy: { $ne: params.userId },
      // PERSONAL message visibility: keep messages with no target OR targeted at
      // this user. Stored as null when absent, so $in must include null.
      visibleToUserId: { $in: [null, params.userId] },
      // Suppressed moderation lines (removed/banned/unbanned) are hidden from the
      // chat timeline for everyone. `$nin` also matches docs where the field is
      // absent (regular messages), so they pass through.
      systemMessageType: { $nin: [...HIDDEN_SYSTEM_MESSAGE_TYPES] },
      $and: [
        personalJoinSessionGuard(
          params.userId,
          params.latestPersonalJoinMessageId ?? null
        ),
      ] as Prisma.InputJsonValue,
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
    const latestPersonalJoinMessageId =
      await this.findLatestPersonalJoinMessageId(params.roomId, params.userId);
    const raw = (await this.prisma.generalRoomMessage.findRaw({
      filter: this.conversationMatch({
        ...params,
        latestPersonalJoinMessageId,
      }),
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
    const latestPersonalJoinMessageId =
      await this.findLatestPersonalJoinMessageId(params.roomId, params.userId);
    const result = (await this.prisma.generalRoomMessage.aggregateRaw({
      pipeline: [
        {
          $match: this.conversationMatch({
            ...params,
            latestPersonalJoinMessageId,
          }),
        },
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
            // Personal system messages (e.g. "You joined") are informational only.
            visibleToUserId: null,
            // No SYSTEM message (any systemMessageType at all) counts toward
            // unread — mirrors write-time shouldCountInUnread() and guards
            // legacy rows persisted before `countInUnread` existed.
            systemMessageType: { $in: [null] },
            ...UNREAD_COUNTABLE_RAW_MATCH,
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
            sentBy: { $ne: params.userId },
            // PERSONAL system messages (visibleToUserId != null) are informational
            // events (e.g. "You joined the community") and must never inflate unread.
            // Only community-wide messages (visibleToUserId === null) count.
            visibleToUserId: null,
            // No SYSTEM message (any systemMessageType at all) counts toward
            // unread — mirrors write-time shouldCountInUnread() and guards
            // legacy rows persisted before `countInUnread` existed.
            systemMessageType: { $in: [null] },
            ...UNREAD_COUNTABLE_RAW_MATCH,
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

  /**
   * Latest PERSONAL system line per room for one viewer — the newest message
   * targeted ONLY at this user (`visibleToUserId === userId`), e.g. "You joined
   * the community". Returns a Map keyed by room hex id. Used by getChatSummaries
   * so /communities/mine can show the joiner their own join line as lastActivity
   * while everyone else keeps the community-wide message. One aggregateRaw query
   * for all requested rooms (no N+1). `roomId` is an ObjectId column, matched via
   * `{ $oid }`; the grouped `_id` returns as `{ $oid: "<hex>" }`.
   */
  async findLatestPersonalByRooms(params: {
    userId: string;
    roomIds: string[];
  }): Promise<Map<string, { message: string; createdAt: Date }>> {
    if (!params.roomIds.length) return new Map();
    const oids = params.roomIds.map((id) => ({ $oid: id }));

    const result = (await this.prisma.generalRoomMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId: { $in: oids },
            deletedForAll: false,
            // Only rows targeted at THIS viewer (community rows have null and are
            // excluded — they're already covered by room.lastMessage).
            visibleToUserId: params.userId,
            deletedBy: { $ne: params.userId },
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$roomId",
            message: { $first: "$message" },
            createdAt: { $first: "$createdAt" },
          },
        },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{
      _id: { $oid?: string } | string;
      message?: string | null;
      createdAt?: { $date?: string | number } | string | number | null;
    }>;

    const map = new Map<string, { message: string; createdAt: Date }>();
    for (const row of result) {
      const hex = typeof row._id === "string" ? row._id : row._id?.$oid;
      if (!hex) continue;
      const rawDate = row.createdAt;
      const iso =
        rawDate && typeof rawDate === "object" && "$date" in rawDate
          ? rawDate.$date
          : (rawDate as string | number | undefined);
      const createdAt = iso != null ? new Date(iso) : new Date(0);
      map.set(hex, { message: row.message ?? "", createdAt });
    }
    return map;
  }

  /**
   * Membership-lifecycle cleanup (Telegram-style): hard-delete the user's
   * PERSONAL join-session onboarding lines ("You joined the community", "Your
   * request to join was approved") for one community, so they never accumulate
   * across join→leave→rejoin cycles. Invoked when a membership goes inactive
   * (left / removed / banned).
   *
   * `beforeOrAt` is the leave-event timestamp: only rows created at/BEFORE it are
   * purged, so a redelivered stale "left" event can never delete the FRESH join
   * line created by a subsequent rejoin (which is strictly newer). Omit to purge
   * all sessions (e.g. one-time backfill).
   *
   * Returns the deleted row ids (not just a count) so the caller can emit a
   * `community:message:deleted` event per id — an already-connected client that
   * rendered the prior join line before this cleanup ran has no other way to
   * learn it was removed; without this it stays on screen until the client
   * does a fresh fetch (reload/reconnect).
   */
  async deletePersonalJoinMessages(params: {
    roomId: string;
    userId: string;
    beforeOrAt?: Date;
    keepId?: string;
  }): Promise<string[]> {
    const where = {
      roomId: params.roomId,
      visibleToUserId: params.userId,
      systemMessageType: { in: [...PERSONAL_JOIN_SESSION_TYPES] },
      ...(params.beforeOrAt ? { createdAt: { lte: params.beforeOrAt } } : {}),
      ...(params.keepId ? { NOT: { id: params.keepId } } : {}),
    };
    const stale = await this.prisma.generalRoomMessage.findMany({
      where,
      select: { id: true },
    });
    if (stale.length === 0) return [];
    await this.prisma.generalRoomMessage.deleteMany({
      where: { id: { in: stale.map((m) => m.id) } },
    });
    return stale.map((m) => m.id);
  }

  async searchByText(
    roomId: string,
    query: string,
    limit: number,
    userId: string,
    viewerIsActiveMember = true,
    skip = 0,
    /** Upper bound for a BANNED viewer — see {@link timelineMatch}. */
    readCutoff?: Date | null
  ): Promise<GeneralRoomMessage[]> {
    // `message` is a top-level String field, so a case-insensitive `contains`
    // works directly. Per-user visibility (deletedBy/isVisibleToUser) can only
    // be applied in memory (see isVisibleToUser above), so we over-fetch a
    // window covering `skip + limit` plus a margin for filtered-out rows, then
    // slice the requested page out of the survivors — NOT `take: limit` alone,
    // which would silently drop every page beyond the first.
    const OVERFETCH_MARGIN = 10;
    const messages = await this.prisma.generalRoomMessage.findMany({
      where: {
        roomId,
        deletedForAll: false,
        message: { contains: query, mode: "insensitive" },
        ...(readCutoff ? { createdAt: { lte: readCutoff } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: skip + limit + OVERFETCH_MARGIN,
    });

    return messages
      .filter((msg) => {
        const deletedBy = (msg.deletedBy ?? []) as string[];
        return (
          !deletedBy.includes(userId) &&
          isVisibleToUser(msg, userId, viewerIsActiveMember)
        );
      })
      .slice(skip, skip + limit);
  }

  async countSearchResults(
    roomId: string,
    query: string,
    userId: string,
    viewerIsActiveMember = true,
    /** Upper bound for a BANNED viewer — see {@link timelineMatch}. */
    readCutoff?: Date | null
  ): Promise<number> {
    // Mirrors searchByText's per-user filter (deletedBy/isVisibleToUser) so the
    // reported total — and therefore totalPage/hasMore — matches what the user
    // actually sees, instead of a raw room-wide match count.
    const messages = await this.prisma.generalRoomMessage.findMany({
      where: {
        roomId,
        deletedForAll: false,
        message: { contains: query, mode: "insensitive" },
        ...(readCutoff ? { createdAt: { lte: readCutoff } } : {}),
      },
      select: {
        deletedBy: true,
        visibleToUserId: true,
        systemMessageType: true,
        systemMetadata: true,
        sentBy: true,
      },
    });
    return messages.filter((msg) => {
      const deletedBy = (msg.deletedBy ?? []) as string[];
      return (
        !deletedBy.includes(userId) &&
        isVisibleToUser(msg, userId, viewerIsActiveMember)
      );
    }).length;
  }

  async countByRoom(roomId: string): Promise<number> {
    return this.prisma.generalRoomMessage.count({
      where: { roomId, deletedForAll: false },
    });
  }

  /** Refresh `quoteData.preview`/`.isDeleted` on every reply to `parentMessageId`. */
  async refreshReplyQuotes(
    parentMessageId: string,
    patch: QuoteRefreshPatch
  ): Promise<void> {
    await refreshQuoteDataForParent(
      this.prisma,
      "general_room_messages",
      parentMessageId,
      patch
    );
  }

  async updateById(
    _roomId: string,
    messageId: string,
    reactions: Record<string, unknown[]>,
    /** Room CHANGE revision for this reaction mutation (zero-loss changes feed). */
    revision?: number
  ): Promise<GeneralRoomMessage | null> {
    return this.prisma.generalRoomMessage.update({
      where: { id: messageId },
      data: {
        reactions: reactions as unknown as Prisma.InputJsonValue,
        ...(revision != null ? { revision } : {}),
      },
    });
  }

  async deleteForUser(messageId: string, userId: string): Promise<void> {
    await this.prisma.$runCommandRaw({
      update: "general_room_messages",
      updates: [
        {
          q: { _id: { $oid: messageId } },
          u: { $addToSet: { deletedBy: userId } },
        },
      ],
    });
  }

  async deleteForAll(
    messageId: string,
    params?: {
      deletedType?: "SELF_DELETE" | "ADMIN_DELETE";
      deletedBy?: string;
      /** Room CHANGE revision for this tombstone (zero-loss changes feed). */
      revision?: number;
    }
  ): Promise<GeneralRoomMessage | null> {
    return this.prisma.generalRoomMessage.update({
      where: { id: messageId },
      data: {
        deletedForAll: true,
        // Audit fields only when the caller attributes the delete (user action);
        // system retraction (pin undo) passes only a revision.
        ...(params?.deletedType
          ? {
              deletedForAllType: params.deletedType,
              deletedForAllAt: new Date(),
              deletedForAllBy: params.deletedBy,
            }
          : {}),
        ...(params?.revision != null ? { revision: params.revision } : {}),
      },
    });
  }

  async editMessage(
    messageId: string,
    text: string,
    /** Room CHANGE revision for this edit (zero-loss changes feed). */
    revision?: number
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
        ...(revision != null ? { revision } : {}),
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
        return (
          !deletedBy.includes(params.userId) &&
          isVisibleToUser(msg, params.userId)
        );
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
      // PERSONAL message visibility — never surface another user's personal message.
      visibleToUserId: { $in: [null, params.userId] },
      // Suppressed moderation lines hidden from everyone ($nin keeps field-absent
      // regular messages).
      systemMessageType: { $nin: [...HIDDEN_SYSTEM_MESSAGE_TYPES] },
    };
    const latestPersonalJoinMessageId =
      await this.findLatestPersonalJoinMessageId(params.roomId, params.userId);
    matchStage.$and = [
      personalJoinSessionGuard(params.userId, latestPersonalJoinMessageId),
    ];
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
    viewerIsActiveMember?: boolean;
    /**
     * Upper bound for a BANNED viewer — a resync must never surface a message
     * CREATED after the ban, even if its `updatedAt` (a later reaction/edit by
     * someone else, or the ban's own mirrored membership row) falls after
     * `fromTs`. See {@link timelineMatch}.
     */
    readCutoff?: Date | null;
  }): Promise<{ messages: GeneralRoomMessage[]; hasMore: boolean }> {
    const [raw, latestPersonalJoinMessageId] = await Promise.all([
      this.prisma.generalRoomMessage.findMany({
        where: {
          roomId: params.roomId,
          updatedAt: { gte: params.fromTs },
          ...(params.readCutoff
            ? { createdAt: { lte: params.readCutoff } }
            : {}),
          // deletedForAll intentionally NOT filtered — tombstones must be
          // included so the client can reconcile deletes missed while offline.
        },
        // `sequenceNumber` is the secondary sort key so messages sharing the same
        // updatedAt millisecond have a deterministic, total order across sync pages.
        // NOTE: the boundary stays inclusive (`gte`) by design — clients de-dupe by
        // id and apply mutations idempotently; a hot message whose updatedAt keeps
        // advancing can still re-appear on the boundary (acceptable for sync).
        orderBy: [{ updatedAt: "asc" }, { sequenceNumber: "asc" }],
        take: params.limit + 1,
      }),
      (params.viewerIsActiveMember ?? true)
        ? this.findLatestPersonalJoinMessageId(params.roomId, params.userId)
        : Promise.resolve(null),
    ]);

    const hasMore = raw.length > params.limit;
    const messages = raw.slice(0, params.limit).filter((msg) => {
      // Per-user deletedBy + PERSONAL visibility filtered in memory.
      const deletedBy = (msg.deletedBy ?? []) as string[];
      return (
        !deletedBy.includes(params.userId) &&
        isVisibleToUser(
          msg,
          params.userId,
          params.viewerIsActiveMember ?? true
        ) &&
        isLatestPersonalJoinSessionForUser(
          msg,
          params.userId,
          latestPersonalJoinMessageId
        )
      );
    });

    return { messages, hasMore };
  }

  /**
   * ZERO-LOSS CHANGES FEED — the canonical mutation-aware catch-up query.
   *
   * Returns every message whose room CHANGE `revision > sinceRevision`, current
   * state, ordered `revision ASC`. Unlike the seq history / `after_seq` path
   * (inserts only, `sequenceNumber > X`), this returns an OLD message's current
   * state after an edit / reaction / delete-for-all, because a mutation bumps the
   * row's `revision` to the room's newest even though its `sequenceNumber` never
   * moves. This is what closes mutation-loss for an offline client.
   *
   * Like `findUpdatedAtSince`, tombstones (`deletedForAll=true`) are INCLUDED so a
   * delete replays; per-user `deletedBy` + PERSONAL visibility are filtered in
   * memory. Boundary is EXCLUSIVE (`> sinceRevision`) — revision is unique per
   * change so there's no same-value straddle. Over-fetches by 1 for an exact
   * `hasMore`.
   *
   * `nextRevision` is the MAX revision of the raw page (the +1 over-fetch row
   * excluded) — NOT the last visible row's. Advancing the client's cursor to it
   * is safe even when the boundary row was filtered out of `messages` (someone
   * else's personal line): revision is monotonic, so no visible change is skipped,
   * and a fully-filtered page still lets the client make progress. `null` when the
   * page is empty (caught up).
   */
  async findByRoomIdRevisionSince(params: {
    roomId: string;
    userId: string;
    sinceRevision: number;
    limit: number;
    viewerIsActiveMember?: boolean;
    /** Upper bound for a BANNED viewer — see {@link findUpdatedAtSince}. */
    readCutoff?: Date | null;
  }): Promise<{
    messages: GeneralRoomMessage[];
    hasMore: boolean;
    nextRevision: number | null;
  }> {
    const [raw, latestPersonalJoinMessageId] = await Promise.all([
      this.prisma.generalRoomMessage.findMany({
        where: {
          roomId: params.roomId,
          revision: { gt: params.sinceRevision },
          ...(params.readCutoff
            ? { createdAt: { lte: params.readCutoff } }
            : {}),
          // deletedForAll intentionally NOT filtered — tombstones must replay.
        },
        orderBy: { revision: "asc" },
        take: params.limit + 1,
      }),
      (params.viewerIsActiveMember ?? true)
        ? this.findLatestPersonalJoinMessageId(params.roomId, params.userId)
        : Promise.resolve(null),
    ]);

    const hasMore = raw.length > params.limit;
    const page = raw.slice(0, params.limit);
    const nextRevision = page.length ? page[page.length - 1]!.revision : null;

    const messages = page.filter((msg) => {
      const deletedBy = (msg.deletedBy ?? []) as string[];
      return (
        !deletedBy.includes(params.userId) &&
        isVisibleToUser(
          msg,
          params.userId,
          params.viewerIsActiveMember ?? true
        ) &&
        isLatestPersonalJoinSessionForUser(
          msg,
          params.userId,
          latestPersonalJoinMessageId
        )
      );
    });

    return { messages, hasMore, nextRevision };
  }

  /** Current room CHANGE high-water (`lastRevision`) — the client's new cursor. */
  async getRoomRevision(roomId: string): Promise<number> {
    const room = await this.prisma.generalRoom.findUnique({
      where: { id: roomId },
      select: { lastRevision: true },
    });
    return room?.lastRevision ?? 0;
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

  /**
   * Most recent community-wide visible message for list-preview recalculation
   * after a delete-for-everyone. Returns the newest message that is:
   *   - not deleted for all
   *   - community-wide (visibleToUserId is null / absent — personal system lines
   *     like "You joined" must never become the community list preview)
   *   - not a hidden lifecycle system type (joined/left etc.)
   *
   * Uses LIMIT 1 on a createdAt-desc sort for O(log n) performance via the
   * existing (roomId, createdAt) index.
   */
  /**
   * Given a list of message IDs (typically one per room from the lastMessageId
   * field), returns the subset that are hidden from userId — either globally
   * deleted or in that user's personal deletedBy array.
   * Single batch aggregateRaw; used in getChatSummaries to avoid N+1.
   */
  async filterHiddenByUser(
    messageIds: string[],
    userId: string
  ): Promise<Set<string>> {
    if (!messageIds.length) return new Set();
    const raw = (await this.prisma.generalRoomMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            _id: { $in: messageIds.map((id) => ({ $oid: id })) },
            $or: [{ deletedForAll: true }, { deletedBy: userId }],
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

  async findPreviousVisibleMessage(
    roomId: string
  ): Promise<GeneralRoomMessage | null> {
    const raw = (await this.prisma.generalRoomMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId: { $oid: roomId },
            deletedForAll: false,
            // Personal system messages must not become the community-wide preview.
            // $in:[null] also matches docs where the field is absent.
            visibleToUserId: { $in: [null] },
            // Hidden lifecycle lines (member joined/left) are never shown.
            systemMessageType: { $nin: [...HIDDEN_SYSTEM_MESSAGE_TYPES] },
          },
        },
        { $sort: { createdAt: -1 } },
        { $limit: 1 },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{ _id?: { $oid?: string } | string }>;

    if (!raw.length) return null;
    const id = typeof raw[0]._id === "string" ? raw[0]._id : raw[0]._id?.$oid;
    if (!id) return null;
    return this.prisma.generalRoomMessage.findUnique({ where: { id } });
  }

  /**
   * Most recent message visible to a specific community member — same criteria
   * as findPreviousVisibleMessage but also excludes messages the user has
   * hidden for themselves (userId appears in the deletedBy array).
   * Used to build a per-user conv:updated after delete-for-me on the last message.
   */
  async findPreviousVisibleForUser(
    roomId: string,
    userId: string
  ): Promise<GeneralRoomMessage | null> {
    const raw = (await this.prisma.generalRoomMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId: { $oid: roomId },
            deletedForAll: false,
            deletedBy: { $nin: [userId] },
            visibleToUserId: { $in: [null] },
            systemMessageType: { $nin: [...HIDDEN_SYSTEM_MESSAGE_TYPES] },
          },
        },
        { $sort: { createdAt: -1 } },
        { $limit: 1 },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{ _id?: { $oid?: string } | string }>;

    if (!raw.length) return null;
    const id = typeof raw[0]._id === "string" ? raw[0]._id : raw[0]._id?.$oid;
    if (!id) return null;
    return this.prisma.generalRoomMessage.findUnique({ where: { id } });
  }
}
