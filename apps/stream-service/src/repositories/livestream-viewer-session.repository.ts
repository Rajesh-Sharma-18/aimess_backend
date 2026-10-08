import type { Prisma, PrismaClient } from "../generated/prisma/index.js";

const SESSIONS = "livestream_viewer_sessions";
const VIEWERS = "livestream_viewers";

/**
 * How long a DISCONNECTED session stays resumable by the same device. Equal to
 * the gateway's Socket.IO `connectionStateRecovery.maxDisconnectionDuration`:
 * a reconnect inside it is, to the platform, the same connection — a page
 * refresh or a network blip must not split one viewing into two sessions.
 */
const RECONNECT_GRACE_MS = 2 * 60 * 1000;

/** How one device session ended. Internal — the admin list shows {@link ViewerEndReason}. */
export type ViewerSessionEndReason =
  | "LEFT"
  | "DISCONNECTED"
  | "STREAM_ENDED"
  | "REMOVED";

/**
 * How a user's participation ended: LEFT when their last session closed while
 * the stream was still running (a leave, a drop, a ban); ENDED when the stream
 * itself ended while they were still watching. Set once, at that moment — a
 * later stream end never turns LEFT into ENDED.
 */
export type ViewerEndReason = "LEFT" | "ENDED";

export type ViewerStatusFilter = "ALL" | "ACTIVE" | "LEFT" | "ENDED";

export interface ViewerRow {
  id: string;
  userId: string;
  joinedAt: Date;
  /** null while the user has at least one active session. */
  leftAt: Date | null;
  endReason: string | null;
  /** Closed stretches only; the caller adds the running one. */
  watchDurationSeconds: number;
  /** Start of the current active stretch; null when not active. */
  lastJoinedAt: Date | null;
}

/** A document as `$runCommandRaw` returns it — extended JSON. */
type RawSession = {
  _id: { $oid: string };
  joinedAt: unknown;
  connections?: unknown;
  authSessionId?: string | null;
};

function computeSeconds(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

/** `device` is the auth session id, or "host" for the stream's one host session. */
const openKeyOf = (livestreamId: string, userId: string, device: string) =>
  `${livestreamId}:${userId}:${device}`;

const asDate = (value: Date) => ({ $date: value.toISOString() });
// Explicit int32 — a bare JSON number may land as a double/long, which Prisma
// then refuses to read back into an `Int` field.
const asInt = (value: number) => ({ $numberInt: String(value) });

/** Whole seconds from a date field to `at`, never negative (aggregation expression). */
const secondsSince = (field: string, at: { $date: string }) => ({
  $max: [
    asInt(0),
    {
      $toInt: {
        $round: [{ $divide: [{ $subtract: [at, field] }, 1000] }, 0],
      },
    },
  ],
});

function readNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    return Number(Object.values(value)[0]);
  }
  return 0;
}

function readDate(value: unknown): Date {
  const raw = (value as { $date?: unknown } | null)?.$date ?? value;
  if (raw && typeof raw === "object" && !(raw instanceof Date)) {
    return new Date(Number(Object.values(raw)[0]));
  }
  return new Date(raw as string | Date);
}

function isDuplicateKey(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === "P2002" || String(e?.message ?? "").includes("E11000");
}

/**
 * Viewer tracking on two levels:
 *
 *  - SESSION (`livestream_viewer_sessions`): one per device login, with its own
 *    join/leave time and lifecycle. Internal — it is what tells whether the
 *    user is still watching from anywhere.
 *  - PARTICIPATION (`livestream_viewers`): one per livestream + user (unique
 *    index, server.ts). Counts the user's open sessions and is what the admin
 *    viewer list reads: ACTIVE while any session is open, LEFT/ENDED only once
 *    none is. A rejoin reopens this same record — never a second one.
 *
 * Every session open/close moves the participation counter by one, so the two
 * levels stay consistent in any arrival order (increments commute).
 */
