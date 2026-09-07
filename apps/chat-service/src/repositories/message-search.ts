export interface SearchKeyset {
  createdAt: number;
  id: string;
}

export interface TextSearchPage {
  ids: string[];
  scores: Map<string, number>;
  hasMore: boolean;
  nextCursor: string | null;
}

interface RawSearchDoc {
  _id?: { $oid?: string } | string;
  createdAt?: { $date?: string | number } | string | number;
  score?: number;
}

// ponytail: newest 80 rooms per user feed the cross-room search `$in`. The number is
// set by Mongo's explode-for-sort ceiling, NOT by `$in` size: the planner refuses to
// explode a scan into more than `internalQueryMaxScansToExplode` (default 200) index
// intervals, and from page 2 on the keyset adds a two-branch `$or`, so the budget is
// rooms x 2 <= 200. Over it, explosion is refused and the sort goes BLOCKING with no
// early termination — and `aggregate` runs allowDiskUse:false, so a large enough sort
// input fails with QueryExceededMemoryLimitNoDiskUseAllowed instead of returning.
// Ceiling: a heavier account searches only its 80 most recently active rooms. Upgrade
// path is paging the scope (cursor over rooms) or a server-side view spanning the
// three collections — raising this number is what breaks the explode.
export const SEARCH_SCOPE_ROOM_LIMIT = 80;

// Both halves are validated here, not just the epoch: the id half is fed straight
// into `_id: { $lt: { $oid } }` inside aggregateRaw, so a non-ObjectId (an inbox
// cursor "<ms>_prv_abc", which matches the same shape) throws in the BSON layer as
// an unhandled 500. An empty ms half is rejected too — Number("") is 0, not NaN.
export function parseSearchCursor(raw?: string | null): SearchKeyset | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  const sep = value.indexOf("_");
  const msPart = sep === -1 ? value : value.slice(0, sep);
  const idPart = sep === -1 ? "" : value.slice(sep + 1);
  if (!/^\d+$/.test(msPart)) return null;
  if (idPart && !/^[a-f0-9]{24}$/i.test(idPart)) return null;
  const createdAt = Number(msPart);
  // Past the Date range keysetFilter's toISOString() would throw on (also catches
  // the Infinity a 400-digit cursor parses to).
  if (createdAt > 8.64e15) return null;
  return { createdAt, id: idPart };
}

// Picks the continuation for a page merged from several collections, each of which
// stopped at its own floor. The NEWEST floor is the only safe one: a leg that
// stopped shallower still has unscanned rows above every deeper floor.
export function newestSearchCursor(
  cursors: Array<string | null | undefined>
): string | null {
  let best: string | null = null;
  let bestKey: SearchKeyset | null = null;
  for (const raw of cursors) {
    const key = parseSearchCursor(raw);
    if (!key) continue;
    const newer =
      !bestKey ||
      key.createdAt > bestKey.createdAt ||
      (key.createdAt === bestKey.createdAt && key.id > bestKey.id);
    if (!newer) continue;
    best = raw ?? null;
    bestKey = key;
  }
  return best;
}

export function buildSearchCursor(createdAt: Date, id: string): string {
  return `${createdAt.getTime()}_${id}`;
}

export function docObjectId(doc: RawSearchDoc): string | null {
  const raw = doc._id;
  if (typeof raw === "string") return raw;
  return raw?.$oid ?? null;
}

export function docCreatedAtMs(doc: RawSearchDoc): number {
  const raw = doc.createdAt;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Date.parse(raw);
  const inner = raw?.$date;
  if (typeof inner === "number") return inner;
  if (typeof inner === "string") return Date.parse(inner);
  return 0;
}

export function keysetFilter(
  cursor: SearchKeyset | null
): Record<string, unknown> {
  if (!cursor) return {};
  const boundary = { $date: new Date(cursor.createdAt).toISOString() };
  if (!cursor.id) return { createdAt: { $lt: boundary } };
  return {
    $or: [
      { createdAt: { $lt: boundary } },
      {
        createdAt: { $eq: boundary },
        _id: { $lt: { $oid: cursor.id } },
      },
    ],
  };
}

/** Escapes every regex metacharacter so a query like `c++ (v2)` is matched
 *  literally instead of blowing up as an invalid pattern. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the message-search page pipeline: a case-insensitive SUBSTRING match
 * on `field`, newest-first with an `_id` tiebreaker, bounded by a keyset cursor
 * and a top-k `$limit`.
 *
 * Substring, not `$text`. The Mongo text indexes are built with
 * `defaultLanguage: "none"` (multi-locale product — no stemmer is correct for
 * every room), so `$text` matched whole tokens only: "test" missed "Testing"
 * and no prefix query ever matched while the user was still typing.
 *
 * No index serves the `$regex` itself — it is always a post-fetch filter. What
 * an index buys is OUTPUT ORDER, so the scan can stop at `limit + 1` matches.
 * Two callers, two very different bills:
 *
 * - PER-ROOM (in-chat search): `roomId` is pinned to one room, and
 *   `[roomId, isDeleted, createdAt desc, _id desc]` serves both that equality
 *   and the sort. A common term early-exits almost immediately; the worst case
 *   is a zero-match term, which walks that one room.
 * - CROSS-ROOM (whole-account search): `roomId` is `{ $in: [...] }` over up to
 *   SEARCH_SCOPE_ROOM_LIMIT rooms (message-search.repository.ts). A term with
 *   matches still early-exits, but a zero-match term reads EVERY live
 *   non-system message in ALL of those rooms, across all three collections, on
 *   every debounced keystroke. That is the real ceiling, and the reason the room
 *   scope is capped — see SEARCH_SCOPE_ROOM_LIMIT.
 *
 * The caller debounces, and `$limit` caps the rows returned either way.
 *
 * Relevance scoring goes away with `$text` ($meta: "textScore" needs it). It
 * was never load-bearing: results have always been ordered by `createdAt`, and
 * the score rode along only as a passthrough field.
 */
export function buildTextSearchPipeline(params: {
  match: Record<string, unknown>;
  field: string;
  query: string;
  cursor: SearchKeyset | null;
  limit: number;
}): Record<string, unknown>[] {
  const keyset = keysetFilter(params.cursor);
  const match: Record<string, unknown> = {
    ...params.match,
    [params.field]: { $regex: escapeRegex(params.query), $options: "i" },
  };
  // Kept as a separate stage rather than merged: `match` may already carry its
  // own `createdAt` bound (a deletion/ban cutoff) that a merged object would
  // silently overwrite. Mongo coalesces adjacent $match stages anyway.
  const pipeline: Record<string, unknown>[] = [{ $match: match }];
  if (Object.keys(keyset).length > 0) pipeline.push({ $match: keyset });
  pipeline.push(
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: params.limit + 1 },
    { $project: { _id: 1, createdAt: 1 } }
  );
  return pipeline;
}

export function readTextSearchPage(
  rows: RawSearchDoc[],
  limit: number
): TextSearchPage {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ids: string[] = [];
  const scores = new Map<string, number>();
  for (const doc of page) {
    const id = docObjectId(doc);
    if (!id) continue;
    ids.push(id);
    if (typeof doc.score === "number") scores.set(id, doc.score);
  }
  const last = page[page.length - 1];
  const lastId = last ? docObjectId(last) : null;
  const nextCursor =
    hasMore && last && lastId ? `${docCreatedAtMs(last)}_${lastId}` : null;
  return { ids, scores, hasMore, nextCursor };
}

export function orderByIds<T extends { id: string }>(
  rows: T[],
  ids: string[]
): T[] {
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows
    .filter((row) => order.has(row.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}
