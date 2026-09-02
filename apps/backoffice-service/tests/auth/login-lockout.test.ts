/**
 * AIM-30 — repeated failed admin logins must lock the ACCOUNT, not just annoy
 * one IP.
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
 */

const store = new Map<string, string>();
let redisFails = false;

jest.mock("../../src/config/redis.js", () => ({
  redis: {
    async get(key: string) {
      if (redisFails) throw new Error("redis down");
      return store.get(key) ?? null;
    },
    async incr(key: string) {
      if (redisFails) throw new Error("redis down");
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return next;
    },
    async expire() {
      return 1;
    },
    async del(key: string) {
      store.delete(key);
      return 1;
    },
  },
}));

// Imported after the mock so the module binds to the fake client.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  assertLoginNotLocked,
  clearLoginFailures,
  recordLoginFailure,
} = require("../../src/lib/admin-login-lockout.js") as typeof import("../../src/lib/admin-login-lockout.js");

const EMAIL = "admin@example.com";
const MAX_FAILURES = Number(process.env.ADMIN_MAX_FAILED_LOGINS ?? 5);

beforeEach(() => {
  store.clear();
  redisFails = false;
});

describe("admin login lockout", () => {
  it("allows attempts below the threshold", async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i += 1) {
      await expect(assertLoginNotLocked(EMAIL)).resolves.toBeUndefined();
      await recordLoginFailure(EMAIL);
    }

    await expect(assertLoginNotLocked(EMAIL)).resolves.toBeUndefined();
  });

  it("locks the account once the threshold is reached", async () => {
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await recordLoginFailure(EMAIL);
    }

    await expect(assertLoginNotLocked(EMAIL)).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("counts an address that is not an admin, so it is not an oracle", async () => {
    // If unknown addresses never locked, "did not lock out" would answer
    // "this address is not an admin".
    const unknown = "not-an-admin@example.com";
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await recordLoginFailure(unknown);
    }

    await expect(assertLoginNotLocked(unknown)).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("is per account — one locked address does not lock another", async () => {
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await recordLoginFailure(EMAIL);
    }

    await expect(
      assertLoginNotLocked("someone-else@example.com")
    ).resolves.toBeUndefined();
  });

  it("normalizes case and whitespace, so the counter cannot be sidestepped", async () => {
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await recordLoginFailure(EMAIL);
    }

    await expect(
      assertLoginNotLocked(`  ${EMAIL.toUpperCase()}  `)
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("clears on a successful login", async () => {
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await recordLoginFailure(EMAIL);
    }
    await clearLoginFailures(EMAIL);

    await expect(assertLoginNotLocked(EMAIL)).resolves.toBeUndefined();
  });

  it("fails open when Redis is unavailable", async () => {
    // A cache outage must not lock every admin out of the platform; the
    // gateway's IP limiter and the audit trail remain.
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await recordLoginFailure(EMAIL);
    }
    redisFails = true;

    await expect(assertLoginNotLocked(EMAIL)).resolves.toBeUndefined();
  });

  it("does not throw when recording a failure fails", async () => {
    redisFails = true;
    await expect(recordLoginFailure(EMAIL)).resolves.toBeUndefined();
  });
});
