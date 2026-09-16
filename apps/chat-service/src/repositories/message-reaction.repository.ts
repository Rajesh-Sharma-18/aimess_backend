import type { PrismaClient } from "../generated/prisma/index.js";
import { reactionUserIdMap } from "../lib/chat-message.serializer.js";

/**
 * Conversation kinds the reactor index spans. The three message collections have
 * independent id spaces, so this is part of every key — without it a private and
 * a community message that happened to share an ObjectId would share reactors.
 */
export type ReactionConversationType = "PRIVATE" | "GROUP" | "COMMUNITY";

/** One page of reactors, already ordered by the keyset the cursor encodes. */
export interface ReactionPageRow {
  userId: string;
  emoji: string;
  createdAt: Date;
}

export interface ReactionPage {
  rows: ReactionPageRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Aggregate reaction totals for a message, independent of any loaded page. */
export interface ReactionCounts {
  /** Per-emoji totals, highest first, then emoji for a stable tie-break. */
  byEmoji: Array<{ emoji: string; count: number }>;
  /** Sum of every per-emoji count — the header's "N reactions". */
  total: number;
}

/**
 * Hard ceiling on a page, whatever the caller asks for. The popup renders one
 * row per reactor, so this is also the bound on DOM growth per fetch.
 */
export const REACTION_PAGE_MAX_LIMIT = 50;
export const REACTION_PAGE_DEFAULT_LIMIT = 25;

export const clampReactionLimit = (limit?: number | null): number => {
  if (!limit || !Number.isFinite(limit) || limit <= 0)
    return REACTION_PAGE_DEFAULT_LIMIT;
  return Math.min(Math.trunc(limit), REACTION_PAGE_MAX_LIMIT);
};

/**
 * Keyset cursor — `<epochMs>:<userId>`, the exact tuple the sort orders on.
 * Opaque to the client by contract; encoded rather than signed because it names
 * no data the caller is not already being shown on the page it came from.
 */
const encodeCursor = (row: ReactionPageRow): string =>
  `${row.createdAt.getTime()}:${row.userId}`;

const decodeCursor = (
  cursor: string | null | undefined
): { createdAt: Date; userId: string } | null => {
  if (!cursor) return null;
  const split = cursor.indexOf(":");
  if (split <= 0) return null;
  const ms = Number(cursor.slice(0, split));
  const userId = cursor.slice(split + 1);
  if (!Number.isFinite(ms) || !userId) return null;
  return { createdAt: new Date(ms), userId };
};

/**
 * Paginated reactor index over {@link MessageReaction}.
 *
 * Exists because the authoritative reaction state is a Json map on the message
 * row: correct, cheap to broadcast, and impossible to page — one reactor cannot
 * be read without loading all of them. Every query here is served by one of the
 * two compound indexes on (messageId, conversationType[, emoji], createdAt,
 * userId), so both the page read and the grouped count stay proportional to what
 * they return rather than to the message's total reaction count.
 */
export class MessageReactionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Apply one reactor's change. `emoji: null` removes them. Called after a
   * reaction CAS lands, so it writes exactly one row — never the whole map.
   *
   * One reaction per user per message is the product rule, so the unique key is
   * (messageId, conversationType, userId) and a re-react is an update in place,
   * not a second row. `createdAt` is deliberately NOT refreshed when a user
   * switches emoji: their position in the reactor order is when they first
   * reacted, and rewriting it would shuffle live cursors underneath open popups.
   */
  async applyReactorChange(params: {
    messageId: string;
    conversationType: ReactionConversationType;
    roomId: string;
    userId: string;
    emoji: string | null;
  }): Promise<void> {
    const key = {
      messageId_conversationType_userId: {
        messageId: params.messageId,
        conversationType: params.conversationType,
        userId: params.userId,
      },
    };

    if (params.emoji === null) {
      await this.prisma.messageReaction.deleteMany({
        where: {
          messageId: params.messageId,
          conversationType: params.conversationType,
          userId: params.userId,
        },
      });
      return;
    }

    await this.prisma.messageReaction.upsert({
      where: key,
      update: { emoji: params.emoji },
      create: {
        messageId: params.messageId,
        conversationType: params.conversationType,
        roomId: params.roomId,
        userId: params.userId,
        emoji: params.emoji,
      },
    });
  }

