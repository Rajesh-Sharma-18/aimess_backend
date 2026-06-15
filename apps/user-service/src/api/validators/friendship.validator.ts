import { z } from "zod";

export const sendFriendRequestSchema = z.object({
  addresseeId: z.string().uuid("User ID is invalid"),
});

export type SendFriendRequestInput = z.infer<typeof sendFriendRequestSchema>;

export const friendshipIdParamsSchema = z.object({
  id: z.string().uuid("Friendship ID is invalid"),
});

export type FriendshipIdParams = z.infer<typeof friendshipIdParamsSchema>;

export const unfriendParamsSchema = z.object({
  userId: z.string().uuid("User ID is invalid"),
});

export type UnfriendParams = z.infer<typeof unfriendParamsSchema>;

export const listFriendRequestsQuerySchema = z.object({
  direction: z.enum(["incoming", "outgoing", "all"]).default("incoming"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type ListFriendRequestsQuery = z.infer<
  typeof listFriendRequestsQuerySchema
>;
