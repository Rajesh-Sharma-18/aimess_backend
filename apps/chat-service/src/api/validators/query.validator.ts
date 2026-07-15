import { z } from "zod";

/** Shared query-param schemas for message list + search endpoints. */

export const messageListQuerySchema = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Query schema for the timestamp-paginated message-list endpoints
 * (private room + group).
 *
 * - `before_ts`: older page, newest-first.
 * - `after_ts` : newer page, oldest-first.
 *
 * Each is a (createdAt, _id) KEYSET cursor: send a plain epoch-ms for the first
 * page / a coarse jump, then feed the returned compound `nextCursor`
 * ("<ms>_<objectId>") back verbatim to page on. The `_id` tiebreaker makes
 * continuation EXCLUSIVE and keeps same-millisecond messages reachable exactly
 * once — so consecutive pages no longer share a boundary message (no client-side
 * de-dupe needed). V2 clients should prefer the gap-safe before_seq/after_seq
 * cursors; these *_ts params are the V1 fallback. The two are mutually exclusive;
 * omit both for the newest page.
 */
// Timestamp cursors: EITHER a plain epoch-ms ("1782133107521") OR the opaque
// COMPOUND keyset cursor "<ms>_<objectId>" handed back as `nextCursor`. Kept as a
// string so the `_id` tiebreaker survives — coercing to a number would drop it and
// reintroduce same-millisecond message skipping at page boundaries.
const compoundTsCursor = z
  .string()
  .regex(
    /^\d+(_[a-fA-F0-9]{24})?$/,
    "must be epoch-ms or the compound cursor '<ms>_<objectId>'"
  );

export const messageTimelineQuerySchema = z
  .object({
    before_ts: compoundTsCursor.optional(),
    after_ts: compoundTsCursor.optional(),
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
    message: "Please provide only one pagination parameter at a time",
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
 * Query schema for the timestamp-paginated community message-list endpoint (V1).
 * Community messages DO carry a real per-room monotonic `sequenceNumber`
 * (allocateSequence → generalRoom.lastSequence); the V1 endpoint simply paginates
 * on the `(createdAt, _id)` timestamp keyset instead. The gap-safe seq cursors
 * (`before_seq`/`after_seq`) live on the V2 schema below. Timestamps are epoch ms.
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
    // EITHER a plain epoch-ms ("1782133107521") OR the opaque compound keyset
    // cursor "<ms>_<objectId>" handed back as `nextCursor`. Kept as a string so
    // the `_id` tiebreaker survives — coercing to a number would drop it and
    // reintroduce same-millisecond message skipping.
    before_ts: z
      .string()
      .regex(
        /^\d+(_[a-fA-F0-9]{24})?$/,
        "before_ts must be epoch-ms or '<ms>_<objectId>'"
      )
      .optional(),
    after_ts: z.coerce.number().int().positive().optional(),
    around: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .refine((q) => !(q.before_ts != null && q.after_ts != null), {
    message: "Provide either before_ts or after_ts, not both",
    path: ["before_ts"],
  });

/**
 * V2 query schema for the community message timeline
 * (`GET /api/v2/chat/community/rooms/:roomId/messages`). Replaces the V1
 * timestamp cursor with the gap-safe monotonic `sequenceNumber` keyset — the
 * exact contract private/group already expose (`before_seq`/`after_seq`), so
 * clients share one seq-paging path across every room type.
 *
 * - `before_seq`: older page — `sequenceNumber < before_seq`, newest-first.
 * - `after_seq` : newer page — `sequenceNumber > after_seq`, oldest-first.
 * - `around`    : jump-to-message window anchored on a messageId; the returned
 *   `olderCursor`/`newerCursor` are seq strings fed back as `before_seq`/`after_seq`.
 *
 * Omit all three for the newest page. `before_seq`/`after_seq` are mutually
 * exclusive. No `*_ts` params — that is V1's (frozen) surface.
 */
export const communityTimelineV2QuerySchema = z
  .object({
    before_seq: z.coerce.number().int().min(0).optional(),
    after_seq: z.coerce.number().int().min(0).optional(),
    around: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .refine((q) => !(q.before_seq != null && q.after_seq != null), {
    message: "Provide either before_seq or after_seq, not both",
    path: ["before_seq"],
  });

/**
 * Query schema for the ZERO-LOSS changes feed
 * (`GET /api/v2/chat/community/rooms/:roomId/changes`). `since_revision` is the
 * client's per-room CHANGE high-water; `0` = cold start (drains from the
 * beginning within the retention horizon). Returns inserts AND mutations whose
 * `revision > since_revision`.
 */
export const communityChangesV2QuerySchema = z.object({
  since_revision: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
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
/**
 * Query schema for the unified cross-conversation-type message-context
 * endpoint (`GET /messages/:messageId/context`) — reply/pinned/search-result/
 * deep-link navigation. `roomId` is required so the target message can be
 * bound to the conversation the caller claims it belongs to (cross-room IDOR
 * guard, enforced in the service layer).
 */
export const messageContextQuerySchema = z.object({
  conversationType: z.enum(["PRIVATE", "GROUP", "COMMUNITY"], {
    error: "conversationType must be one of PRIVATE, GROUP, COMMUNITY",
  }),
  roomId: z.string().min(1).max(300),
});

export const inboxQuerySchema = z
  .object({
    before_ts: z.coerce.number().int().positive().optional(),
    after_ts: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((q) => !(q.before_ts != null && q.after_ts != null), {
    message: "Please provide only one pagination parameter at a time",
    path: ["before_ts"],
  });

/**
 * `GET /chat/private/conversations` — cursor (before_ts/after_ts, epoch ms)
 * pagination, using the exact same query-param contract as `myCommunitiesQuerySchema`'s
 * joined-mode (`before_ts`/`after_ts`/`limit`, same `limit` bounds) so the private
 * conversation list and the community list share one pagination strategy.
 */
export const privateConversationListQuerySchema = z
  .object({
    before_ts: z.coerce.number().int().positive().optional(),
    after_ts: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(50).default(20),
  })
  .refine((q) => !(q.before_ts != null && q.after_ts != null), {
    message: "Only one pagination parameter is allowed at a time",
    path: ["before_ts"],
  });

export type PrivateConversationListQuery = z.infer<
  typeof privateConversationListQuerySchema
>;
