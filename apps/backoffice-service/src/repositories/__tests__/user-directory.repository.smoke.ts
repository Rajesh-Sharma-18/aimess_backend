/**
 * Standalone smoke test for the pure helpers of
 * {@link PrismaUserDirectoryRepository}.
 *
 * NOTE: backoffice-service has NO formal test runner configured — its
 * package.json `test` script is a no-op. The repository is Prisma-backed (it
 * needs a live admin_db), so rather than stand up a DB here we unit-test the
 * pure, DB-free building blocks: cursor encode/decode round-trip, sort parsing,
 * and the Prisma `where`-builder for every filter (status, report buckets,
 * date range, search). These are exactly the bits the offset+keyset pagination
 * relies on. Style mirrors report.repository.smoke.ts.
 *
 * Run from repo root:
 *   pnpm --filter @aimess/backoffice-service exec tsx src/repositories/__tests__/user-directory.repository.smoke.ts
 */
import { ConflictError } from "@aimess/errors";

import {
  assertTransition,
  buildWhere,
  decodeCursor,
  deriveModerationStatus,
  encodeCursor,
  parseSort,
  resolveModerationStatus,
  type Cursor,
} from "../user-directory.repository.js";
import type {
  ListUsersQuery,
  UserStatus,
} from "../../types/user-management.types.js";

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

/** Build a complete ListUsersQuery with sensible defaults. */
function q(overrides: Partial<ListUsersQuery> = {}): ListUsersQuery {
  return { sort: "joinedAt:desc", page: 1, limit: 20, ...overrides };
}