export class LivestreamViewerSessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Single-document atomic update, returning the document AFTER it (or null
   * when nothing matched). Raw on purpose: Prisma's MongoDB `update`/
   * `updateMany` read the matching ids first and write by id afterwards, so a
   * filter like "still at zero connections" would not hold at write time.
   */
  private async findAndModify(
    collection: string,
    query: Prisma.InputJsonObject,
    update: Prisma.InputJsonObject | Prisma.InputJsonArray,
    options: { sort?: Prisma.InputJsonObject; upsert?: boolean } = {}
  ): Promise<RawSession | null> {
    const res = (await this.prisma.$runCommandRaw({
      findAndModify: collection,
      query,
      update,
      new: true,
      ...(options.sort ? { sort: options.sort } : {}),
      ...(options.upsert ? { upsert: true } : {}),
    })) as { value?: RawSession | null };
    return res.value ?? null;
  }

  // ── Session level ─────────────────────────────────────────────────────────

  /**
   * One socket of a device entered the stream.
   *
   * Viewer: a device already watching gains a connection (another tab of the
   * same login); one that dropped within {@link RECONNECT_GRACE_MS} resumes its
   * DISCONNECTED session; otherwise a new session starts. Another device of the
   * same user never touches this one.
   *
   * Host: one session per stream whatever the device or the reconnects; only
   * the stream's end closes it (see {@link closeAllOpenForStream}).
   *
   * A session that (re)opens makes the user's participation ACTIVE.
   */
  async recordJoin(p: {
    livestreamId: string;
    userId: string;
    authSessionId: string;
    isHost: boolean;
  }): Promise<void> {
    const openKey = openKeyOf(
      p.livestreamId,
      p.userId,
      p.isHost ? "host" : p.authSessionId
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const open = await this.findAndModify(
        SESSIONS,
        { openKey },
        { $inc: { connections: asInt(p.isHost ? 0 : 1) } }
      );
      if (open) {
        // A host session opened at go-live by SRS has no device until the
        // host's own app connects.
        if (p.isHost && p.authSessionId && !open.authSessionId) {
          await this.prisma.livestreamViewerSession.update({
            where: { id: open._id.$oid },
            data: { authSessionId: p.authSessionId },
          });
        }
        return;
      }
      try {
        if (!p.isHost && p.authSessionId && (await this.resume(p, openKey))) {
          await this.openParticipation(p.livestreamId, p.userId);
          return;
        }
        await this.prisma.livestreamViewerSession.create({
          data: {
            livestreamId: p.livestreamId,
            userId: p.userId,
            ...(p.authSessionId ? { authSessionId: p.authSessionId } : {}),
            openKey,
            connections: p.isHost ? 0 : 1,
          },
        });
        await this.openParticipation(p.livestreamId, p.userId);
        return;
      } catch (error) {
        // Another socket of this device opened the session first — join it.
        if (!isDuplicateKey(error)) throw error;
      }
    }
  }

  private async resume(
    p: { livestreamId: string; userId: string; authSessionId: string },
    openKey: string
  ): Promise<boolean> {
    const resumed = await this.findAndModify(
      SESSIONS,
      {
        livestreamId: p.livestreamId,
        userId: p.userId,
        authSessionId: p.authSessionId,
        endReason: "DISCONNECTED",
        leftAt: { $gte: asDate(new Date(Date.now() - RECONNECT_GRACE_MS)) },
      },
      {
        $set: { openKey, connections: asInt(1) },
        $unset: { leftAt: "", endReason: "", watchDurationSeconds: "" },
      },
      { sort: { leftAt: -1 } }
    );
    return resumed !== null;
  }

  /**
   * One socket of a device left. The session closes — LEFT on an explicit
   * leave, DISCONNECTED on a dropped socket — only once the device has no
   * socket left in the room, so closing one tab never ends a session another
   * tab still feeds. No-op without an open session (duplicate leave, a leave
   * for a stream never joined) and always for the host, whose session is keyed
   * apart from any device and ends with the stream.
   */
  async recordLeave(p: {
    livestreamId: string;
    userId: string;
    authSessionId: string;
    reason: "LEFT" | "DISCONNECTED";
  }): Promise<boolean> {
    const openKey = openKeyOf(p.livestreamId, p.userId, p.authSessionId);
    const open = await this.findAndModify(
      SESSIONS,
      { openKey },
      { $inc: { connections: asInt(-1) } }
    );
    if (!open || readNumber(open.connections) > 0) return false;

    const leftAt = new Date();
    // Still at zero: a socket of this device that joined in between keeps the
    // session open.
    const closed = await this.findAndModify(
      SESSIONS,
      { _id: open._id, openKey, connections: { $lte: 0 } },
      {
        $set: {
          leftAt: asDate(leftAt),
          endReason: p.reason,
          watchDurationSeconds: asInt(
            computeSeconds(readDate(open.joinedAt), leftAt)
          ),
        },
        $unset: { openKey: "" },
      }
    );
    if (!closed) return false;
    await this.releaseParticipation(p.livestreamId, p.userId, 1, leftAt);
    return true;
  }

  /** Ban-kick: every device session of the user ends at once. */
  async closeAllOpenForUser(
    livestreamId: string,
    userId: string,
    endedAt: Date
  ): Promise<number> {
    const closed = await this.closeOpenSessions(
      {
        livestreamId,
        userId,
        openKey: { $ne: openKeyOf(livestreamId, userId, "host") },
      },
      endedAt,
      "REMOVED"
    );
    if (closed > 0) {
      await this.releaseParticipation(livestreamId, userId, closed, endedAt);
    }
    return closed;
  }

  /**
   * Close every still-open session — host included — when a stream ends
   * (owner stop, SRS on_unpublish, admin force-end, stale-heartbeat sweeper),
   * so an unexpected disconnect never leaves one open forever. Only users
   * still active at this moment become ENDED; anyone who had already LEFT is
   * not touched (`activeSessions > 0` excludes them).
   */
  async closeAllOpenForStream(
    livestreamId: string,
    endedAt: Date
  ): Promise<number> {
    const closed = await this.closeOpenSessions(
      { livestreamId },
      endedAt,
      "STREAM_ENDED"
    );
    const at = asDate(endedAt);
    await this.prisma.$runCommandRaw({
      update: VIEWERS,
      updates: [
        {
          q: { livestreamId, activeSessions: { $gt: 0 } },
          u: [
            {
              $set: {
                activeSessions: asInt(0),
                leftAt: at,
                endReason: "ENDED",
                watchDurationSeconds: {
                  $add: [
                    "$watchDurationSeconds",
                    secondsSince("$lastJoinedAt", at),
                  ],
                },
              },
            },
            { $unset: "lastJoinedAt" },
          ],
          multi: true,
        },
      ],
    });
    return closed;
  }

  /**
   * One server-side update for every matching open session, each row's
   * duration computed by Mongo — a stream ending with thousands watching is a
   * single round trip, not one write per viewer.
   */
  private async closeOpenSessions(
    filter: Prisma.InputJsonObject,
    endedAt: Date,
    reason: ViewerSessionEndReason
  ): Promise<number> {
    const at = asDate(endedAt);
    const res = (await this.prisma.$runCommandRaw({
      update: SESSIONS,
      updates: [
        {
          // A raw `leftAt: null` matches an ABSENT field, unlike Prisma's.
          q: { ...filter, leftAt: null },
          u: [
            {
              $set: {
                leftAt: at,
                endReason: reason,
                connections: asInt(0),
                watchDurationSeconds: secondsSince("$joinedAt", at),
              },
            },
            { $unset: "openKey" },
          ],
          multi: true,
        },
      ],
    })) as { nModified?: unknown };
    return readNumber(res.nModified);
  }

  // ── Participation level ───────────────────────────────────────────────────

  /**
   * A session of the user opened: find-or-create the user's one participation
   * record and count it. Going from no open session to one starts a new active
   * stretch and clears Left At; the first join time is kept for good.
   */
  private async openParticipation(
    livestreamId: string,
    userId: string
  ): Promise<void> {
    const now = asDate(new Date());
    const wasActive = { $gt: [{ $ifNull: ["$activeSessions", 0] }, 0] };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.findAndModify(
          VIEWERS,
          { livestreamId, userId },
          [
            {
              $set: {
                joinedAt: { $ifNull: ["$joinedAt", now] },
                lastJoinedAt: { $cond: [wasActive, "$lastJoinedAt", now] },
                activeSessions: {
                  $add: [{ $ifNull: ["$activeSessions", asInt(0)] }, asInt(1)],
                },
                watchDurationSeconds: {
                  $ifNull: ["$watchDurationSeconds", asInt(0)],
                },
              },
            },
            { $unset: ["leftAt", "endReason"] },
          ],
          { upsert: true }
        );
        return;
      } catch (error) {
        // Two first joins raced on the unique (livestreamId, userId) index.
        if (!isDuplicateKey(error)) throw error;
      }
    }
  }

  /**
   * `count` sessions of the user closed while the stream runs. Only when none
   * is left does the participation end — as LEFT, Left At stamped and the
   * stretch added to the duration. (The stream's own end is ENDED, see
   * {@link closeAllOpenForStream}.)
   */
  private async releaseParticipation(
    livestreamId: string,
    userId: string,
    count: number,
    at: Date
  ): Promise<void> {
    const reason: ViewerEndReason = "LEFT";
    const when = asDate(at);
    const ending = { $lte: ["$activeSessions", asInt(count)] };
    await this.findAndModify(
      VIEWERS,
      { livestreamId, userId, activeSessions: { $gt: 0 } },
      [
        {
          $set: {
            activeSessions: {
              $max: [
                asInt(0),
                { $subtract: ["$activeSessions", asInt(count)] },
              ],
            },
            leftAt: { $cond: [ending, when, "$leftAt"] },
            endReason: { $cond: [ending, reason, "$endReason"] },
            watchDurationSeconds: {
              $cond: [
                ending,
                {
                  $add: [
                    "$watchDurationSeconds",
                    secondsSince("$lastJoinedAt", when),
                  ],
                },
                "$watchDurationSeconds",
              ],
            },
            lastJoinedAt: { $cond: [ending, "$$REMOVE", "$lastJoinedAt"] },
          },
        },
      ]
    );
  }

  /**
   * Paginated participation list for the admin viewer table — exactly one row
   * per user, however many devices or rejoins. `total` counts rows matching
   * `status`.
   */
  async listByStream(
    livestreamId: string,
    params: {
      skip: number;
      take: number;
      sortField: "joinedAt" | "watchDurationSeconds";
      sortDir: "asc" | "desc";
      status: ViewerStatusFilter;
    }
  ): Promise<{ rows: ViewerRow[]; total: number }> {
    // `{ isSet: false }`, NEVER `{ leftAt: null }` — an active participation
    // has no `leftAt` at all, and Prisma's MongoDB connector does not match an
    // absent field with `equals: null`. `endReason` exists only once ended.
    const where =
      params.status === "ACTIVE"
        ? { livestreamId, leftAt: { isSet: false } }
        : params.status === "ALL"
          ? { livestreamId }
          : { livestreamId, endReason: params.status };
    const [rows, total] = await Promise.all([
      this.prisma.livestreamViewer.findMany({
        where,
        orderBy: [
          params.sortField === "watchDurationSeconds"
            ? { watchDurationSeconds: params.sortDir }
            : { joinedAt: params.sortDir },
          { id: params.sortDir },
        ],
        skip: params.skip,
        take: params.take,
        select: {
          id: true,
          userId: true,
          joinedAt: true,
          leftAt: true,
          endReason: true,
          watchDurationSeconds: true,
          lastJoinedAt: true,
        },
      }),
      this.prisma.livestreamViewer.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * Distinct-viewer count for one stream — the admin detail's viewer count,
   * and always equal to the viewer list's unfiltered total.
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
   * list screen so `viewerCount` matches the per-stream count without an N+1
   * query per row.
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
