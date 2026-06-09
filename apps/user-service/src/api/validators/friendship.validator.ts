import { z } from "zod";

export const sendFriendRequestSchema = z.object({
  addresseeId: z.string().uuid("Invalid user ID format."),
});

export type SendFriendRequestInput = z.infer<typeof sendFriendRequestSchema>;

export const friendshipIdParamsSchema = z.object({
  id: z.string().uuid("Invalid friendship ID format."),
});

export type FriendshipIdParams = z.infer<typeof friendshipIdParamsSchema>;

export const unfriendParamsSchema = z.object({
  userId: z.string().uuid("Invalid user ID format."),
});

export type UnfriendParams = z.infer<typeof unfriendParamsSchema>;
