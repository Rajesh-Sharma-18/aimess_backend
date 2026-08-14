/**
 * Exactly-once claiming for due auto-delete rows.
 *
 * The sweeper used to be "find due rows, call delete, ignore the error if
 * someone else got there first". That is a read-before-write: with N replicas
 * every one of them selects the same page and every one of them runs the FULL
 * canonical delete path — N revision allocations, N tombstone broadcasts, N
 * unread recalculations — and the only thing preventing visible damage was that
 * the last writer happened to win. Duplicate delivery to a client is harmless;
 * duplicate *business* side effects are not.
 *
 * The fix is a lease, not a lock. Three round trips per batch, whatever the
 * batch size:
 *
 *   1. read a page of due, un-leased candidates;
 *   2. `updateMany` those ids to a token unique to this call, re-asserting the
 *      "un-leased and not deleted" predicate — MongoDB re-evaluates that
 *      predicate under a document-level lock as it applies each update, so of
 *      N racing workers exactly one writes its token to any given row;
 *   3. read back the rows carrying OUR token — that set, and only that set, is
 *      ours to delete.
 *
 * A worker that dies mid-delete leaves its token behind; the row becomes
 * claimable again once `autoDeleteClaimedAt` is older than the lease. A row
 * that COMPLETED can never be reclaimed because the delete sets `isDeleted`,
 * which the due query excludes. A row that keeps failing gets exponential
 * backoff via `autoDeleteNextAttemptAt` instead of being retried every tick.
 *
 * Private and group share this file verbatim — the two collections have
 * identical claim columns, so a divergence between them would be a bug, not a
 * design choice.
 */

/** Default lease: a worker gets this long to finish a delete before the row is re-offered. */
export const AUTO_DELETE_CLAIM_LEASE_SEC = 120;

/** First retry delay for a row whose delete threw; doubles per attempt. */
export const AUTO_DELETE_RETRY_BASE_SEC = 60;

/** Ceiling for that doubling — a hopeless row is retried hourly, not hourly-squared. */
export const AUTO_DELETE_RETRY_MAX_SEC = 3600;

/** Attempts after which the row is considered stuck and logged at warn on every claim. */
export const AUTO_DELETE_STUCK_ATTEMPTS = 5;

/** One row this worker owns for the duration of its lease. */
export interface ClaimedAutoDelete {
  id: string;
  roomId: string;
  senderId: string | null;
  /** How many times this row has now been claimed (1 on the first attempt). */
  attempts: number;
}

/**
 * The slice of a Prisma model delegate this module needs. Structural, so
 * `prisma.privateMessage` and `prisma.groupMessage` both satisfy it without
 * either repository importing the other's generated types.
 */
