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
