/**
 * Standalone smoke test for {@link MockReportRepository}.
 *
 * NOTE: backoffice-service has NO formal test runner configured — its
 * package.json `test` script is a no-op (`node -e "process.exit(0)"`). Rather
 * than scaffold vitest/jest for one file, this is a focused tsx script.
 *
 * Run from repo root:
 *   pnpm --filter @aimess/backoffice-service exec tsx src/repositories/__tests__/report.repository.smoke.ts
 *
 * Covers: status+type filtering, search, offset pagination math, sort + cursor
 * round-trip, getById NotFound, resolve happy path, resolve ConflictError on an
 * already-resolved report, and bulk partial success.
 */
import { ConflictError, NotFoundError } from "@aimess/errors";

import { reportFixtures } from "../__fixtures__/reports.fixture.js";
import { MockReportRepository } from "../report.repository.js";
import type { ActorRef, ResolveInput } from "../report.repository.js";
import type {
  ListReportsQuery,
  ReportStatus,
  ReportType,
} from "../../types/moderation.types.js";

// ---------------------------------------------------------------------------
// Tiny assertion harness (no external deps).
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(
    name,
    Object.is(actual, expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

/** Build a complete ListReportsQuery with sensible defaults. */
function q(overrides: Partial<ListReportsQuery> = {}): ListReportsQuery {
  return { sort: "createdAt:desc", page: 1, limit: 20, ...overrides };
}

const actor: ActorRef = {
  moderator: { id: "adm_test", name: "Test Mod" },
  at: "2026-06-03T12:00:00.000Z",
};
const resolveInput: ResolveInput = {
  resolution: "ACTION_TAKEN",
  actionOnReportedUser: "SUSPEND_7D",
  note: "smoke",
};

// Derive ground-truth expectations from the fixtures themselves.
const OPEN_STATUSES: ReportStatus[] = ["PENDING", "UNDER_REVIEW", "ESCALATED"];
const firstOpen = reportFixtures.find((r) => OPEN_STATUSES.includes(r.status))!;
const firstResolved = reportFixtures.find((r) => r.status === "RESOLVED")!;

async function main(): Promise<void> {
  // --- 1. Filtering by status + reportType --------------------------------
  console.log("\n[1] list — filter by status + reportType");
  {
    const repo = new MockReportRepository();
    const status: ReportStatus = "PENDING";
    const reportType: ReportType = "SPAM";
    const expected = reportFixtures.filter(
      (r) => r.status === status && r.reportType === reportType
    ).length;
    const res = await repo.list(
      q({ status: [status], reportType: [reportType], limit: 100 })
    );
    eq("returns only matching rows", res.data.length, expected);
    check(
      "every row matches both filters",
      res.data.every((r) => r.status === status && r.reportType === reportType)
    );
    eq(
      "pagination.total reflects filtered count",
      res.pagination.total,
      expected
    );
  }

  // --- 2. Search ----------------------------------------------------------
  console.log("\n[2] list — search");
  {
    const repo = new MockReportRepository();
    // Search by a reporter username known to be unique in the fixtures.
    const needle = firstOpen.reporterUser!.username;
    const res = await repo.list(q({ search: needle, limit: 100 }));
    check("search returns at least one match", res.data.length >= 1);
    check(
      "all results contain the search term in a searchable field",
      res.data.every((r) =>
        [
          r.reportId,
          r.reportedUser!.username,
          r.reportedUser!.displayName,
          r.reporterUser!.username,
          r.reporterUser!.displayName,
        ]
          .join(" ")
          .toLowerCase()
          .includes(needle.toLowerCase())
      )
    );
    const miss = await repo.list(
      q({ search: "zzz_no_such_token_zzz", limit: 100 })
    );
    eq("nonsense search yields zero rows", miss.data.length, 0);
  }

  // --- 3. Offset pagination math (total / totalPages / hasNext) -----------
  console.log("\n[3] offset pagination math");
  {
    const repo = new MockReportRepository();
    const total = reportFixtures.length;
    const limit = 5;

    const p1 = await repo.list(q({ page: 1, limit }));
    eq("p1 total", p1.pagination.total, total);
    eq("p1 totalPages", p1.pagination.totalPages, Math.ceil(total / limit));
    eq("p1 data length", p1.data.length, Math.min(limit, total));
    eq("p1 hasPrev is false", p1.pagination.hasPrev, false);
    eq("p1 hasNext", p1.pagination.hasNext, limit < total);
    eq("p1 mode is offset", p1.pagination.mode, "offset");

    const lastPage = Math.ceil(total / limit);
    const pLast = await repo.list(q({ page: lastPage, limit }));
    eq("last page hasNext is false", pLast.pagination.hasNext, false);
    eq("last page hasPrev is true", pLast.pagination.hasPrev, lastPage > 1);
    eq(
      "last page data length is the remainder",
      pLast.data.length,
      total - (lastPage - 1) * limit
    );
  }

  // --- 4. Sort + cursor round-trip ----------------------------------------
  console.log("\n[4] sort + cursor round-trip");
  {
    const repo = new MockReportRepository();
    const limit = 4;
    const first = await repo.list(q({ sort: "createdAt:asc", limit }));
    check(
      "first page issues a nextCursor",
      first.pagination.nextCursor !== null
    );

    const second = await repo.list(
      q({ sort: "createdAt:asc", limit, cursor: first.pagination.nextCursor! })
    );
    eq("second page mode is keyset", second.pagination.mode, "keyset");
    check("second page has rows", second.data.length > 0);

    const firstIds = new Set(first.data.map((r) => r.reportId));
    check(
      "keyset page does not repeat first-page rows",
      second.data.every((r) => !firstIds.has(r.reportId))
    );

    // Cursor continuation should equal the offset slice (rows limit..2*limit).
    const offsetP2 = await repo.list(
      q({ sort: "createdAt:asc", page: 2, limit })
    );
    check(
      "cursor page == offset page 2 (same row IDs, same order)",
      JSON.stringify(second.data.map((r) => r.reportId)) ===
        JSON.stringify(offsetP2.data.map((r) => r.reportId)),
      `cursor=${JSON.stringify(second.data.map((r) => r.reportId))} offset=${JSON.stringify(offsetP2.data.map((r) => r.reportId))}`
    );
  }

  // --- 5. getById NotFound ------------------------------------------------
  console.log("\n[5] getById");
  {
    const repo = new MockReportRepository();
    const hit = await repo.getById(firstOpen.reportId);
    check(
      "getById returns the matching row",
      hit?.reportId === firstOpen.reportId
    );
    const miss = await repo.getById("RPT-DOES-NOT-EXIST");
    eq("getById returns null for unknown id", miss, null);
  }

  // --- 6. resolve happy path ----------------------------------------------
  console.log("\n[6] resolve — happy path");
  {
    const repo = new MockReportRepository();
    const res = await repo.resolve(firstOpen.reportId, resolveInput, actor);
    eq("status becomes RESOLVED", res.status, "RESOLVED");
    eq("resolution echoed", res.resolution, resolveInput.resolution);
    eq("resolvedAt is actor timestamp", res.resolvedAt, actor.at);
    eq("moderator stamped", res.moderator.id, actor.moderator.id);
    eq("one applied action (SUSPEND_7D)", res.appliedActions.length, 1);
    eq("applied action type", res.appliedActions[0]?.type, "SUSPEND_7D");
    eq(
      "SUSPEND_7D effectiveUntil is +7d",
      res.appliedActions[0]?.effectiveUntil,
      "2026-06-10T12:00:00.000Z"
    );
    // Persistence: a re-read reflects the mutation + history append.
    const reread = await repo.getById(firstOpen.reportId);
    eq("re-read status persisted", reread?.status, "RESOLVED");
    check(
      "history gained a RESOLVED entry",
      (reread?.history ?? []).some((h) => h.action === "RESOLVED")
    );
  }

  // --- 7. resolve ConflictError on already-resolved -----------------------
  console.log("\n[7] resolve — ConflictError on already-resolved");
  {
    const repo = new MockReportRepository();
    let threw: unknown = null;
    try {
      await repo.resolve(firstResolved.reportId, resolveInput, actor);
    } catch (e) {
      threw = e;
    }
    check("throws", threw !== null);
    check("throws ConflictError", threw instanceof ConflictError);

    // And NotFound for an unknown id on a mutation.
    let nf: unknown = null;
    try {
      await repo.resolve("RPT-NOPE", resolveInput, actor);
    } catch (e) {
      nf = e;
    }
    check("unknown id throws NotFoundError", nf instanceof NotFoundError);
  }

  // --- 8. bulk partial success --------------------------------------------
  console.log("\n[8] bulkResolve — partial success");
  {
    const repo = new MockReportRepository();
    const ids = [firstOpen.reportId, firstResolved.reportId, "RPT-MISSING"];
    const res = await repo.bulkResolve(ids, resolveInput, actor);
    eq("requested count", res.requested, 3);
    eq("succeeded count", res.succeeded, 1);
    eq("failed count", res.failed, 2);

    const ok = res.results.find((r) => r.reportId === firstOpen.reportId);
    check("open report succeeded", ok?.ok === true);

    const conflict = res.results.find(
      (r) => r.reportId === firstResolved.reportId
    );
    check(
      "already-resolved item failed with REPORT_ALREADY_RESOLVED",
      conflict?.ok === false &&
        conflict.error.code === "REPORT_ALREADY_RESOLVED"
    );

    const missing = res.results.find((r) => r.reportId === "RPT-MISSING");
    check(
      "missing item failed with REPORT_NOT_FOUND",
      missing?.ok === false && missing.error.code === "REPORT_NOT_FOUND"
    );
  }

  // --- 9. communityId filtering ------------------------------------------
  // communityName is resolved live from communityId (never stored/queried),
  // so it has no filter/search/sort support of its own — only communityId does.
  console.log("\n[9] list — communityId filter");
  {
    const repo = new MockReportRepository();
    const communityRow = reportFixtures.find((r) => r.communityId !== null)!;

    // Filter by exact communityId.
    const byId = await repo.list(
      q({ communityId: communityRow.communityId!, limit: 100 })
    );
    check(
      "communityId filter returns only that community's reports",
      byId.data.length > 0 &&
        byId.data.every((r) => r.communityName === communityRow.communityName)
    );
  }

  // ---------------------------------------------------------------------------
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
