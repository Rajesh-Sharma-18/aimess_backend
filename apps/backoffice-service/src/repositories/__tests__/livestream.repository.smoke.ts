/**
 * Standalone smoke test for {@link MockLivestreamRepository}.
 *
 * NOTE: backoffice-service has NO formal test runner configured — its
 * package.json `test` script is a no-op (`node -e "process.exit(0)"`). Rather
 * than scaffold vitest/jest for one file, this is a focused tsx script.
 *
 * Run from repo root:
 *   pnpm --filter @aimess/backoffice-service exec tsx src/repositories/__tests__/livestream.repository.smoke.ts
 *
 * Covers: status+category filtering, search, offset pagination math, sort +
 * cursor round-trip, getById NotFound, listReports 404 on unknown stream,
 * end() happy path, end() ConflictError on an already-ended stream, and bulkEnd
 * partial success.
 */
import { ConflictError, NotFoundError } from "@aimess/errors";

import { livestreamFixtures } from "../__fixtures__/livestreams.fixture.js";
import { MockLivestreamRepository } from "../livestream.repository.js";
import type { ActorRef, EndInput } from "../livestream.repository.js";
import type {
  ListLivestreamsQuery,
  LivestreamStatus,
} from "../../types/livestream.types.js";

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

/** Build a complete ListLivestreamsQuery with sensible defaults. */
function q(
  overrides: Partial<ListLivestreamsQuery> = {}
): ListLivestreamsQuery {
  return { sort: "createdAt:desc", page: 1, limit: 20, ...overrides };
}

const actor: ActorRef = {
  admin: { id: "adm_test", name: "Test Mod" },
  at: "2026-06-03T12:00:00.000Z",
};
const endInput: EndInput = {
  reasonCode: "POLICY_VIOLATION",
  note: "smoke",
  notifyCreator: true,
  issueStrike: true,
};

// Derive ground-truth expectations from the fixtures themselves.
const firstLive = livestreamFixtures.find((r) => r.status === "LIVE")!;
const firstEnded = livestreamFixtures.find((r) => r.status === "ENDED")!;
const streamWithReports = livestreamFixtures.find((r) => r.reportCount > 0)!;