function main(): void {
  // --- 1. Cursor encode/decode round-trip ----------------------------------
  console.log("\n[1] cursor encode/decode round-trip");
  {
    const cursor: Cursor = {
      joinedAt: Date.parse("2025-03-01T10:00:00.000Z"),
      userId: "u_seed_07",
    };
    const token = encodeCursor(cursor);
    check("token is a non-empty base64url string", /^[\w-]+$/.test(token));
    const back = decodeCursor(token);
    eq("decoded joinedAt", back?.joinedAt, cursor.joinedAt);
    eq("decoded userId", back?.userId, cursor.userId);

    eq("garbage token decodes to null", decodeCursor("!!!not-base64!!!"), null);
    const wrongShape = Buffer.from(JSON.stringify({ foo: 1 }), "utf8").toString(
      "base64url"
    );
    eq("wrong-shape token decodes to null", decodeCursor(wrongShape), null);
  }

  // --- 2. parseSort --------------------------------------------------------
  console.log("\n[2] parseSort");
  {
    eq("joinedAt:desc field", parseSort("joinedAt:desc").field, "joinedAt");
    eq("joinedAt:desc dir", parseSort("joinedAt:desc").dir, "desc");
    eq("username:asc field", parseSort("username:asc").field, "username");
    eq("username:asc dir", parseSort("username:asc").dir, "asc");
    eq("reportCount:asc dir", parseSort("reportCount:asc").dir, "asc");
  }

  // --- 3. where-builder: status filter -------------------------------------
  console.log("\n[3] buildWhere — status");
  {
    const where = buildWhere(q({ status: ["BANNED", "SUSPENDED"] }));
    check(
      "status uses `in`",
      JSON.stringify(where.status) ===
        JSON.stringify({ in: ["BANNED", "SUSPENDED"] })
    );
    const none = buildWhere(q());
    eq("no status filter when omitted", none.status, undefined);
  }

  // --- 4. where-builder: report buckets ------------------------------------
  console.log("\n[4] buildWhere — report buckets");
  {
    eq(
      "none → reportCount 0",
      buildWhere(q({ reports: "none" })).reportCount,
      0
    );
    check(
      "has → reportCount gte 1",
      JSON.stringify(buildWhere(q({ reports: "has" })).reportCount) ===
        JSON.stringify({ gte: 1 })
    );
    check(
      "gte_5 → reportCount gte 5",
      JSON.stringify(buildWhere(q({ reports: "gte_5" })).reportCount) ===
        JSON.stringify({ gte: 5 })
    );
    check(
      "gte_10 → reportCount gte 10",
      JSON.stringify(buildWhere(q({ reports: "gte_10" })).reportCount) ===
        JSON.stringify({ gte: 10 })
    );
  }

  // --- 5. where-builder: date range ----------------------------------------
  console.log("\n[5] buildWhere — joinedAt date range");
  {
    const where = buildWhere(
      q({ dateFrom: "2025-01-01", dateTo: "2025-12-31" })
    );
    const filter = where.joinedAt as { gte?: Date; lte?: Date };
    eq(
      "gte is start-of-day UTC",
      filter.gte?.toISOString(),
      "2025-01-01T00:00:00.000Z"
    );
    eq(
      "lte is end-of-day UTC (inclusive)",
      filter.lte?.toISOString(),
      "2025-12-31T23:59:59.999Z"
    );
  }

  // --- 6. where-builder: search OR -----------------------------------------
  console.log("\n[6] buildWhere — search");
  {
    const where = buildWhere(q({ search: "alex" }));
    check("search builds an OR clause", Array.isArray(where.OR));
    check(
      "OR covers username + email, case-insensitive",
      JSON.stringify(where.OR) ===
        JSON.stringify([
          { username: { contains: "alex", mode: "insensitive" } },
          { email: { contains: "alex", mode: "insensitive" } },
        ])
    );
  }

  // --- 7. combined filters coexist -----------------------------------------
  console.log("\n[7] buildWhere — combined filters");
  {
    const where = buildWhere(
      q({
        status: ["ACTIVE"],
        reports: "gte_5",
        search: "sam",
        dateFrom: "2024-06-01",
      })
    );
    check("status present", where.status !== undefined);
    check("reportCount present", where.reportCount !== undefined);
    check("OR present", where.OR !== undefined);
    check("joinedAt present", where.joinedAt !== undefined);
  }

  // --- 8. assertTransition state machine (F1) ------------------------------
  console.log("\n[8] assertTransition — state machine");
  {
    /** Returns the thrown ConflictError code, or "OK" when allowed. */
    function transition(current: UserStatus, next: UserStatus): string {
      try {
        assertTransition(current, next);
        return "OK";
      } catch (e) {
        return e instanceof ConflictError ? e.message : "OTHER_ERROR";
      }
    }

    // → BANNED
    eq("ACTIVE→BANNED allowed", transition("ACTIVE", "BANNED"), "OK");
    eq("SUSPENDED→BANNED allowed", transition("SUSPENDED", "BANNED"), "OK");
    eq(
      "BANNED→BANNED rejected USER_ALREADY_BANNED",
      transition("BANNED", "BANNED"),
      "USER_ALREADY_BANNED"
    );

    // → SUSPENDED
    eq("ACTIVE→SUSPENDED allowed", transition("ACTIVE", "SUSPENDED"), "OK");
    eq(
      "SUSPENDED→SUSPENDED allowed (re-suspend/extend)",
      transition("SUSPENDED", "SUSPENDED"),
      "OK"
    );
    eq(
      "BANNED→SUSPENDED rejected (no silent downgrade)",
      transition("BANNED", "SUSPENDED"),
      "USER_ALREADY_BANNED"
    );

    // → ACTIVE
    eq("BANNED→ACTIVE allowed (unban)", transition("BANNED", "ACTIVE"), "OK");
    eq(
      "SUSPENDED→ACTIVE allowed (unban)",
      transition("SUSPENDED", "ACTIVE"),
      "OK"
    );
    eq(
      "ACTIVE→ACTIVE rejected USER_NOT_BANNED",
      transition("ACTIVE", "ACTIVE"),
      "USER_NOT_BANNED"
    );

    // DELETED is a tombstone for every target.
    eq(
      "DELETED→ACTIVE rejected",
      transition("DELETED", "ACTIVE"),
      "USER_DELETED"
    );
    eq(
      "DELETED→SUSPENDED rejected",
      transition("DELETED", "SUSPENDED"),
      "USER_DELETED"
    );
    eq(
      "DELETED→BANNED rejected",
      transition("DELETED", "BANNED"),
      "USER_DELETED"
    );
  }

  // --- 9. deriveModerationStatus — ban-status exposure (F2) ----------------
  console.log("\n[9] deriveModerationStatus");
  {
    eq(
      "ACTIVE → moderationStatus ACTIVE",
      deriveModerationStatus("ACTIVE").moderationStatus,
      "ACTIVE"
    );
    eq(
      "ACTIVE → isBanned false",
      deriveModerationStatus("ACTIVE").isBanned,
      false
    );

    eq(
      "BANNED → moderationStatus BANNED",
      deriveModerationStatus("BANNED").moderationStatus,
      "BANNED"
    );
    eq(
      "BANNED → isBanned true",
      deriveModerationStatus("BANNED").isBanned,
      true
    );

    eq(
      "SUSPENDED → moderationStatus BANNED (time-boxed ban counts as banned)",
      deriveModerationStatus("SUSPENDED").moderationStatus,
      "BANNED"
    );
    eq(
      "SUSPENDED → isBanned true",
      deriveModerationStatus("SUSPENDED").isBanned,
      true
    );

    eq(
      "DELETED → moderationStatus ACTIVE (not a ban state)",
      deriveModerationStatus("DELETED").moderationStatus,
      "ACTIVE"
    );
    eq(
      "DELETED → isBanned false",
      deriveModerationStatus("DELETED").isBanned,
      false
    );
  }

  // --- 10. resolveModerationStatus — mirror overrides live status (F3) -----
  console.log("\n[10] resolveModerationStatus");
  {
    eq(
      "no mirror row → falls back to live status (ACTIVE)",
      resolveModerationStatus("ACTIVE", undefined),
      "ACTIVE"
    );
    eq(
      "mirror BANNED overrides live ACTIVE (auth-service never persists bans)",
      resolveModerationStatus("ACTIVE", { status: "BANNED" }),
      "BANNED"
    );
    eq(
      "mirror SUSPENDED overrides live ACTIVE",
      resolveModerationStatus("ACTIVE", { status: "SUSPENDED" }),
      "SUSPENDED"
    );
    eq(
      "mirror ACTIVE (post-unban) overrides a stale live BANNED",
      resolveModerationStatus("BANNED", { status: "ACTIVE" }),
      "ACTIVE"
    );
    eq(
      "live DELETED always wins, even with a mirror row present",
      resolveModerationStatus("DELETED", { status: "BANNED" }),
      "DELETED"
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

main();
