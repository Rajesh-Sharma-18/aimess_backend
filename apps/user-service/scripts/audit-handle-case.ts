/**
 * Read-only audit: usernames (and the mirrored login `account`) that differ
 * only by letter case.
 *
 * Run BEFORE deploying migration 20261005000000_username_case_insensitive_unique:
 * a non-empty "username clashes" list means that migration's unique index
 * cannot be built until those rows are resolved. The `account` column is a
 * mirror of auth-service (whose own audit is `audit:account-case`), reported
 * for context only. Writes nothing.
 *
 *   pnpm --filter @aimess/user-service audit:handle-case
 */
import { prisma } from "../src/config/prisma.js";

const [totals] = await prisma.$queryRaw<
  { total: bigint; mixedUsername: bigint; mixedAccount: bigint }[]
>`SELECT count(*) AS total,
         count(*) FILTER (WHERE username <> lower(username)) AS "mixedUsername",
         count(*) FILTER (WHERE account <> lower(account)) AS "mixedAccount"
  FROM user_profiles`;

const clashes = await prisma.$queryRaw<
  { canonical: string; userIds: string[]; usernames: string[] }[]
>`SELECT lower(username) AS canonical,
         array_agg("userId"::text) AS "userIds",
         array_agg(username) AS usernames
  FROM user_profiles GROUP BY 1 HAVING count(*) > 1`;

console.log(
  `user_profiles: ${String(totals?.total)} total, ` +
    `${String(totals?.mixedUsername)} mixed-case username(s), ` +
    `${String(totals?.mixedAccount)} mixed-case account mirror(s)`
);
console.log(`username clashes: ${String(clashes.length)}`);
if (clashes.length > 0) console.table(clashes);

await prisma.$disconnect();
