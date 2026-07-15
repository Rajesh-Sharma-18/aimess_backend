import type { GeneralRoomMessage } from "../generated/prisma/index.js";
import type { GeneralRoomMessageRepository } from "../repositories/general-room-message.repository.js";
import {
  computeDateAroundCursors,
  computeSeqAroundCursors,
  type AroundCursors,
} from "./around-cursors.js";

/**
 * Parsed pagination cursor for a room message timeline. This is the SINGLE axis
 * that differs between the V1 (timestamp) and V2 (sequence) community message
 * endpoints — everything else (visibility filtering, enrichment, serialization,
 * response envelope) is shared in the service core.
 *
 * Named `PaginationCursor` (not `HistoryCursor`) because the same shape is reused
 * across surfaces as they migrate to Cursor V2 (inbox / notifications / friends
 * add their own variants to this union later).
 *
 *  - `TIMESTAMP`: the V1 `(createdAt, _id)` keyset — `boundaryId` is the same-ms
 *    tiebreaker parsed from a compound `"<ms>_<id>"` cursor; `inclusive` selects
 *    the first page (newest, `<=`) vs a continuation (`<`).
 *  - `SEQUENCE`: the V2 monotonic `sequenceNumber` keyset — `seq === null` means
 *    "no lower bound", i.e. the newest page.
 */
export type PaginationCursor =
  | {
      strategy: "TIMESTAMP";
      ts: Date;
      boundaryId: string | null;
      inclusive: boolean;
    }
  | { strategy: "SEQUENCE"; seq: number | null };

/** Shared fetch context — the access-guard-derived facts every strategy needs. */
interface TimelineFetchContext {
  roomId: string;
  userId: string;
  direction: "before" | "after";
  limit: number;
  viewerIsActiveMember: boolean;
  readCutoff?: Date | null;
}

/** Around-window fetch context — the anchor is pre-resolved by the service core. */
interface AroundFetchContext {
  roomId: string;
  userId: string;
  anchor: GeneralRoomMessage;
  limit: number;
  viewerIsActiveMember: boolean;
  readCutoff?: Date | null;
}

/**
 * Pluggable pagination strategy for the shared community timeline service core.
 * One instance per request, closed over the repository + the request's parsed
 * cursor. `getTimelinePage` / `getAroundWindow` know nothing about timestamps or
 * sequences — they only call these three methods, so a new pagination strategy
 * is added by writing a new adapter (+ a case in {@link makeTimelineAdapter}),
 * never by editing the service.
 */
export interface TimelinePaginationAdapter {
  /** One keyset page in `direction`. Returns raw rows (DB order) + exact hasMore. */
  timeline(
    ctx: TimelineFetchContext
  ): Promise<{ messages: GeneralRoomMessage[]; hasMore: boolean }>;

  /**
   * Jump-to-message window centered on `anchor` + bidirectional continuation
   * cursors. Rows are returned oldest→newest.
   */
  around(
    ctx: AroundFetchContext
  ): Promise<{ rows: GeneralRoomMessage[]; cursors: AroundCursors }>;

  /** Stringify the `nextCursor` from the boundary (last DB-order) row of a page. */
  nextCursor(boundaryRow: GeneralRoomMessage): string;
}

/** V1 `(createdAt, _id)` timestamp keyset — reproduces the existing repo calls. */
class TimestampTimelineAdapter implements TimelinePaginationAdapter {
  constructor(
    private readonly repo: GeneralRoomMessageRepository,
    private readonly cursor: Extract<
      PaginationCursor,
      { strategy: "TIMESTAMP" }
    >
  ) {}

  timeline(ctx: TimelineFetchContext) {
    return this.repo.findByRoomIdTimeline({
      roomId: ctx.roomId,
      userId: ctx.userId,
      direction: ctx.direction,
      ts: this.cursor.ts,
      boundaryId: this.cursor.boundaryId,
      inclusive: this.cursor.inclusive,
      limit: ctx.limit,
      viewerIsActiveMember: ctx.viewerIsActiveMember,
      readCutoff: ctx.readCutoff,
    });
  }

  async around(ctx: AroundFetchContext) {
    const rows = await this.repo.findAroundDate({
      roomId: ctx.roomId,
      userId: ctx.userId,
      anchorDate: ctx.anchor.createdAt,
      limit: ctx.limit,
      viewerIsActiveMember: ctx.viewerIsActiveMember,
      readCutoff: ctx.readCutoff,
    });
    // Probe one visible row strictly beyond each window edge (reuse the keyset
    // history query so the exact same visibility/ban filter applies).
    const cursors = await computeDateAroundCursors(rows, (direction, ts, id) =>
      this.repo
        .findByRoomIdTimeline({
          roomId: ctx.roomId,
          userId: ctx.userId,
          direction,
          ts,
          boundaryId: id,
          inclusive: false,
          limit: 1,
          viewerIsActiveMember: ctx.viewerIsActiveMember,
          readCutoff: ctx.readCutoff,
        })
        .then((r) => r.messages)
    );
    return { rows, cursors };
  }

  nextCursor(boundaryRow: GeneralRoomMessage): string {
    return `${boundaryRow.createdAt.getTime()}_${boundaryRow.id}`;
  }
}

/** V2 monotonic `sequenceNumber` keyset — gap-safe, no same-ms tiebreaker needed. */
class SequenceTimelineAdapter implements TimelinePaginationAdapter {
  constructor(
    private readonly repo: GeneralRoomMessageRepository,
    private readonly cursor: Extract<PaginationCursor, { strategy: "SEQUENCE" }>
  ) {}

  timeline(ctx: TimelineFetchContext) {
    return this.repo.findByRoomIdSeq({
      roomId: ctx.roomId,
      userId: ctx.userId,
      direction: ctx.direction,
      seq: this.cursor.seq,
      limit: ctx.limit,
      viewerIsActiveMember: ctx.viewerIsActiveMember,
      readCutoff: ctx.readCutoff,
    });
  }

  async around(ctx: AroundFetchContext) {
    const rows = await this.repo.findAroundSeq({
      roomId: ctx.roomId,
      userId: ctx.userId,
      anchorSeq: ctx.anchor.sequenceNumber,
      limit: ctx.limit,
      viewerIsActiveMember: ctx.viewerIsActiveMember,
      readCutoff: ctx.readCutoff,
    });
    const cursors = await computeSeqAroundCursors(rows, (direction, seq) =>
      this.repo
        .findByRoomIdSeq({
          roomId: ctx.roomId,
          userId: ctx.userId,
          direction,
          seq,
          limit: 1,
          viewerIsActiveMember: ctx.viewerIsActiveMember,
          readCutoff: ctx.readCutoff,
        })
        .then((r) => r.messages)
    );
    return { rows, cursors };
  }

  nextCursor(boundaryRow: GeneralRoomMessage): string {
    return String(boundaryRow.sequenceNumber);
  }
}

/**
 * Build the pagination adapter for a parsed cursor. This is the ONLY place that
 * switches on strategy — the service core stays closed for modification.
 */
export function makeTimelineAdapter(
  repo: GeneralRoomMessageRepository,
  cursor: PaginationCursor
): TimelinePaginationAdapter {
  switch (cursor.strategy) {
    case "TIMESTAMP":
      return new TimestampTimelineAdapter(repo, cursor);
    case "SEQUENCE":
      return new SequenceTimelineAdapter(repo, cursor);
  }
}
