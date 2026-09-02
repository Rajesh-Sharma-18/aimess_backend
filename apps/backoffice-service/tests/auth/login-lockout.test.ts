/**
 * AIM-30 — repeated failed admin logins must lock the ACCOUNT, not just annoy
 * one IP, and the lock must survive a cache flush.
 *
 * User login has had a per-account lockout for a long time. The admin path had
 * none: a wrong password wrote an audit row and returned 401, and nothing
 * counted. The only brake was the gateway's IP-keyed limiter, which a botnet or
 * a rotating proxy pool sidesteps by construction — so a distributed guessing
 * run against a known admin address was unthrottled per account, and success
 * grants the whole backoffice RBAC surface plus an 8-hour token.
 *
 * The counter is keyed by EMAIL, deliberately including addresses that do not
 * resolve to an admin: keying on the resolved account would leave a free
 * oracle, where "never locks out" answers "not an admin".
 *
 * It now lives in Postgres rather than Redis. A cache flush is a routine
 * operational act — and one an attacker who can trigger it would choose
 * deliberately — and it used to reset every lockout on the highest-privilege
 * login on the platform.
 */

type Row = { email: string; failures: number; windowStartedAt: Date };

/** Stands in for the `AdminLoginFailure` table. */
const rows = new Map<string, Row>();
let dbFails = false;

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    adminLoginFailure: {
      async findUnique({ where }: { where: { email: string } }) {
        if (dbFails) throw new Error("database down");
        return rows.get(where.email) ?? null;
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        if (dbFails) throw new Error("database down");

        if (typeof where.email === "string") {
          return { count: rows.delete(where.email) ? 1 : 0 };
        }

        // The sweeper's shape: { windowStartedAt: { lt: cutoff } }.
        const cutoff = (where.windowStartedAt as { lt: Date }).lt;
        let count = 0;
        for (const [key, row] of rows) {
          if (row.windowStartedAt < cutoff) {
            rows.delete(key);
            count += 1;
          }
        }
        return { count };
      },
    },
    /**
     * The upsert is one raw statement so two concurrent failures cannot both
     * read 0 and both write 1. Re-implemented here with the same semantics
     * rather than parsed: what matters is the counting and window behaviour,
     * and the SQL itself is exercised by the migration against a real database.
     */
    async $queryRaw(_strings: TemplateStringsArray, ...values: unknown[]) {
      if (dbFails) throw new Error("database down");

      const email = values[0] as string;
      const now = values[1] as Date;
      const windowFloor = values[3] as Date;

      const existing = rows.get(email);
      const restart = !existing || existing.windowStartedAt < windowFloor;

      const next: Row = restart
        ? { email, failures: 1, windowStartedAt: now }
        : {
            email,
            failures: existing.failures + 1,
            windowStartedAt: existing.windowStartedAt,
          };

      rows.set(email, next);
      return [{ failures: next.failures }];
    },
  },
}));

// Imported after the mock so the module binds to the fake client.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  assertLoginNotLocked,
  clearLoginFailures,
  purgeStaleLoginFailures,
  recordLoginFailure,
} = require("../../src/lib/admin-login-lockout.js") as typeof import("../../src/lib/admin-login-lockout.js");

const EMAIL = "admin@example.com";
const MAX_FAILURES = Number(process.env.ADMIN_MAX_FAILED_LOGINS ?? 5);
const LOCKOUT_MINUTES = Number(process.env.ADMIN_LOCKOUT_MINUTES ?? 15);

beforeEach(() => {
  rows.clear();
  dbFails = false;
});

async function failUntilLocked(email = EMAIL): Promise<void> {
  for (let i = 0; i < MAX_FAILURES; i += 1) {
    await recordLoginFailure(email);
  }
}

