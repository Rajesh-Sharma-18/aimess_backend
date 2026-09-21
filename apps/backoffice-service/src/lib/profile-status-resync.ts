/**
 * Re-sends every moderated account's status to user-service.
 *
 * `mirrorProfileStatus` is fire-and-forget by design — the ban has already
 * landed in auth-service and must not be rolled back because user-service
 * blipped — so a lost gRPC call leaves `UserProfile.status` stuck on whatever
 * it was before, with nothing to notice. That was invisible while user-service
 * did nothing with the column; now that people discovery excludes BANNED rows,
 * a stale mirror means a banned account stays searchable to normal users.
 *
 * Accounts banned before `mirrorProfileStatus` existed at all have the same
 * signature, so this is also the one-time repair for them.
 *
 * admin_db's `UserIndex` is the authoritative moderation status (see
 * `resolveModerationStatus`), so the whole replay reads from this service's own
 * database and writes through the same `AdminSetProfileStatus` RPC a live ban
 * uses — no second code path to keep in step.
 *
 * Idempotent: the RPC is an `updateMany` to a fixed value, so re-running writes
 * the same status again. A dry run only READS admin_db — the RPC, the one
 * write, is never called.
 *
 * Entry point: src/scripts/resync-profile-status-mirror.ts.
 */

const MIRRORED = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  BANNED: "BANNED",
} as const;

type MirroredStatus = keyof typeof MIRRORED;

/**
 * `UserProfile.userId` is `@db.Uuid`, so a non-UUID id cannot match a profile —
 * it can only make Prisma throw inside user-service. The dev seed writes
 * `UserIndex` rows with synthetic ids like `u_seed_32`, and without this guard
 * each one is a gRPC INTERNAL that counts against the circuit breaker until it
 * opens and fails every REAL user still queued behind them.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProfileStatusResyncDeps {
  /** The one read: a keyset page of `UserIndex`. */
  findUserIndexPage(args: {
    cursor: string | undefined;
    take: number;
    statuses: MirroredStatus[];
  }): Promise<{ userId: string; status: string }[]>;
  /**
   * The one write. Never called on a dry run. `ok: false` means user-service
   * answered but wrote nothing (USER_NOT_FOUND: no live profile).
   */
  setProfileStatus(
    userId: string,
    status: MirroredStatus
  ): Promise<{ ok: boolean; errorCode: string }>;
  log(line: string): void;
  logError(line: string): void;
}

export interface ProfileStatusResyncResult {
  counts: Record<MirroredStatus, number>;
  skipped: number;
  /** Applied but not written: user-service has no live profile for the id. */
  noProfile: number;
  failed: number;
}

export async function resyncProfileStatusMirror(
  deps: ProfileStatusResyncDeps,
  { apply, batchSize = 500 }: { apply: boolean; batchSize?: number }
): Promise<ProfileStatusResyncResult> {
  let cursor: string | undefined;
  const counts: Record<MirroredStatus, number> = {
    ACTIVE: 0,
    SUSPENDED: 0,
    BANNED: 0,
  };
  let skipped = 0;
  let noProfile = 0;
  let failed = 0;

  for (;;) {
    const rows = await deps.findUserIndexPage({
      cursor,
      take: batchSize,
      statuses: Object.keys(MIRRORED) as MirroredStatus[],
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.userId;

    for (const row of rows) {
      if (!UUID.test(row.userId)) {
        skipped++;
        continue;
      }
      const status = MIRRORED[row.status as MirroredStatus];
      // Dry run: what WOULD be sent. Apply: only what user-service confirmed.
      if (!apply) {
        counts[status]++;
        continue;
      }
      // Sequential on purpose: this is a repair, not a hot path, and fanning
      // hundreds of gRPC calls at user-service to save a few seconds is how a
      // backfill takes down the service it is repairing.
      try {
        const res = await deps.setProfileStatus(row.userId, status);
        if (res.ok) {
          counts[status]++;
        } else if (res.errorCode === "USER_NOT_FOUND") {
          // Nothing to mirror onto (profile never created, or soft-deleted and
          // terminal) — reported, but not a failure a re-run could fix.
          noProfile++;
        } else {
          failed++;
          deps.logError(`  ${row.userId} (${status}): ${res.errorCode}`);
        }
      } catch (err) {
        failed++;
        deps.logError(`  ${row.userId} (${status}): ${String(err)}`);
      }
    }
  }

  // A partial failure must not read as success: the header says so, and the
  // entry point turns `failed` into a non-zero exit code.
  deps.log(
    !apply
      ? "DRY RUN — would resync"
      : failed > 0
        ? "RESYNC INCOMPLETE — attempted"
        : "RESYNCED"
  );
  for (const [status, count] of Object.entries(counts)) {
    deps.log(`  ${status.padEnd(9)} ${count}`);
  }
  if (skipped > 0) {
    deps.log(`  ${skipped} skipped (id is not a profile UUID)`);
  }
  if (noProfile > 0) {
    deps.log(`  ${noProfile} not written (no live profile in user-service)`);
  }
  if (apply && failed > 0) {
    deps.log(`  ${failed} failed — safe to re-run.`);
  }
  if (!apply) deps.log("Re-run with --apply to write.");

  return { counts, skipped, noProfile, failed };
}
