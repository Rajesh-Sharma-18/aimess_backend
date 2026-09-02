import { z } from "zod";

export const searchUsersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(["friends", "others"]).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /**
   * "Add Members" pickers. When set, everyone already in the target group /
   * community is removed from the result set BEFORE pagination, so the picker
   * never offers someone who is already there (WhatsApp behaviour) and a page
   * of `limit` rows is a page of `limit` ADDABLE rows.
   *
   * Filtering here rather than on the client is what makes it correct: the
   * client only ever holds the pages it has fetched, so it cannot tell an empty
   * page from an exhausted list.
   */
  excludeGroupRoomId: z.string().trim().min(1).max(100).optional(),
  excludeCommunityId: z.string().trim().min(1).max(100).optional(),
});

export type SearchUsersQuery = z.infer<typeof searchUsersQuerySchema>;
