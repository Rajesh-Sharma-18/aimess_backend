import { z } from "zod";

export const recordRecentUserSearchSchema = z.object({
  targetType: z.enum(["USER", "GROUP"]),
  targetId: z.string().trim().min(1).max(64),
});
export type RecordRecentUserSearchBody = z.infer<
  typeof recordRecentUserSearchSchema
>;

export const unifiedSearchQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  // "Other" is capped at 10 per page — search results, not a full directory.
  limit: z.coerce.number().int().min(1).max(10).default(10),
});
export type UnifiedSearchQuery = z.infer<typeof unifiedSearchQuerySchema>;
