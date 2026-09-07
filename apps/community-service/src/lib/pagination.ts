/**
 * Offset/page-based pagination response envelope shared by the community-service
 * list endpoints. Clients send `page` + `limit`; the response carries the full
 * page metadata (total count, total pages, current page) plus the rows.
 *
 * `nextCursor` is retained in the shape for forward-compatibility but is always
 * null for offset pagination.
 */
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

// Same envelope for keyset/cursor pages, where no count query is run: `nextCursor`/`hasMore` are the real continuation signals and `totalData`/`totalPage`/`currentPage` describe THIS page only — never page on them here.
export function buildCursorPaginatedResponse<T>(
  data: T[],
  limit: number,
  nextCursor: string | null
): PaginatedResponse<T> {
  return {
    pagination: {
      totalData: data.length,
      totalPage: 1,
      currentPage: 1,
      limit,
      nextCursor,
      hasMore: nextCursor !== null,
    },
    data,
  };
}

/** Build the standard paginated envelope from a page of rows + the total count. */
export function buildPaginatedResponse<T>(
  data: T[],
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
      hasMore: page < totalPage,
    },
    data,
  };
}
