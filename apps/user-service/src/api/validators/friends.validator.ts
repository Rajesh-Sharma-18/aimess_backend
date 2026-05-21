import { z } from "zod";

export const listFriendsQuerySchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().trim().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(30),
});

export type ListFriendsQuery = z.infer<typeof listFriendsQuerySchema>;
