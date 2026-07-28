export interface CursorPaginationParams {
  cursor?: string | null;
  limit: number;
}

export interface CursorPaginationResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PaginatedResponse<T> {
  pagination: {
    totalData: number;
    totalPage: number;
    currentPage: number;
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
  data: T[];
  /** Top-level shortcut — same value as pagination.hasMore. */
  hasMore: boolean;
  /** Top-level shortcut — same value as pagination.nextCursor. */
  nextCursor: string | null;
}

/**
 * V2 envelope. Two shapes, chosen by what the endpoint IS — the V1
 * `PaginatedResponse` forced offset semantics (`totalPage`, `currentPage`) onto
 * keyset endpoints that have no such concept, then bolted the real continuation
 * signals on beside them.
 *
 * Rules, for both shapes:
 *  - the collection is `items`, never `data` (a controller nesting a `data` key
 *    under the response's own `data` is what produced `data.data`);
 *  - continuation lives in `page` and NOWHERE else — no top-level shortcuts, so
 *    there is exactly one copy of every signal;
 *  - no `totalData`/`totalPage`/`currentPage`. They cost a `count()` per page and
 *    describe paging this API does not do.
 */
export interface TimelinePage {
  limit: number;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  /** Feed back verbatim as `before_seq`. Null = no older page. */
  olderSeq: number | null;
  /** Feed back verbatim as `after_seq`. Null = caller is at the live edge. */
  newerSeq: number | null;
}

export interface TimelineResponseV2<T> {
  items: T[];
  page: TimelinePage;
}

/**
 * A message page. Both directions ride EVERY page (ordinary and `around` alike),
 * so the client has one shape and no branch. Boundaries are sequence NUMBERS —
 * the axis the endpoint actually pages on — not stringly-typed "cursors".
 */
export function buildTimelinePageV2<T>(
  items: T[],
  limit: number,
  cursors: {
    hasMoreOlder: boolean;
    hasMoreNewer: boolean;
    olderCursor: string | number | null;
    newerCursor: string | number | null;
  }
): TimelineResponseV2<T> {
  return {
    items,
    page: {
      limit,
      hasMoreOlder: cursors.hasMoreOlder,
      hasMoreNewer: cursors.hasMoreNewer,
      olderSeq: toSeq(cursors.olderCursor),
      newerSeq: toSeq(cursors.newerCursor),
    },
  };
}

export interface ListPage {
  limit: number;
  hasMore: boolean;
  /** Opaque `<ms>_<id>` keyset token. Echo back verbatim; never parse it. */
  nextCursor: string | null;
}

export interface ListResponseV2<T> {
  items: T[];
  page: ListPage;
  /** Only where a UI renders a count — it costs a full `count()`. */
  totalCount?: number;
}

/**
 * A list page (inbox, members, notifications). Lists are NOT timelines: they have
 * no sequence axis, so they keep a genuine time-keyset cursor — honestly named.
 */
export function buildListPageV2<T>(
  items: T[],
  limit: number,
  hasMore: boolean,
  nextCursor: string | null,
  totalCount?: number
): ListResponseV2<T> {
  const out: ListResponseV2<T> = {
    items,
    page: { limit, hasMore, nextCursor },
  };
  if (totalCount != null) out.totalCount = totalCount;
  return out;
}

/** Sequence boundaries cross the wire as numbers. Unparseable/absent → null. */
function toSeq(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function buildPaginatedResponse<T extends Record<string, unknown>>(
  items: T[],
  totalCount: number,
  page: number,
  limit: number,
  cursorField: string
): PaginatedResponse<T> {
  const hasMore = items.length === limit;
  const lastItem = items[items.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? String(
          lastItem[cursorField] instanceof Date
            ? (lastItem[cursorField] as Date).toISOString()
            : lastItem[cursorField]
        )
      : null;
  const totalPage = Math.ceil(totalCount / limit) || 1;

  return {
    pagination: {
      totalData: totalCount,
      totalPage,
      currentPage: page,
      limit,
      nextCursor,
      hasMore,
    },
    data: items,
    hasMore,
    nextCursor,
  };
}

export function buildListResponse<T>(
  items: T[],
  totalCount: number,
  page: number,
  limit: number
): PaginatedResponse<T> {
  const totalPage = Math.ceil(totalCount / limit) || 1;
  const hasMore = items.length === limit;

  return {
    pagination: {
      totalData: totalCount,
      totalPage,
      currentPage: page,
      limit,
      nextCursor: null,
      hasMore,
    },
    data: items,
    hasMore,
    nextCursor: null,
  };
}

/**
 * Build a response for the timestamp-paginated message endpoints. Keeps the
 * same outer shape as `buildPaginatedResponse` (so the client contract is
 * stable) but takes a pre-computed `hasMore` and an epoch-ms `nextCursor`
 * (the boundary createdAt to feed back as the next before_ts/after_ts).
 * `currentPage`/`totalPage` are not meaningful for cursor paging and are
 * reported as best-effort from `totalCount`.
 */
export function buildTimelineResponse<T>(
  items: T[],
  totalCount: number,
  limit: number,
  hasMore: boolean,
  nextCursor: string | null
): PaginatedResponse<T> {
  return {
    pagination: {
      totalData: totalCount,
      totalPage: Math.ceil(totalCount / limit) || 1,
      currentPage: 1,
      limit,
      nextCursor,
      hasMore,
    },
    data: items,
    hasMore,
    nextCursor,
  };
}

/**
 * Extend a jump-to-message (`?around=`) page with bidirectional continuation
 * signals. Additive over `buildTimelineResponse`: the existing single-direction
 * `hasMore`/`nextCursor` are mapped to the OLDER direction (default scroll-up)
 * so pre-existing single-direction clients still page up, while new clients read
 * `hasMoreOlder`/`hasMoreNewer`/`olderCursor`/`newerCursor` to page BOTH ways
 * from the anchor. See {@link AroundCursors}.
 */
export function buildAroundResponse<T>(
  items: T[],
  totalCount: number,
  limit: number,
  cursors: {
    hasMoreOlder: boolean;
    hasMoreNewer: boolean;
    olderCursor: string | null;
    newerCursor: string | null;
  }
): PaginatedResponse<T> & typeof cursors {
  const base = buildTimelineResponse(
    items,
    totalCount,
    limit,
    cursors.hasMoreOlder,
    cursors.olderCursor
  );
  return { ...base, ...cursors };
}

/**
 * Parse a timestamp pagination cursor (`before_ts` / `after_ts`). The wire value
 * is EITHER a plain epoch-ms ("1782133107521") OR the opaque COMPOUND keyset
 * cursor "<ms>_<objectId>" handed back as `nextCursor`. Returns the millisecond
 * boundary plus the optional `_id` tiebreaker (the tiebreaker is what keeps
 * messages sharing one millisecond reachable instead of skipped at a page edge).
 * Returns `null` when the param is absent/empty. Assumes the value already passed
 * the `/^\d+(_[a-fA-F0-9]{24})?$/` Zod validator.
 */
export function parseTsCursor(
  raw: unknown
): { ms: number; id: string | null } | null {
  if (raw == null) return null;
  const s = String(raw);
  if (s === "") return null;
  const sep = s.indexOf("_");
  const msPart = sep === -1 ? s : s.slice(0, sep);
  const idPart = sep === -1 ? "" : s.slice(sep + 1);
  return { ms: Number(msPart), id: idPart || null };
}

/**
 * Prisma `where` fragment for the inbox's `(lastMessageAt, roomId)` keyset —
 * the SINGLE axis that differs between the V1 inbox (inclusive bare-timestamp
 * bound) and the V2 inbox (exclusive compound cursor). Shared by the private-room
 * and group-room repositories so both sides of the merge apply an identical
 * boundary; both already `orderBy: [lastMessageAt, roomId]`.
 *
 * - `inclusive` (V1 default): `lastMessageAt <= ts` / `>= ts`, no tiebreaker.
 * - exclusive, no `boundaryId` (V2 bare-ms coarse jump): `< ts` / `> ts`.
 * - exclusive with `boundaryId` (V2 compound cursor): strict compound keyset, so
 *   same-millisecond rows are returned exactly once across pages.
 */
export function buildRoomKeysetWhere(params: {
  direction: "before" | "after";
  ts: Date;
  boundaryId?: string | null;
  inclusive?: boolean;
}): Record<string, unknown> {
  const { direction, ts, boundaryId = null, inclusive = true } = params;
  const before = direction === "before";

  if (inclusive) {
    return {
      lastMessageAt: before ? { lte: ts, not: null } : { gte: ts, not: null },
    };
  }
  const op = before ? "lt" : "gt";
  if (!boundaryId) {
    return { lastMessageAt: { [op]: ts, not: null } };
  }
  return {
    lastMessageAt: { not: null },
    OR: [
      { lastMessageAt: { [op]: ts } },
      { lastMessageAt: ts, roomId: { [op]: boundaryId } },
    ],
  };
}

/**
 * Build a cursor-based pagination filter for Mongoose queries.
 * Uses date-based cursors (ISO string of lastMessageAt or createdAt).
 */
export function buildCursorFilter(
  field: string,
  cursor?: string | null
): Record<string, unknown> {
  if (!cursor) return {};
  return { [field]: { $lt: new Date(cursor) } };
}

/**
 * Build paginated response from query results.
 * Expects results to be sorted descending by the cursor field.
 */
export function buildCursorResponse<T extends Record<string, unknown>>(
  items: T[],
  limit: number,
  cursorField: string
): CursorPaginationResult<T> {
  const hasMore = items.length === limit;
  const lastItem = items[items.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? String(
          lastItem[cursorField] instanceof Date
            ? (lastItem[cursorField] as Date).toISOString()
            : lastItem[cursorField]
        )
      : null;

  return { items, nextCursor, hasMore };
}
