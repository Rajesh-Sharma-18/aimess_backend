import { logger } from "@aimess/logger";

import type {
  MessageReactionRepository,
  ReactionConversationType,
  ReactionCounts,
  ReactionPage,
} from "../repositories/message-reaction.repository.js";

/**
 * The bits of a message row the index needs to (re)build itself. Deliberately
 * structural rather than one of the three Prisma model types — the private,
 * group and community rows disagree on nearly every other field name.
 */
export interface ReactionIndexSource {
  id: string;
  roomId: string;
  reactions: unknown;
  createdAt: Date;
  reactionsIndexedAt: Date | null;
}

/**
 * Per-message delegate for the `reactionsIndexedAt` stamp. Each message
 * collection owns its own row, so the caller supplies the update.
 */
export type ReactionIndexStamp = (
  messageId: string,
  at: Date
) => Promise<unknown>;

/**
 * Bring a message's reactor index up to date before it is paged.
 *
 * A row written before the index existed carries `reactionsIndexedAt: null` and
 * a populated Json map; the first paginated read materializes one from the
 * other and stamps the row so it never happens twice. Doing it here rather than
 * only in a backfill script is what lets the feature be correct the moment it
 * ships, on data nobody has migrated yet.
 *
 * Failure is logged and swallowed: a message whose index could not be built
 * reads as "no reactors yet" in the popup, which is wrong but harmless and
 * self-corrects on the next attempt. Throwing here would instead take down a
 * read path that the authoritative Json map could still have served.
 */
export async function ensureReactionIndex(
  index: MessageReactionRepository,
  conversationType: ReactionConversationType,
  message: ReactionIndexSource,
  stamp: ReactionIndexStamp
): Promise<void> {
  if (message.reactionsIndexedAt) return;
  try {
    await index.materializeFromStoredMap({
      messageId: message.id,
      conversationType,
      roomId: message.roomId,
      storedReactions: message.reactions,
      baseTime: message.createdAt,
    });
    await stamp(message.id, new Date());
  } catch (err) {
    logger.warn(
      `reaction index materialize failed for ${conversationType} ${message.id}: ${String(err)}`
    );
  }
}

/**
 * The reactor whose row changed in a single reaction toggle. `emoji: null` is a
 * removal. One user per toggle is guaranteed by the stored-map primitives, which
 * strip the user from every bucket before re-adding them to at most one.
 */
export interface ReactionIndexDelta {
  userId: string;
  emoji: string | null;
}

/**
 * Mirror one toggle into the index after its CAS has landed.
 *
 * Swallows failures for the same reason as {@link ensureReactionIndex}: the Json
 * map is authoritative and has already been written, so a projection that falls
 * behind must not fail the user's reaction. Drift is bounded — the message's
 * `reactionsIndexedAt` stamp can be cleared to force a rebuild.
 */
export async function applyReactionIndexDelta(
  index: MessageReactionRepository,
  params: {
    messageId: string;
    conversationType: ReactionConversationType;
    roomId: string;
    delta: ReactionIndexDelta;
  }
): Promise<void> {
  try {
    await index.applyReactorChange({
      messageId: params.messageId,
      conversationType: params.conversationType,
      roomId: params.roomId,
      userId: params.delta.userId,
      emoji: params.delta.emoji,
    });
  } catch (err) {
    logger.warn(
      `reaction index delta failed for ${params.conversationType} ${params.messageId}: ${String(err)}`
    );
  }
}

/** Raw page + aggregates, before user profiles are attached. */
export interface ReactionDetailsSlice {
  page: ReactionPage;
  counts: ReactionCounts;
  selfEmoji: string | null;
}

/**
 * Read one page plus the aggregates that must NOT be derived from it.
 *
 * The counts come from a grouped query over the whole index, so the header still
 * reads "1,000,000 reactions" when twenty rows have been fetched — deriving them
 * from the page is the bug this shape exists to prevent.
 */
export async function readReactionDetailsSlice(
  index: MessageReactionRepository,
  params: {
    messageId: string;
    conversationType: ReactionConversationType;
    requesterId: string;
    emoji?: string | null;
    cursor?: string | null;
    limit?: number | null;
  }
): Promise<ReactionDetailsSlice> {
  const [page, counts, selfEmoji] = await Promise.all([
    index.page({
      messageId: params.messageId,
      conversationType: params.conversationType,
      emoji: params.emoji,
      cursor: params.cursor,
      limit: params.limit,
    }),
    index.countsFor(params.messageId, params.conversationType),
    index.selfEmoji(
      params.messageId,
      params.conversationType,
      params.requesterId
    ),
  ]);
  return { page, counts, selfEmoji };
}

/** One reactor row as the popup renders it. */
export interface ReactionDetailsUser {
  userId: string;
  displayName: string;
  /** Resolved download URL — never a raw object key. */
  avatar: string;
  emoji: string;
}

/** The whole reaction-details response for one page of one filter. */
export interface ReactionDetailsPage {
  users: ReactionDetailsUser[];
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * Aggregates for the header and the filter chips. Read from the index, NOT
   * summed from `users` — the popup shows the true total after loading a page.
   */
  counts: Array<{ emoji: string; count: number }>;
  total: number;
  /** The caller's own emoji on this message, or "" when they have not reacted. */
  selfEmoji: string;
}

/**
 * Attach profiles to one page of reactors.
 *
 * The snapshot fan-out and the avatar presign batch both cover the PAGE only,
 * which is the whole point of paging: a message with a million reactors costs
 * the same here as one with twenty.
 */
export async function buildReactionDetailsPage(params: {
  slice: ReactionDetailsSlice;
  loadSnapshots: (
    userIds: string[]
  ) => Promise<Map<string, Record<string, unknown>>>;
  resolveAvatars: (keys: string[]) => Promise<Map<string, string>>;
  resolveName: (snapshot: Record<string, unknown> | undefined) => string;
  urlFor: (map: Map<string, string>, key: string) => string;
}): Promise<ReactionDetailsPage> {
  const { slice } = params;
  const userIds = [...new Set(slice.page.rows.map((row) => row.userId))];
  const snapshots = userIds.length
    ? await params.loadSnapshots(userIds)
    : new Map<string, Record<string, unknown>>();
  const urlMap = await params.resolveAvatars(
    [...snapshots.values()].map((snap) => (snap.avatar as string) || "")
  );

  return {
    users: slice.page.rows.map((row) => {
      const snap = snapshots.get(row.userId);
      return {
        userId: row.userId,
        displayName: params.resolveName(snap),
        avatar: params.urlFor(urlMap, (snap?.avatar as string) || ""),
        emoji: row.emoji,
      };
    }),
    nextCursor: slice.page.nextCursor,
    hasMore: slice.page.hasMore,
    counts: slice.counts.byEmoji,
    total: slice.counts.total,
    selfEmoji: slice.selfEmoji ?? "",
  };
}
