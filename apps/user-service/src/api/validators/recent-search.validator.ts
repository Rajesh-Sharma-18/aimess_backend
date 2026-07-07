import { z } from "zod";

export const recordRecentSearchSchema = z
  .object({
    searchedUserId: z.string().uuid().optional(),
    query: z.string().trim().min(1).max(100).optional(),
  })
  .refine((d) => d.searchedUserId !== undefined || d.query !== undefined, {
    message: "Provide either searchedUserId or query",
  });

export type RecordRecentSearchBody = z.infer<typeof recordRecentSearchSchema>;
