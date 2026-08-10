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

export function parseSearchCursor(raw?: string | null): SearchKeyset | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  const sep = value.indexOf("_");
  const msPart = sep === -1 ? value : value.slice(0, sep);
  const idPart = sep === -1 ? "" : value.slice(sep + 1);
  const createdAt = Number(msPart);
  if (!Number.isFinite(createdAt) || createdAt < 0) return null;
  return { createdAt, id: idPart };
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
 * The usual objection to regex here — "no index can serve it" — does not hold
 * for these queries. Every one of them pins `roomId` to a single room, and the
 * `[roomId, createdAt desc]` compound index serves both that equality and the
 * sort. Mongo therefore walks one room's messages in output order and stops at
 * `limit + 1` matches, so a common term early-exits almost immediately; only a
 * zero-match query walks the whole room. The caller debounces, and `$limit`
 * caps the work either way.
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