async function main(): Promise<void> {
  // --- 1. Filtering by status + category ----------------------------------
  console.log("\n[1] list — filter by status + category");
  {
    const repo = new MockLivestreamRepository();
    const status: LivestreamStatus = "ENDED";
    const category = firstEnded.category.slug;
    const expected = livestreamFixtures.filter(
      (r) => r.status === status && r.category.slug === category
    ).length;
    const res = await repo.list(q({ status, category, limit: 100 }));
    eq("returns only matching rows", res.data.length, expected);
    check(
      "every row matches both filters",
      res.data.every((r) => r.status === status && r.category.slug === category)
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
    const repo = new MockLivestreamRepository();
    const needle = firstLive.creator.displayName;
    const res = await repo.list(q({ search: needle, limit: 100 }));
    check("search returns at least one match", res.data.length >= 1);
    check(
      "all results contain the search term in a searchable field",
      res.data.every((r) =>
        [r.livestreamId, r.title, r.community.name, r.creator.displayName]
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
    const repo = new MockLivestreamRepository();
    const total = livestreamFixtures.length;
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
    const repo = new MockLivestreamRepository();
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

    const firstIds = new Set(first.data.map((r) => r.livestreamId));
    check(
      "keyset page does not repeat first-page rows",
      second.data.every((r) => !firstIds.has(r.livestreamId))
    );

    // Cursor continuation should equal the offset slice (rows limit..2*limit).
    const offsetP2 = await repo.list(
      q({ sort: "createdAt:asc", page: 2, limit })
    );
    check(
      "cursor page == offset page 2 (same row IDs, same order)",
      JSON.stringify(second.data.map((r) => r.livestreamId)) ===
        JSON.stringify(offsetP2.data.map((r) => r.livestreamId)),
      `cursor=${JSON.stringify(second.data.map((r) => r.livestreamId))} offset=${JSON.stringify(offsetP2.data.map((r) => r.livestreamId))}`
    );
  }

  // --- 5. getById NotFound ------------------------------------------------
  console.log("\n[5] getById");
  {
    const repo = new MockLivestreamRepository();
    const hit = await repo.getById(firstLive.livestreamId);
    check(
      "getById returns the matching row",
      hit?.livestreamId === firstLive.livestreamId
    );
    const miss = await repo.getById("LS-DOES-NOT-EXIST");
    eq("getById returns null for unknown id", miss, null);
  }

  // --- 6. listReports — 404 on unknown stream + filter --------------------
  console.log("\n[6] listReports");
  {
    const repo = new MockLivestreamRepository();
    const res = await repo.listReports(streamWithReports.livestreamId, {
      sort: "createdAt:desc",
      page: 1,
      limit: 100,
    });
    eq(
      "returns the embedded reports for the stream",
      res.data.length,
      streamWithReports.reportCount
    );
    check(
      "every report belongs to the stream",
      res.data.every((r) => r.livestreamId === streamWithReports.livestreamId)
    );

    let nf: unknown = null;
    try {
      await repo.listReports("LS-NOPE", {
        sort: "createdAt:desc",
        page: 1,
        limit: 20,
      });
    } catch (e) {
      nf = e;
    }
    check("unknown stream throws NotFoundError", nf instanceof NotFoundError);
    check(
      "unknown stream error code is LIVESTREAM_NOT_FOUND",
      nf instanceof NotFoundError && nf.message === "LIVESTREAM_NOT_FOUND"
    );
  }

  // --- 7. end — happy path ------------------------------------------------
  console.log("\n[7] end — happy path");
  {
    const repo = new MockLivestreamRepository();
    const res = await repo.end(firstLive.livestreamId, endInput, actor);
    eq("status becomes ENDED", res.status, "ENDED");
    eq("reasonCode echoed", res.reasonCode, endInput.reasonCode);
    eq("endedAt is actor timestamp", res.endedAt, actor.at);
    eq("endedBy stamped", res.endedBy.adminId, actor.admin.id);
    eq("creatorNotified echoed", res.creatorNotified, true);
    eq("strikeIssued echoed", res.strikeIssued, true);
    // Persistence: a re-read reflects the mutation + history append.
    const reread = await repo.getById(firstLive.livestreamId);
    eq("re-read status persisted", reread?.status, "ENDED");
    eq("re-read endedAt persisted", reread?.endedAt, actor.at);
    check(
      "moderationHistory gained a STREAM_ENDED entry",
      (reread?.moderationHistory ?? []).some((h) => h.action === "STREAM_ENDED")
    );
    check(
      "durationSeconds recomputed to a positive value",
      (reread?.durationSeconds ?? 0) > 0
    );
  }

  // --- 8. end — ConflictError on already-ended ----------------------------
  console.log("\n[8] end — ConflictError on already-ended");
  {
    const repo = new MockLivestreamRepository();
    let threw: unknown = null;
    try {
      await repo.end(firstEnded.livestreamId, endInput, actor);
    } catch (e) {
      threw = e;
    }
    check("throws", threw !== null);
    check("throws ConflictError", threw instanceof ConflictError);
    check(
      "conflict error code is LIVESTREAM_ALREADY_ENDED",
      threw instanceof ConflictError &&
        threw.message === "LIVESTREAM_ALREADY_ENDED"
    );

    // And NotFound for an unknown id on a mutation.
    let nf: unknown = null;
    try {
      await repo.end("LS-NOPE", endInput, actor);
    } catch (e) {
      nf = e;
    }
    check("unknown id throws NotFoundError", nf instanceof NotFoundError);
  }

  // --- 9. bulkEnd — partial success ---------------------------------------
  console.log("\n[9] bulkEnd — partial success");
  {
    const repo = new MockLivestreamRepository();
    const ids = [firstLive.livestreamId, firstEnded.livestreamId, "LS-MISSING"];
    const res = await repo.bulkEnd(ids, endInput, actor);
    eq("requested count", res.requested, 3);
    eq("succeeded count", res.succeeded, 1);
    eq("failed count", res.failed, 2);

    const ok = res.results.find((r) => r.id === firstLive.livestreamId);
    check("live stream succeeded", ok?.ok === true);

    const conflict = res.results.find((r) => r.id === firstEnded.livestreamId);
    check(
      "already-ended item failed with LIVESTREAM_ALREADY_ENDED",
      conflict?.ok === false &&
        conflict.error.code === "LIVESTREAM_ALREADY_ENDED"
    );

    const missing = res.results.find((r) => r.id === "LS-MISSING");
    check(
      "missing item failed with LIVESTREAM_NOT_FOUND",
      missing?.ok === false && missing.error.code === "LIVESTREAM_NOT_FOUND"
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
