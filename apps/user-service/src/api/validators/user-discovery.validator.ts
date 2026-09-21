import { z } from "zod";

export const searchUsersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(["friends", "others"]).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Add/invite pickers: keep everyone, flag rows already in the target via `isMember`. */
  groupRoomId: z.string().trim().min(1).max(100).optional(),
  communityId: z.string().trim().min(1).max(100).optional(),
});

export type SearchUsersQuery = z.infer<typeof searchUsersQuerySchema>;
