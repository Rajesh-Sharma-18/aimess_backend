/**
 * Read-only audit: account names that differ only by letter case.
 *
 * Run BEFORE deploying migration 20261005000000_account_case_insensitive_unique
 * to see what it will flag (`accountCaseConflict`), and afterwards to see which
 * clashes are still waiting on a product decision. Writes nothing.
 *
 *   pnpm --filter @aimess/auth-service audit:account-case
 */
import { prisma } from "../src/config/prisma.js";

const [totals] = await prisma.$queryRaw<
  { total: bigint; mixedCase: bigint }[]
>`SELECT count(*) AS total,
         count(*) FILTER (WHERE account <> lower(account)) AS "mixedCase"
  FROM auth_users`;

const clashes = await prisma.$queryRaw<
  {
    canonical: string;
    id: string;
    account: string;
    status: string;
    createdAt: Date;
    lastLoginAt: Date | null;
    deletedAt: Date | null;
  }[]
>`SELECT lower(account) AS canonical, id::text AS id, account, status::text AS status,
         "createdAt", "lastLoginAt", "deletedAt"
  FROM auth_users
  WHERE lower(account) IN (
    SELECT lower(account) FROM auth_users GROUP BY 1 HAVING count(*) > 1
  )
  ORDER BY 1, "createdAt"`;

console.log(
  `auth_users: ${String(totals?.total)} total, ${String(totals?.mixedCase)} mixed-case, ` +
    `${String(new Set(clashes.map((c) => c.canonical)).size)} case-insensitive clash group(s) ` +
    `covering ${String(clashes.length)} account(s)`
);
console.table(
  clashes.map((c) => ({
    canonical: c.canonical,
    account: c.account,
    id: c.id,
    status: c.status,
    created: c.createdAt.toISOString().slice(0, 10),
    lastLogin: c.lastLoginAt?.toISOString().slice(0, 10) ?? "-",
    deleted: c.deletedAt?.toISOString().slice(0, 10) ?? "-",
  }))
);

await prisma.$disconnect();
