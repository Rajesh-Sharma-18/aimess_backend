import { z } from "zod";

/**
 * `confirm` must be sent as literal `true` — this is a blast-radius trip-wire
 * for a platform-wide destructive action, not the access control (that's
 * `requirePermission(PERMISSIONS.SETTINGS_MANAGE)` on the route). Omitting it,
 * or sending `false`, fails validation before the request ever reaches the
 * controller.
 */
export const disconnectAllFriendshipsSchema = z.object({
  confirm: z.literal(true),
});

export type DisconnectAllFriendshipsInput = z.infer<
  typeof disconnectAllFriendshipsSchema
>;