describe("admin login lockout", () => {
  it("allows attempts below the threshold", async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i += 1) {
      await expect(assertLoginNotLocked(EMAIL)).resolves.toBeUndefined();
      await recordLoginFailure(EMAIL);
    }

    await expect(assertLoginNotLocked(EMAIL)).resolves.toBeUndefined();
  });

  it("locks the account once the threshold is reached", async () => {
    await failUntilLocked();

    await expect(assertLoginNotLocked(EMAIL)).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("counts an address that is not an admin, so it is not an oracle", async () => {
    // If unknown addresses never locked, "did not lock out" would answer
    // "this address is not an admin".
    const unknown = "not-an-admin@example.com";
    await failUntilLocked(unknown);

    await expect(assertLoginNotLocked(unknown)).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("is per account — one locked address does not lock another", async () => {
    await failUntilLocked();

    await expect(
      assertLoginNotLocked("someone-else@example.com")
    ).resolves.toBeUndefined();
  });

  it("normalizes case and whitespace, so the counter cannot be sidestepped", async () => {
    await failUntilLocked();

    await expect(
      assertLoginNotLocked(`  ${EMAIL.toUpperCase()}  `)
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("clears on a successful login", async () => {
    await failUntilLocked();
    await clearLoginFailures(EMAIL);

    await expect(assertLoginNotLocked(EMAIL)).resolves.toBeUndefined();
  });

  it("fails open when the database is unavailable", async () => {
    // An infrastructure fault must not lock every admin out of the platform;
    // the gateway's IP limiter and the audit trail remain.
    await failUntilLocked();
    dbFails = true;

    await expect(assertLoginNotLocked(EMAIL)).resolves.toBeUndefined();
  });

  it("does not throw when recording a failure fails", async () => {
    dbFails = true;
    await expect(recordLoginFailure(EMAIL)).resolves.toBeUndefined();
  });

  describe("durability and the lockout window", () => {
    it("survives a cache flush", async () => {
      // The point of AIM-30. The counter lived only in Redis, so `FLUSHALL` —
      // routine maintenance, and something an attacker who can cause it would
      // choose — cleared every admin lockout on the platform. Nothing this
      // module touches is in the cache any more.
      await failUntilLocked();

      // Asserted statically, because "a flush cleared it" is exactly the
      // failure this replaces: nothing in the lockout path may reach the cache
      // at all, or the durability is only accidental.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const source = (require("node:fs") as typeof import("node:fs"))
        .readFileSync(
          require.resolve("../../src/lib/admin-login-lockout.ts"),
          "utf8"
        );
      // Imports and calls only — the module's prose still explains what it
      // replaced, and should.
      expect(source).not.toMatch(/from\s+"[^"]*redis/i);
      expect(source).not.toMatch(/redis\s*\./);

      await expect(assertLoginNotLocked(EMAIL)).rejects.toMatchObject({
        statusCode: 429,
      });
    });

    it("stops locking once the window has closed", async () => {
      // Replaces the Redis key's TTL: a burst from last week must not lock an
      // admin out forever.
      await failUntilLocked();

      const row = rows.get(EMAIL);
      if (!row) throw new Error("expected a failure row");
      row.windowStartedAt = new Date(
        Date.now() - (LOCKOUT_MINUTES * 60 * 1000 + 1000)
      );

      await expect(assertLoginNotLocked(EMAIL)).resolves.toBeUndefined();
    });

    it("restarts the count rather than resuming it after the window closes", async () => {
      await failUntilLocked();

      const row = rows.get(EMAIL);
      if (!row) throw new Error("expected a failure row");
      row.windowStartedAt = new Date(
        Date.now() - (LOCKOUT_MINUTES * 60 * 1000 + 1000)
      );

      // A single failure in a fresh window must not re-lock an account that
      // was locked a week ago.
      await recordLoginFailure(EMAIL);

      expect(rows.get(EMAIL)?.failures).toBe(1);
      await expect(assertLoginNotLocked(EMAIL)).resolves.toBeUndefined();
    });

    it("does not write during a read", async () => {
      // `assertLoginNotLocked` runs on every attempt including successful ones;
      // an expired row is ignored, not rewritten.
      await recordLoginFailure(EMAIL);
      const before = { ...(rows.get(EMAIL) as Row) };

      await assertLoginNotLocked(EMAIL);

      expect(rows.get(EMAIL)).toMatchObject({
        failures: before.failures,
        windowStartedAt: before.windowStartedAt,
      });
    });

    it("sweeps rows whose window has closed, and keeps live ones", async () => {
      // Redis expired keys for us; a durable table does not, and every address
      // a password spray tries once leaves a row behind.
      await recordLoginFailure("stale@example.com");
      await recordLoginFailure("live@example.com");

      const stale = rows.get("stale@example.com");
      if (!stale) throw new Error("expected a failure row");
      stale.windowStartedAt = new Date(
        Date.now() - (LOCKOUT_MINUTES * 60 * 1000 + 1000)
      );

      await expect(purgeStaleLoginFailures()).resolves.toBe(1);
      expect(rows.has("stale@example.com")).toBe(false);
      expect(rows.has("live@example.com")).toBe(true);
    });
  });
});
