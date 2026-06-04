/**
 * Standalone smoke test for {@link MockCommunityRepository}.
 *
 * NOTE: backoffice-service has NO formal test runner configured — its
 * package.json `test` script is a no-op (`node -e "process.exit(0)"`). Rather
 * than scaffold vitest/jest for one file, this is a focused tsx script that
 * mirrors report.repository.smoke.ts exactly (same harness, same style).
 *
 * Run from repo root:
 *   pnpm --filter @aimess/backoffice-service exec tsx src/repositories/__tests__/community.repository.smoke.ts
 *
 * Covers: list pagination totals, status=CLOSED filter, admin-name search,
 * close happy path + ConflictError on a second close, reopen happy path,
 * bulkClose partial success, and getById null on an unknown id.
 */
import { ConflictError } from "@aimess/errors";

import { communityFixtures } from "../__fixtures__/communities.fixture.js";
import { MockCommunityRepository } from "../community.repository.js";
import type { ActorRef } from "../community.repository.js";
import type {
  CloseInput,
  CommunityModerationStatus,
  ListCommunitiesQuery,
  ReopenInput,
} from "../../types/community.types.js";

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

/** Build a complete ListCommunitiesQuery with sensible defaults. */
function q(
  overrides: Partial<ListCommunitiesQuery> = {}
): ListCommunitiesQuery {
  return { sort: "createdAt:desc", page: 1, limit: 20, ...overrides };
}

const actor: ActorRef = {
  moderator: { adminId: "adm_test", name: "Test Mod" },
  at: "2026-06-03T12:00:00.000Z",
};
const closeInput: CloseInput = {
  reasonCode: "GUIDELINES_VIOLATION",
  reasonNote: "smoke",
};
const reopenInput: ReopenInput = { reasonNote: "smoke reopen" };

// Derive ground-truth expectations from the fixtures themselves.
const CLOSED: CommunityModerationStatus = "CLOSED";
const ACTIVE: CommunityModerationStatus = "ACTIVE";
const firstActive = communityFixtures.find(
  (c) => c.community.status === ACTIVE
)!;
const firstClosed = communityFixtures.find(
  (c) => c.community.status === CLOSED
)!;

