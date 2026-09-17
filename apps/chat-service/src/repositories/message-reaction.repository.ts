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
  /** The message this reaction sits on — an album pages over several at once. */
  messageId: string;
  /** The attachment it names, or null for the message/collage as a whole. */
  mediaIndex: number | null;
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
 * Keyset cursor — `<epochMs>|<userId>|<messageId>|<mediaIndex>`, the exact tuple the
 * sort orders on. Opaque to the client by contract; encoded rather than signed
 * because it names no data the caller is not already being shown on the page it
 * came from.
 *
 * `messageId` and `mediaIndex` joined the tuple when a page grew to span a whole
 * album: one user reacting to two photos in the same millisecond is two rows that
 * `(createdAt, userId)` alone cannot order, and an ambiguous keyset either repeats
 * a row on the next page or skips it. `|` rather than `:` because an ObjectId is
 * hex but a userId is a UUID — neither can contain a pipe.
 */
const NO_MEDIA = -1;

const encodeCursor = (row: ReactionPageRow): string =>
  // `messageId` is always selected on the read path, but defaulted rather than
  // interpolated raw: an undefined here would encode the string "undefined" into
  // a cursor the next page then fails to resume from, silently.
  `${row.createdAt.getTime()}|${row.userId}|${row.messageId ?? ""}|${row.mediaIndex ?? NO_MEDIA}`;

interface ReactionCursor {
  createdAt: Date;
  userId: string;
  messageId: string;
  mediaIndex: number;
}

