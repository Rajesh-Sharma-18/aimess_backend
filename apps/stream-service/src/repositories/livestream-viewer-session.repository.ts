import type { PrismaClient } from "../generated/prisma/index.js";

function computeSeconds(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

export class LivestreamViewerSessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Record a join. Idempotent per (livestreamId, userId): if the user already
   * has an OPEN session (no `leftAt`) for this stream, its id is reused instead
   * of creating a duplicate — covers reconnects and duplicate `stream:join`
   * calls (e.g. a client re-emitting join before its leave fired).
   */
  async recordJoin(livestreamId: string, userId: string): Promise<string> {
    // `{ isSet: false }`, NEVER `{ leftAt: null }` — `leftAt` is left UNSET
    // (absent) on create, not explicitly null, and Prisma's MongoDB connector
    // does not match an absent optional field with an `equals: null` filter
    // (same idiom as `deletedAt: { isSet: false }` in community.repository.ts).
    const existing = await this.prisma.livestreamViewerSession.findFirst({
      where: { livestreamId, userId, leftAt: { isSet: false } },
      orderBy: { joinedAt: "desc" },
    });
    if (existing) return existing.id;

    const created = await this.prisma.livestreamViewerSession.create({
      data: { livestreamId, userId },
    });
    return created.id;
  }

  /**
   * Close the user's most recent OPEN session for this stream (leave,
   * disconnect, or ban-kick). No-op success when there is no open session —
   * leave events can legitimately arrive without a matching open join (e.g. a
   * duplicate `stream:leave`, or a leave for a stream the socket never
   * successfully joined).
   */
  async recordLeave(livestreamId: string, userId: string): Promise<boolean> {
    // See recordJoin's comment — `{ isSet: false }`, not `{ leftAt: null }`.
    const open = await this.prisma.livestreamViewerSession.findFirst({
      where: { livestreamId, userId, leftAt: { isSet: false } },
      orderBy: { joinedAt: "desc" },
    });
    if (!open) return false;

    const leftAt = new Date();
    await this.prisma.livestreamViewerSession.update({
      where: { id: open.id },
      data: {
        leftAt,
        watchDurationSeconds: computeSeconds(open.joinedAt, leftAt),
      },
    });
    return true;
  }

  /**
   * Bulk close-out for every still-open session when a stream ends (owner
   * stop, SRS on_unpublish, admin force-end, stale-heartbeat sweeper) so no
   * session is left open forever after an unexpected disconnect. Non-atomic
   * read-then-update loop — bounded by the stream's viewer count, the same
   * trade-off already accepted elsewhere in this codebase (e.g. the reaction
   * toggle's non-atomic read-modify-write) at current scale.
   */
  async closeAllOpenForStream(
    livestreamId: string,
    endedAt: Date
  ): Promise<number> {
    // See recordJoin's comment — `{ isSet: false }`, not `{ leftAt: null }`.
    const open = await this.prisma.livestreamViewerSession.findMany({
      where: { livestreamId, leftAt: { isSet: false } },
      select: { id: true, joinedAt: true },
    });
    if (open.length === 0) return 0;

    await Promise.all(
      open.map((s) =>
        this.prisma.livestreamViewerSession.update({
          where: { id: s.id },
          data: {
            leftAt: endedAt,
            watchDurationSeconds: computeSeconds(s.joinedAt, endedAt),
          },
        })
      )
    );
    return open.length;
  }

  /**
   * Paginated, PER-USER viewer history for the admin "Livestream User List"
   * screen. A user who rejoined the same stream has multiple underlying
   * `LivestreamViewerSession` rows (by design — see the model doc); this
   * aggregates them into one entry per user via a MongoDB `groupBy`:
   *   - joinedAt  = earliest session's joinedAt (`_min`)
   *   - leftAt    = latest session's leftAt (`_max`), but null while the user
   *                 has any currently-open session (still watching)
   *   - watchDurationSeconds = sum of every CLOSED session's duration
   *     (`_sum`, nulls from open sessions are excluded by Mongo's `$sum`); the
   *     currently-open session's live elapsed time is layered on by the
   *     caller, same as the pre-aggregation behavior for a single open row.
   * `total` is the count of DISTINCT users, not raw session rows.
   */
  async listByStream(
    livestreamId: string,
    params: {
      skip: number;
      take: number;
      sortField: "joinedAt" | "watchDurationSeconds";
      sortDir: "asc" | "desc";
    }
  ): Promise<{
    rows: Array<{
      userId: string;
      joinedAt: Date;
      leftAt: Date | null;
      watchDurationSeconds: number;
      /** Currently-open session's joinedAt, for live-elapsed-time top-up by the caller; null when the user has no open session. */
      openSessionJoinedAt: Date | null;
    }>;
    total: number;
  }> {
    // A single-key orderBy — Prisma's groupBy typing ties each orderBy key to
    // the "by" list, and rejects a userId tiebreaker here since "userId" is
    // the group key, not an aggregate; ties are rare enough (same joinedAt or
    // watchDurationSeconds down to the second/ms) that stability isn't worth
    // fighting the type checker for. Kept inline (not hoisted to a separately
    // pre-annotated variable) — an explicit `OrderByWithAggregationInput`
    // annotation widens the union and Prisma's groupBy typing then can't tell
    // which variant it is, forcing every possible field into "by".
    const grouped = await this.prisma.livestreamViewerSession.groupBy({
      by: ["userId"],
      where: { livestreamId },
      _min: { joinedAt: true },
      _max: { leftAt: true },
      _sum: { watchDurationSeconds: true },
      orderBy:
        params.sortField === "watchDurationSeconds"
          ? { _sum: { watchDurationSeconds: params.sortDir } }
          : { _min: { joinedAt: params.sortDir } },
      skip: params.skip,
      take: params.take,
    });
    const distinctUsers = await this.prisma.livestreamViewerSession.findMany({
      where: { livestreamId },
      distinct: ["userId"],
      select: { userId: true },
    });

    if (grouped.length === 0) {
      return { rows: [], total: distinctUsers.length };
    }

    // See recordJoin's comment — `{ isSet: false }`, not `{ leftAt: null }`.
    const userIds = grouped.map((g) => g.userId);
    const openSessions = await this.prisma.livestreamViewerSession.findMany({
      where: {
        livestreamId,
        userId: { in: userIds },
        leftAt: { isSet: false },
      },
      select: { userId: true, joinedAt: true },
    });
    const openJoinedAtByUser = new Map(
      openSessions.map((s) => [s.userId, s.joinedAt])
    );

    const rows = grouped.map((g) => {
      const openJoinedAt = openJoinedAtByUser.get(g.userId) ?? null;
      return {
        userId: g.userId,
        joinedAt: g._min.joinedAt ?? openJoinedAt ?? new Date(0),
        leftAt: openJoinedAt ? null : (g._max.leftAt ?? null),
        watchDurationSeconds: g._sum.watchDurationSeconds ?? 0,
        openSessionJoinedAt: openJoinedAt,
      };
    });

    return { rows, total: distinctUsers.length };
  }

  /**
   * Distinct-viewer count for one stream — the SAME dedupe `listByStream`
   * already does for `total`, without paging through the rows. This is the
   * number that must equal the admin viewer list's total, so callers needing
   * a "viewer count" for a single stream (e.g. the detail screen) should use
   * this instead of the raw `totalViews` join-attempt counter.
   */
  async countDistinctUsers(livestreamId: string): Promise<number> {
    const distinctUsers = await this.prisma.livestreamViewerSession.findMany({
      where: { livestreamId },
      distinct: ["userId"],
      select: { userId: true },
    });
    return distinctUsers.length;
  }

  /**
   * Batch distinct-viewer counts, keyed by livestreamId — used by the admin
   * list screen so `viewerCount` matches the per-stream viewer list total
   * without an N+1 query per row.
   */
  async countDistinctUsersByStreamIds(
    livestreamIds: string[]
  ): Promise<Map<string, number>> {
    if (livestreamIds.length === 0) return new Map();
    const rows = await this.prisma.livestreamViewerSession.findMany({
      where: { livestreamId: { in: livestreamIds } },
      distinct: ["livestreamId", "userId"],
      select: { livestreamId: true },
    });
    const counts = new Map<string, number>();
    for (const r of rows) {
      counts.set(r.livestreamId, (counts.get(r.livestreamId) ?? 0) + 1);
    }
    return counts;
  }
}
