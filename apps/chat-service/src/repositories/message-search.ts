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

export function buildTextSearchPipeline(params: {
  match: Record<string, unknown>;
  query: string;
  cursor: SearchKeyset | null;
  limit: number;
}): Record<string, unknown>[] {
  const keyset = keysetFilter(params.cursor);
  const match: Record<string, unknown> = {
    ...params.match,
    $text: { $search: params.query },
  };
  const pipeline: Record<string, unknown>[] = [{ $match: match }];
  if (Object.keys(keyset).length > 0) pipeline.push({ $match: keyset });
  pipeline.push(
    { $addFields: { score: { $meta: "textScore" } } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: params.limit + 1 },
    { $project: { _id: 1, createdAt: 1, score: 1 } }
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

export function isTextIndexMissing(error: unknown): boolean {
  const message =
    error && typeof error === "object"
      ? ((error as { meta?: { message?: unknown } }).meta?.message ??
        (error instanceof Error ? error.message : ""))
      : "";
  return /text index required|no text index/i.test(String(message));
}
