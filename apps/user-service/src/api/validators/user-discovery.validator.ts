import { z } from "zod";

export const searchUsersQuerySchema = z.object({
  section: z.enum(["friends", "others", "all"]).default("others"),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type SearchUsersQuery = z.infer<typeof searchUsersQuerySchema>;