  /** Drop a message's whole reactor index — delete-for-everyone, hard delete. */
  async deleteForMessage(
    messageId: string,
    conversationType: ReactionConversationType
  ): Promise<void> {
    await this.prisma.messageReaction.deleteMany({
      where: { messageId, conversationType },
    });
  }

  /**
   * Materialize a message's stored reactor map into the index, once.
   *
   * Every message written before this collection existed has an unindexed map,
   * and a backfill script alone would leave a window where the popup reads empty.
   * Instead the first paginated read of such a message pays for it — bounded by
   * that one message's existing reaction count, which for pre-existing rows is
   * small. New reactions maintain the index incrementally from then on.
   *
   * Idempotent: the unique key makes a concurrent double-materialize collapse to
   * the same rows, so a lost race costs a duplicate-key error, not a duplicate
   * reactor. `createdAt` cannot be recovered from the map (it stores no
   * timestamps), so seeded rows take their position from the map's own order —
   * which is the order the clients were already being shown.
   */
  async materializeFromStoredMap(params: {
    messageId: string;
    conversationType: ReactionConversationType;
    roomId: string;
    storedReactions: unknown;
    /** Anchor for the synthesized ordering; the message's own createdAt. */
    baseTime: Date;
  }): Promise<void> {
    const byEmoji = reactionUserIdMap(params.storedReactions);
    const rows: Array<{
      messageId: string;
      conversationType: string;
      roomId: string;
      userId: string;
      emoji: string;
      createdAt: Date;
    }> = [];
    const seen = new Set<string>();
    let offset = 0;
    for (const [emoji, userIds] of Object.entries(byEmoji)) {
      for (const userId of userIds) {
        if (!userId || seen.has(userId)) continue;
        seen.add(userId);
        rows.push({
          messageId: params.messageId,
          conversationType: params.conversationType,
          roomId: params.roomId,
          userId,
          emoji,
          createdAt: new Date(params.baseTime.getTime() + offset),
        });
        offset += 1;
      }
    }
    if (rows.length === 0) return;
    await this.prisma.messageReaction.createMany({
      data: rows,
    });
  }

  /**
   * Aggregate totals, read straight off the index rather than counted from a
   * loaded page — the header has to say "1,000,000 reactions" after fetching
   * twenty rows. Grouped on the indexed prefix, so it never scans the collection.
   */
  async countsFor(
    messageId: string,
    conversationType: ReactionConversationType
  ): Promise<ReactionCounts> {
    const grouped = await this.prisma.messageReaction.groupBy({
      by: ["emoji"],
      where: { messageId, conversationType },
      _count: { _all: true },
    });
    const byEmoji = grouped
      .map((row) => ({ emoji: row.emoji, count: row._count._all }))
      .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
    return {
      byEmoji,
      total: byEmoji.reduce((sum, row) => sum + row.count, 0),
    };
  }

  /** The caller's own reaction, if any — drives the "You / Click to remove" row. */
  async selfEmoji(
    messageId: string,
    conversationType: ReactionConversationType,
    userId: string
  ): Promise<string | null> {
    const row = await this.prisma.messageReaction.findUnique({
      where: {
        messageId_conversationType_userId: {
          messageId,
          conversationType,
          userId,
        },
      },
      select: { emoji: true },
    });
    return row?.emoji ?? null;
  }

  /**
   * One keyset page of reactors, optionally narrowed to a single emoji.
   *
   * Keyset rather than skip/take: an offset page over a million rows re-walks
   * everything before it, and a reaction removed mid-scroll would silently shift
   * every later page by one. Fetches `limit + 1` to answer `hasMore` without a
   * second count.
   */
  async page(params: {
    messageId: string;
    conversationType: ReactionConversationType;
    emoji?: string | null;
    cursor?: string | null;
    limit?: number | null;
  }): Promise<ReactionPage> {
    const limit = clampReactionLimit(params.limit);
    const after = decodeCursor(params.cursor);

    const rows = await this.prisma.messageReaction.findMany({
      where: {
        messageId: params.messageId,
        conversationType: params.conversationType,
        ...(params.emoji ? { emoji: params.emoji } : {}),
        ...(after
          ? {
              OR: [
                { createdAt: { gt: after.createdAt } },
                {
                  createdAt: after.createdAt,
                  userId: { gt: after.userId },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
      take: limit + 1,
      select: { userId: true, emoji: true, createdAt: true },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      rows: page,
      hasMore,
      nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
    };
  }
}
