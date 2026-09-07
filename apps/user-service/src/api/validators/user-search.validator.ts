import { z } from "zod";

export const recordRecentUserSearchSchema = z.object({
  targetType: z.enum(["USER", "GROUP"]),
  targetId: z.string().trim().min(1).max(64),
});
export type RecordRecentUserSearchBody = z.infer<
  typeof recordRecentUserSearchSchema
>;

export const removeRecentUserSearchParamsSchema = z.object({
  targetId: z.string().trim().min(1).max(64),
});
export type RemoveRecentUserSearchParams = z.infer<
  typeof removeRecentUserSearchParamsSchema
>;

export const removeRecentUserSearchQuerySchema = z.object({
  targetType: z.enum(["USER", "GROUP"]).default("USER"),
});
export type RemoveRecentUserSearchQuery = z.infer<
  typeof removeRecentUserSearchQuerySchema
>;

export const unifiedSearchQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  // Opaque people keyset — see `encodePeopleCursor`. Supersedes `page` when
  // present, and marks the request as a continuation: the bounded heads
  // (`chat`, and the group half of `other`) are omitted from those pages.
  cursor: z.string().trim().min(1).max(512).optional(),
  // "Other" is capped per page — search results, not a full directory. The
  // default stays 10 so existing callers keep their page size; the ceiling is
  // 50 because the unified /search gateway pages people 20-50 at a time.
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type UnifiedSearchQuery = z.infer<typeof unifiedSearchQuerySchema>;
