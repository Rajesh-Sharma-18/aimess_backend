import { z } from "zod";

export const searchUsersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(["friends", "others"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type SearchUsersQuery = z.infer<typeof searchUsersQuerySchema>;