async function main(): Promise<void> {
  // --- 1. list — pagination totals ----------------------------------------
  console.log("\n[1] list — returns 20 rows with correct pagination totals");
  {
    const repo = new MockCommunityRepository();
    const total = communityFixtures.length;
    const res = await repo.list(q({ limit: 100 }));
    eq("list returns all 20 fixtures", res.data.length, total);
    eq("data length is 20", total, 20);
    eq("pagination.total reflects full count", res.pagination.total, total);
    eq("pagination.totalPages = 1 at limit 100", res.pagination.totalPages, 1);
    eq("mode is offset", res.pagination.mode, "offset");
    eq("hasNext false on full page", res.pagination.hasNext, false);
    eq("hasPrev false on page 1", res.pagination.hasPrev, false);
  }

  // --- 2. list — filter by status=CLOSED ----------------------------------
  console.log("\n[2] list — filter by status=CLOSED");
  {
    const repo = new MockCommunityRepository();
    const expected = communityFixtures.filter(
      (c) => c.community.status === CLOSED
    ).length;
    const res = await repo.list(q({ status: CLOSED, limit: 100 }));
    eq("returns only closed rows", res.data.length, expected);
    check("expected at least one closed fixture", expected >= 1);
    check(
      "every returned row has status CLOSED",
      res.data.every((c) => c.status === CLOSED)
    );
    eq(
      "pagination.total reflects filtered count",
      res.pagination.total,
      expected
    );
  }

  // --- 3. list — search by admin name "Alice Wonder" ----------------------
  console.log('\n[3] list — search by admin name "Alice Wonder"');
  {
    const repo = new MockCommunityRepository();
    const needle = "Alice Wonder";
    const res = await repo.list(q({ search: needle, limit: 100 }));
    check("search returns at least two rows", res.data.length >= 2);
    check(
      "every result is owned by the searched admin",
      res.data.every((c) => c.admin.name === needle)
    );
    const miss = await repo.list(
      q({ search: "zzz_no_such_admin_zzz", limit: 100 })
    );
    eq("nonsense search yields zero rows", miss.data.length, 0);
  }

  // --- 4. close — happy path + ConflictError on a second close ------------
  console.log("\n[4] close — flips ACTIVE→CLOSED, second close conflicts");
  {
    const repo = new MockCommunityRepository();
    const id = firstActive.community.communityId;
    const res = await repo.close(id, closeInput, actor);
    eq("status becomes CLOSED", res.status, "CLOSED");
    eq("communityId echoed", res.communityId, id);
    eq("closedAt is actor timestamp", res.closedAt, actor.at);
    eq("reasonCode echoed", res.reasonCode, closeInput.reasonCode);

    // Persistence: a re-read reflects the mutation + history append.
    const reread = await repo.getById(id);
    eq("re-read status persisted", reread?.community.status, "CLOSED");
    check(
      "history gained a suspend_community entry",
      (reread?.moderationHistory ?? []).some(
        (h) => h.type === "suspend_community"
      )
    );

    // Second close on the now-closed community throws ConflictError.
    let threw: unknown = null;
    try {
      await repo.close(id, closeInput, actor);
    } catch (e) {
      threw = e;
    }
    check("second close throws", threw !== null);
    check("second close throws ConflictError", threw instanceof ConflictError);
    check(
      "ConflictError code is COMMUNITY_ALREADY_CLOSED",
      threw instanceof ConflictError &&
        threw.message === "COMMUNITY_ALREADY_CLOSED",
      threw instanceof Error ? threw.message : String(threw)
    );
  }

  // --- 5. reopen — flips CLOSED→ACTIVE ------------------------------------
  console.log("\n[5] reopen — flips CLOSED→ACTIVE");
  {
    const repo = new MockCommunityRepository();
    const id = firstClosed.community.communityId;
    const res = await repo.reopen(id, reopenInput, actor);
    eq("status becomes ACTIVE", res.status, "ACTIVE");
    eq("communityId echoed", res.communityId, id);
    eq("reopenedAt is actor timestamp", res.reopenedAt, actor.at);

    const reread = await repo.getById(id);
    eq("re-read status persisted", reread?.community.status, "ACTIVE");
    check(
      "history gained a reopen_community entry",
      (reread?.moderationHistory ?? []).some(
        (h) => h.type === "reopen_community"
      )
    );
  }

  // --- 6. bulkClose — partial success (active + already-closed) -----------
  console.log("\n[6] bulkClose — partial success");
  {
    const repo = new MockCommunityRepository();
    const activeId = firstActive.community.communityId;
    const closedId = firstClosed.community.communityId;
    const ids = [activeId, closedId, "comm_does_not_exist"];
    const res = await repo.bulkClose(ids, closeInput, actor);
    eq("requested count", res.requested, 3);
    eq("succeeded count", res.succeeded, 1);
    eq("failed count", res.failed, 2);

    const ok = res.results.find((r) => r.communityId === activeId);
    check("active community succeeded", ok?.ok === true);
    check(
      "succeeded item carries CLOSED status",
      ok?.ok === true && ok.status === "CLOSED"
    );

    const conflict = res.results.find((r) => r.communityId === closedId);
    check(
      "already-closed item failed with COMMUNITY_ALREADY_CLOSED",
      conflict?.ok === false &&
        conflict.error.code === "COMMUNITY_ALREADY_CLOSED"
    );

    const missing = res.results.find(
      (r) => r.communityId === "comm_does_not_exist"
    );
    check(
      "missing item failed with COMMUNITY_NOT_FOUND",
      missing?.ok === false && missing.error.code === "COMMUNITY_NOT_FOUND"
    );
  }

  // --- 7. getById — unknown id returns null -------------------------------
  console.log("\n[7] getById");
  {
    const repo = new MockCommunityRepository();
    const hit = await repo.getById(firstActive.community.communityId);
    check(
      "getById returns the matching row",
      hit?.community.communityId === firstActive.community.communityId
    );
    const miss = await repo.getById("comm_DOES_NOT_EXIST");
    eq("getById returns null for unknown id", miss, null);
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
