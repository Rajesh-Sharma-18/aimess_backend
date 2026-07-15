/**
 * Bidirectional continuation signals for the jump-to-message (`?around=`)
 * window. A mid-thread window can be paged BOTH ways (older + newer), so unlike
 * the single-direction history endpoints it must tell the client where to page
 * in each direction and whether anything remains there.
 *
 * The cursors are deliberately in the SAME numeric format the endpoint's
 * existing paging params already consume, so a client feeds them straight back
 * with no new cursor scheme (see the message-navigation contract §5.2):
 *  - private / group: plain `sequenceNumber` → `before_seq` (older) / `after_seq` (newer).
 *  - community:       `"<ms>_<id>"` compound → `before_ts` (older); plain epoch-ms → `after_ts` (newer).
 */
export interface AroundCursors {
  /** A history-visible message older than the window's first row exists. */
  hasMoreOlder: boolean;
  /** A history-visible message newer than the window's last row exists. */
  hasMoreNewer: boolean;
  /** Feed as `before_seq` (private/group) or `before_ts` (community) to page older. */
  olderCursor: string | null;
  /** Feed as `after_seq` (private/group) or `after_ts` (community) to page newer. */
  newerCursor: string | null;
}

/** Cursors for an empty window (anchor deleted-for-me with nothing around it). */
export const EMPTY_AROUND_CURSORS: AroundCursors = {
  hasMoreOlder: false,
  hasMoreNewer: false,
  olderCursor: null,
  newerCursor: null,
};

/** One extra row beyond a boundary is enough to prove "there is more". */
const hasAny = (rows: { length: number }): boolean => rows.length > 0;

/**
 * Seq-keyset window (private/group). `probe(direction, seq)` must return the
 * rows strictly beyond `seq` in that direction (reuse the repo's existing
 * `findByRoomIdSeq` with `limit: 1`). Cursors are the boundary sequenceNumbers.
 */
export async function computeSeqAroundCursors<
  T extends { sequenceNumber: number },
>(
  items: T[],
  probe: (
    direction: "before" | "after",
    seq: number
  ) => Promise<{ length: number }>
): Promise<AroundCursors> {
  if (items.length === 0) return EMPTY_AROUND_CURSORS;
  const oldest = items[0]!.sequenceNumber;
  const newest = items[items.length - 1]!.sequenceNumber;
  const [older, newer] = await Promise.all([
    probe("before", oldest),
    probe("after", newest),
  ]);
  return {
    hasMoreOlder: hasAny(older),
    hasMoreNewer: hasAny(newer),
    olderCursor: String(oldest),
    newerCursor: String(newest),
  };
}

/**
 * Date-keyset window (community). `probe(direction, ts, boundaryId)` must return
 * the rows strictly beyond the `(ts, _id)` keyset in that direction (reuse the
 * repo's existing `findByRoomIdTimeline` with `limit: 1`, `inclusive: false`).
 * olderCursor is the compound `"<ms>_<id>"` the `before_ts` param accepts;
 * newerCursor is plain epoch-ms as the `after_ts` param accepts.
 */
export async function computeDateAroundCursors<
  T extends { createdAt: Date; id: string },
>(
  rows: T[],
  probe: (
    direction: "before" | "after",
    ts: Date,
    boundaryId: string
  ) => Promise<{ length: number }>
): Promise<AroundCursors> {
  if (rows.length === 0) return EMPTY_AROUND_CURSORS;
  const oldest = rows[0]!;
  const newest = rows[rows.length - 1]!;
  const [older, newer] = await Promise.all([
    probe("before", oldest.createdAt, oldest.id),
    probe("after", newest.createdAt, newest.id),
  ]);
  return {
    hasMoreOlder: hasAny(older),
    hasMoreNewer: hasAny(newer),
    olderCursor: `${oldest.createdAt.getTime()}_${oldest.id}`,
    newerCursor: String(newest.createdAt.getTime()),
  };
}
