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
  };
}

export function buildListResponse<T>(
  items: T[],
  totalCount: number,
  page: number,
  limit: number
): PaginatedResponse<T> {
  const totalPage = Math.ceil(totalCount / limit) || 1;

  return {
    pagination: {
      totalData: totalCount,
      totalPage,
      currentPage: page,
      limit,
      nextCursor: null,
      hasMore: items.length === limit,
    },
    data: items,
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