const decodeCursor = (
  cursor: string | null | undefined
): ReactionCursor | null => {
  if (!cursor) return null;
  const parts = cursor.split("|");
  if (parts.length !== 4) return null;
  const ms = Number(parts[0]);
  const mediaIndex = Number(parts[3]);
  if (!Number.isFinite(ms) || !parts[1] || !parts[2]) return null;
  return {
    createdAt: new Date(ms),
    userId: parts[1],
    messageId: parts[2],
    mediaIndex: Number.isFinite(mediaIndex) ? mediaIndex : NO_MEDIA,
  };
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
   * One reaction per user per TARGET is the product rule, and the target is
   * (message, attachment) — a reader may hold one reaction on each photo of a
   * collage plus one on the collage itself — so that triple is the unique key and
   * a re-react is an update in place, not a second row. `createdAt` is
   * deliberately NOT refreshed when a user switches emoji: their position in the
   * reactor order is when they first reacted, and rewriting it would shuffle live
   * cursors underneath open popups.
   *
   * `updateMany`-then-`create` rather than `upsert`: the compound unique key now
   * contains a NULLABLE column, which Prisma's `where` for a compound key cannot
   * express. The update keeps `createdAt` untouched, which is the behaviour the
   * paragraph above depends on.
   */
  async applyReactorChange(params: {
    messageId: string;
    conversationType: ReactionConversationType;
    roomId: string;
    userId: string;
    emoji: string | null;
    mediaIndex?: number | null;
  }): Promise<void> {
    const target = {
      messageId: params.messageId,
      conversationType: params.conversationType,
      userId: params.userId,
      mediaIndex: params.mediaIndex ?? null,
    };

    if (params.emoji === null) {
      await this.prisma.messageReaction.deleteMany({ where: target });
      return;
    }

    const updated = await this.prisma.messageReaction.updateMany({
      where: target,
      data: { emoji: params.emoji },
    });
    if (updated.count > 0) return;

    await this.prisma.messageReaction.create({
      data: {
        messageId: params.messageId,
        conversationType: params.conversationType,
        roomId: params.roomId,
        userId: params.userId,
        emoji: params.emoji,
        mediaIndex: params.mediaIndex ?? null,
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
   * REBUILDS rather than appends, which is what makes it idempotent.
   *
   * The write path populates this collection for any message that gets a
   * reaction, including one that has never been materialized — so by the time a
   * legacy message is first paged, some of its reactors may already have rows.
   * Inserting the map on top of those produced a SECOND row for each of them and
   * inflated every count that read the projection: a message with seven real
   * reactions reported ten. Clearing first means the map, which is
   * authoritative, is the only thing that decides what ends up here.
   *
   * `createdAt` cannot be recovered from the map (it stores no timestamps), so
   * seeded rows take their position from the map's own order — which is the
   * order the clients were already being shown. A row the write path had already
   * created loses its real timestamp to the synthesized one; that only reorders
   * reactors within a single message, once, and is the price of having one
   * authority instead of two.
   *
   * The unique key is the backstop for two readers racing to rebuild the same
   * message; it is created by `prisma db push`, and this method is correct
   * without it.
   */
  async materializeFromStoredMap(params: {
    messageId: string;
    conversationType: ReactionConversationType;
    roomId: string;
    storedReactions: unknown;
    /** The per-attachment buckets, `{ "<idx>": { emoji: reactor[] } }`. */
    storedMediaReactions?: unknown;
    /** Anchor for the synthesized ordering; the message's own createdAt. */
    baseTime: Date;
  }): Promise<void> {
    const rows: Array<{
      messageId: string;
      conversationType: string;
      roomId: string;
      userId: string;
      emoji: string;
      mediaIndex: number | null;
      createdAt: Date;
    }> = [];
    // De-duped per TARGET, not per user: one reader legitimately holds a reaction
    // on several photos of the same message, and keying on the user alone dropped
    // all but the first.
    const seen = new Set<string>();
    let offset = 0;
    const project = (stored: unknown, mediaIndex: number | null) => {
      for (const [emoji, userIds] of Object.entries(reactionUserIdMap(stored))) {
        for (const userId of userIds) {
          const key = `${mediaIndex ?? -1}:${userId}`;
          if (!userId || seen.has(key)) continue;
          seen.add(key);
          rows.push({
            messageId: params.messageId,
            conversationType: params.conversationType,
            roomId: params.roomId,
            userId,
            emoji,
            mediaIndex,
            createdAt: new Date(params.baseTime.getTime() + offset),
          });
          offset += 1;
        }
      }
    };
    project(params.storedReactions, null);
    const media = params.storedMediaReactions;
    if (media && typeof media === "object") {
      for (const key of Object.keys(media as Record<string, unknown>)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0) continue;
        project((media as Record<string, unknown>)[key], index);
      }
    }
    await this.prisma.messageReaction.deleteMany({
      where: {
        messageId: params.messageId,
        conversationType: params.conversationType,
      },
    });
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
    messageIds: string[],
    conversationType: ReactionConversationType
  ): Promise<ReactionCounts> {
    const grouped = await this.prisma.messageReaction.groupBy({
      by: ["emoji"],
      where: { messageId: { in: messageIds }, conversationType },
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

  /**
   * The caller's own reaction on the MESSAGE itself, if any — drives the popup's
   * "you have reacted" state. Per-attachment reactions are deliberately not
   * folded in here: a reader can hold several at once, so there is no single
   * answer, and each row already reports its own target.
   */
  async selfEmoji(
    messageIds: string[],
    conversationType: ReactionConversationType,
    userId: string
  ): Promise<string | null> {
    const row = await this.prisma.messageReaction.findFirst({
      where: {
        messageId: { in: messageIds },
        conversationType,
        userId,
        mediaIndex: null,
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
    /**
     * Every message the page spans. One id for an ordinary message; a web-sent
     * album is N separate messages rendered as one collage, and its popup has to
     * read across all of them.
     */
    messageIds: string[];
    conversationType: ReactionConversationType;
    emoji?: string | null;
    cursor?: string | null;
    limit?: number | null;
  }): Promise<ReactionPage> {
    const limit = clampReactionLimit(params.limit);
    const after = decodeCursor(params.cursor);

    const rows = await this.prisma.messageReaction.findMany({
      where: {
        messageId: { in: params.messageIds },
        conversationType: params.conversationType,
        ...(params.emoji ? { emoji: params.emoji } : {}),
        // The keyset, spelled out in full: strictly-after on the leading column,
        // then equal-and-after on each following one. Four terms because the sort
        // key is four columns — see encodeCursor.
        ...(after
          ? {
              OR: [
                { createdAt: { gt: after.createdAt } },
                {
                  createdAt: after.createdAt,
                  userId: { gt: after.userId },
                },
                {
                  createdAt: after.createdAt,
                  userId: after.userId,
                  messageId: { gt: after.messageId },
                },
                {
                  createdAt: after.createdAt,
                  userId: after.userId,
                  messageId: after.messageId,
                  mediaIndex: { gt: after.mediaIndex },
                },
              ],
            }
          : {}),
      },
      orderBy: [
        { createdAt: "asc" },
        { userId: "asc" },
        { messageId: "asc" },
        { mediaIndex: "asc" },
      ],
      take: limit + 1,
      select: {
        userId: true,
        emoji: true,
        createdAt: true,
        messageId: true,
        mediaIndex: true,
      },
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
