import { z } from "zod";

/** Shared query-param schemas for message list + search endpoints. */

export const messageListQuerySchema = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Query schema for the timestamp-paginated message-list endpoints
 * (private room + group). Timestamps are epoch milliseconds.
 *
 * - `before_ts`: return messages with createdAt <= before_ts (newest-first).
 * - `after_ts` : return messages with createdAt >= after_ts (oldest-first).
 *
 * The two are mutually exclusive; omit both for the newest page. Boundaries are
 * inclusive, so consecutive pages may share the boundary message when timestamps
 * tie — clients should de-duplicate by message id.
 */
export const messageTimelineQuerySchema = z
  .object({
    before_ts: z.coerce.number().int().positive().optional(),
    after_ts: z.coerce.number().int().positive().optional(),
    // V2 §3.2: gap-safe seq cursors. before_seq → sequenceNumber < seq
    // (newest-first); after_seq → > seq (oldest-first). `around` anchors a
    // jump-to-message window on a messageId. Seq cursors take precedence over
    // the *_ts ones when both are sent.
    before_seq: z.coerce.number().int().min(0).optional(),
    after_seq: z.coerce.number().int().min(0).optional(),
    around: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .refine((q) => !(q.before_ts != null && q.after_ts != null), {
    message: "Please provide only one pagination parameter at a time.",
    path: ["before_ts"],
  })
  .refine((q) => !(q.before_seq != null && q.after_seq != null), {
    message: "Provide either before_seq or after_seq, not both",
    path: ["before_seq"],
  });

/**
 * V2 §3.3: query schema for the per-conversation incremental sync endpoint.
 * `conv_id` is required (seq is per-room); whole-account discovery uses /inbox.
 */
export const syncQuerySchema = z.object({
  conv_id: z.string().min(1).max(300),
  from_seq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  type: z.enum(["private", "group"]).optional(),
});

export const messageSearchQuerySchema = z.object({
  q: z.string().max(100).optional(),
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Query schema for the shared media/docs listing endpoints. */
export const mediaListQuerySchema = z.object({
  type: z
    .enum(["IMAGE", "VIDEO", "GIF", "VOICE", "DOCUMENT", "STICKER"])
    .optional(),
  cursor: z.string().nullish(),
  limit: z.coerce.number().min(1).max(100).default(30),
});

/**
 * Query schema for the timestamp-paginated community message-list endpoint.
 * Mirrors messageTimelineQuerySchema but omits seq cursors (community messages
 * have no sequenceNumber column). Timestamps are epoch milliseconds.
 *
 * The two timestamp params are mutually exclusive:
 *
 * - `before_ts`: scroll / history mode. Returns messages with
 *   `createdAt <= before_ts`, newest-first. Only live messages (no tombstones).
 *   Feed the returned `nextCursor` back as the next `before_ts` to page back.
 *
 * - `after_ts`: incremental sync mode. Returns ALL messages (new, edited,
 *   reacted, deleted tombstones) where `updatedAt >= after_ts`, oldest-first.
 *   Designed for offline-first mobile clients: store the highest `updatedAt`
 *   seen and send it back as `after_ts` on the next foreground call.
 *
 * - `around`: jump-to-message window anchored on a messageId.
 *
 * Omit all three for the newest page.
 */
export const communityTimelineQuerySchema = z
  .object({
    before_ts: z.coerce.number().int().positive().optional(),
    after_ts: z.coerce.number().int().positive().optional(),
    around: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .refine((q) => !(q.before_ts != null && q.after_ts != null), {
    message: "Provide either before_ts or after_ts, not both",
    path: ["before_ts"],
  });

/**
 * Query schema for the community incremental-sync REST endpoint.
 * `GET /api/chat/community/rooms/:roomId/sync?since_ts=<ms>&limit=<n>`
 *
 * Returns all messages (new, edited, reacted, tombstones) whose
 * `updatedAt >= since_ts`, sorted oldest-first. The client stores the
 * highest `updatedAt` it has seen and feeds it back as `since_ts`.
 */
export const communitySyncQuerySchema = z.object({
  since_ts: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Query schema for the offset-paginated "conversation" endpoint (group +
 * community). The client sends a 1-based pageNumber, a page limit, and an
 * optional `timestamp` (epoch milliseconds) used as the `createdAt <` boundary.
 */
export const conversationQuerySchema = z.object({
  pageNumber: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  timestamp: z.coerce.number().int().positive().optional(),
});

/**
 * Query schema for the unified inbox endpoint (private rooms + group chats
 * merged, ordered by lastMessageAt). Timestamps are epoch milliseconds.
 *
 * - `before_ts`: return items with lastMessageAt <= before_ts (newest-first).
 * - `after_ts` : return items with lastMessageAt >= after_ts (oldest-first).
 *
 * The two are mutually exclusive; omit both for the newest page.
 */
export const inboxQuerySchema = z
  .object({
    before_ts: z.coerce.number().int().positive().optional(),
    after_ts: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((q) => !(q.before_ts != null && q.after_ts != null), {
    message: "Please provide only one pagination parameter at a time.",
    path: ["before_ts"],
  });
