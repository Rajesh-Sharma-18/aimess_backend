/**
 * Shared cursor-pagination slicing for repository rows fetched with the
 * `take: limit + 1` convention. Given the over-fetched rows, returns the page
 * (capped at `limit`) and the `nextCursor` (the last row's `id`, or null when
 * there are no more rows).
 */
export function paginateByCursor<T extends { id: string }>(
  rows: T[],
  limit: number
): { page: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;
  return { page, nextCursor };
}
