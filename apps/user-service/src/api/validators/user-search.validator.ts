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
  // "Other" is capped at 10 per page — search results, not a full directory.
  limit: z.coerce.number().int().min(1).max(10).default(10),
});
export type UnifiedSearchQuery = z.infer<typeof unifiedSearchQuerySchema>;
