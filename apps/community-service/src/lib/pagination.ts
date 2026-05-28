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
