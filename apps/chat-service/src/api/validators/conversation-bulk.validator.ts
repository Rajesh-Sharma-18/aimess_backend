import { z } from "zod";

/**
 * Bulk conversation operations for the unified inbox (PRIVATE + GROUP).
 *
 * The request contract mirrors community-service's `bulkMuteSchema` /
 * `bulkMarkReadSchema` / `bulkLeaveSchema` one-for-one — same `action` enum,
 * same server-computed `durationMinutes`, same 50-item cap and same
 * de-duplicating transform — so a client that already speaks the community
 * bulk API needs no new mental model here. Only the id field differs:
 * `roomIds` instead of `communityIds`, because a chat conversation is
 * addressed by its room id (`prv_…` / `grp_…`), and the conversation TYPE is
 * derived from that prefix (see lib/conversation-type.ts) rather than being
 * passed by the client.
 */
/**
 * Accept snake_case field names as aliases for the canonical camelCase ones.
 *
 * The mobile clients serialize their DTOs snake_case (`room_ids`,
 * `duration_minutes`), so the exact payload iOS sends —
 * `{ room_ids: [...], action: "mute", duration_minutes: 10 }` — was rejected
 * 400 "roomIds Required" before ever reaching the service. The camelCase names
 * stay canonical (that is what the web client, the OpenAPI doc and every test
 * use); snake_case is folded onto them here so BOTH spellings work and no
 * existing consumer changes. A camelCase value already present always wins.
 */
function withSnakeAliases<T extends z.ZodTypeAny>(
  schema: T,
  aliases: Record<string, string>
) {
  return z.preprocess((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    const body = { ...(value as Record<string, unknown>) };
    for (const [snake, camel] of Object.entries(aliases)) {
      if (body[camel] === undefined && body[snake] !== undefined) {
        body[camel] = body[snake];
      }
      delete body[snake];
    }
    return body;
  }, schema);
}

const roomIdsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(5, "One or more conversation IDs are invalid")
      .max(100, "One or more conversation IDs are invalid")
  )
  .min(1, "Select at least one conversation")
  .max(50, "You can select at most 50 conversations")
  .transform((ids) => [...new Set(ids)]);

export const bulkMuteConversationsSchema = withSnakeAliases(
  z.object({
    action: z.enum(["mute", "unmute"]),
    roomIds: roomIdsSchema,
    /**
     * Minutes from now, resolved against the SERVER's clock (community parity —
     * a client clock can never produce an already-expired mute). Null/omitted =
     * indefinite. Ignored entirely when `action` is "unmute".
     */
    durationMinutes: z
      .number()
      .int()
      .min(1, "Mute duration must be at least 1 minute")
      .max(525_600, "Mute duration must be at most 365 days")
      .nullable()
      .optional(),
  }),
  { room_ids: "roomIds", duration_minutes: "durationMinutes" }
);
export type BulkMuteConversationsInput = z.infer<
  typeof bulkMuteConversationsSchema
>;

// `action: "read"` is accepted and ignored — the clients send it for symmetry
// with the mute payload, and a non-strict object simply strips it.
export const bulkMarkReadConversationsSchema = withSnakeAliases(
  z.object({
    roomIds: roomIdsSchema,
  }),
  { room_ids: "roomIds" }
);
export type BulkMarkReadConversationsInput = z.infer<
  typeof bulkMarkReadConversationsSchema
>;

export const bulkLeaveConversationsSchema = withSnakeAliases(
  z.object({
    roomIds: roomIdsSchema,
    /**
     * What "leave" means for a GROUP row, because the product has TWO distinct
     * single-conversation operations and this endpoint must not silently pick
     * one for the caller:
     *
     *  - "LEAVE"  (default) — real membership removal, identical to
     *    `POST /chat/group-members/{roomId}/leave`: MEMBER_LEFT system message,
     *    memberCount decrement, `group:removed` + roster fan-out. The direct
     *    counterpart of `POST /communities/leave/bulk`.
     *  - "DELETE" — the sidebar's "Delete Conversation": clears the caller's own
     *    history and leaves membership intact, identical to
     *    `DELETE /chat/groups/{roomId}`.
     *
     * PRIVATE rows ignore this: a 1-to-1 room has no membership to leave, so the
     * only self-removal it has is delete-for-me (`DELETE /chat/private/rooms/{roomId}`),
     * which is what they always run.
     */
    groupAction: z.enum(["LEAVE", "DELETE"]).default("LEAVE"),
  }),
  { room_ids: "roomIds", group_action: "groupAction" }
);
export type BulkLeaveConversationsInput = z.infer<
  typeof bulkLeaveConversationsSchema
>;
