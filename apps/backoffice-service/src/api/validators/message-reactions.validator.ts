import { z } from "zod";

/**
 * Query for the read-only Reaction Details popup, shared by the group and
 * community conversation viewers.
 *
 * `emoji` narrows to one filter chip (absent = the "All" chip); `cursor` is the
 * opaque `nextCursor` echoed back from the previous page. Each filter pages
 * independently, so the client keeps one cursor per chip.
 */
export const messageReactionsQuerySchema = z.object({
  emoji: z.string().trim().min(1).max(64).optional(),
  cursor: z.string().trim().max(128).optional(),
  // Bounded page size — chat-service clamps to its own ceiling regardless, so
  // this is the API's own guard against an unbounded reactor fan-out.
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export type MessageReactionsQueryInput = z.infer<
  typeof messageReactionsQuerySchema
>;

/**
 * Jump-to-message additions to a conversation-page query. Shared so the group
 * and community viewers navigate through ONE contract: both take an
 * `aroundMessageId` window read and a forward (`after`) page, and neither has
 * its own bespoke scrolling scheme.
 */
export const messageNavigationQueryFields = {
  aroundMessageId: z.string().trim().min(1).max(64).optional(),
  direction: z.enum(["before", "after"]).optional(),
  // "media" = the media viewer's gallery walk: IMAGE/VIDEO messages only,
  // newest first, `cursor` = the previous page's createdAt ISO.
  type: z.literal("media").optional(),
};