export interface AutoDeleteClaimDelegate {
  findMany(args: Record<string, unknown>): Promise<
    Array<{
      id: string;
      roomId: string;
      senderId: string | null;
      autoDeleteAttempts?: number | null;
    }>
  >;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  update(args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Rows whose deadline has passed AND whose backoff (if any) has elapsed.
 *
 * `not: null` on `autoDeleteAt` is LOAD-BEARING, not defensive noise: on
 * MongoDB a `lte` comparison against a nullable DateTime also matches rows
 * whose value is explicitly `null`, because BSON orders Null before Date and
 * the comparison is not type-bracketed. Every message we write sets
 * `autoDeleteAt: null` when it has no timer, so a bare `{lte: now}` selects
 * EVERY ordinary message as due. That shipped once and destroyed 53 messages on
 * the dev database — do not "simplify" it away.
 *
 * `autoDeleteNextAttemptAt` is filtered with an explicit `OR` against null for
 * the opposite reason: relying on "lte also matches null" to let never-failed
 * rows through would make the whole sweeper stop the day that quirk changes.
 */
function dueConditions(now: Date): Array<Record<string, unknown>> {
  return [
    { autoDeleteAt: { not: null } },
    { autoDeleteAt: { lte: now } },
    {
      OR: [
        { autoDeleteNextAttemptAt: null },
        { autoDeleteNextAttemptAt: { lte: now } },
      ],
    },
  ];
}

/**
 * "Nobody holds this row" — never claimed, or claimed by a worker whose lease
 * has run out. The `not: null` guard on the stale branch keeps a never-claimed
 * row from matching `lt` through the same Null-orders-first quirk documented
 * above; it would be harmless here (the first branch already covers it) but the
 * predicate is also re-evaluated on the write, where precision matters.
 */
function claimableCondition(leaseCutoff: Date): Record<string, unknown> {
  return {
    OR: [
      { autoDeleteClaimToken: null },
      {
        AND: [
          { autoDeleteClaimedAt: { not: null } },
          { autoDeleteClaimedAt: { lt: leaseCutoff } },
        ],
      },
    ],
  };
}

/**
 * Claim up to `limit` due rows for this worker. Returns only the rows this call
 * actually won — a caller may run the canonical delete path for each of them
 * and nothing else.
 */
export async function claimDueAutoDeletes(
  delegate: AutoDeleteClaimDelegate,
  params: {
    now: Date;
    limit: number;
    /** Unique per call — a v4 uuid in production, a fixed string in tests. */
    token: string;
    leaseSeconds?: number;
  }
): Promise<ClaimedAutoDelete[]> {
  const { now, limit, token } = params;
  const leaseCutoff = new Date(
    now.getTime() - (params.leaseSeconds ?? AUTO_DELETE_CLAIM_LEASE_SEC) * 1000
  );

  // 1. Candidates. Oldest deadline first so a backlog drains in the order it
  //    accrued rather than starving the earliest expiries.
  const candidates = await delegate.findMany({
    where: {
      isDeleted: false,
      AND: [...dueConditions(now), claimableCondition(leaseCutoff)],
    },
    orderBy: { autoDeleteAt: "asc" },
    take: limit,
    select: { id: true },
  });
  if (candidates.length === 0) return [];

  // 2. Stamp our token, re-asserting the predicate. Losers simply don't match.
  await delegate.updateMany({
    where: {
      id: { in: candidates.map((c) => c.id) },
      isDeleted: false,
      AND: [claimableCondition(leaseCutoff)],
    },
    data: {
      autoDeleteClaimToken: token,
      autoDeleteClaimedAt: now,
      autoDeleteAttempts: { increment: 1 },
    },
  });

  // 3. Whatever carries our token is ours. Reading back rather than trusting
  //    the update count is what makes this safe: the count says HOW MANY we
  //    won, never WHICH.
  const claimed = await delegate.findMany({
    where: { autoDeleteClaimToken: token },
    select: {
      id: true,
      roomId: true,
      senderId: true,
      autoDeleteAttempts: true,
    },
  });

  return claimed.map((row) => ({
    id: row.id,
    roomId: row.roomId,
    senderId: row.senderId,
    attempts: row.autoDeleteAttempts ?? 1,
  }));
}

/** Exponential, capped backoff for the Nth failed attempt at a row. */
export function autoDeleteRetryDelaySec(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(
    AUTO_DELETE_RETRY_MAX_SEC,
    AUTO_DELETE_RETRY_BASE_SEC * 2 ** (n - 1)
  );
}

/**
 * Hand a row back after a failed delete: drop our token so another worker may
 * take it, record why, and hold it out of the due query for the backoff window.
 *
 * Deliberately best-effort — if THIS write also fails, the row stays claimed
 * and the lease expiry recovers it, which is the same outcome one tick later.
 */
export async function releaseAutoDeleteClaim(
  delegate: AutoDeleteClaimDelegate,
  params: { id: string; attempts: number; error: string; now: Date }
): Promise<void> {
  const delaySec = autoDeleteRetryDelaySec(params.attempts);
  await delegate.update({
    where: { id: params.id },
    data: {
      autoDeleteClaimToken: null,
      autoDeleteClaimedAt: null,
      autoDeleteNextAttemptAt: new Date(
        params.now.getTime() + delaySec * 1000
      ),
      autoDeleteLastError: params.error.slice(0, 500),
    },
  });
}
