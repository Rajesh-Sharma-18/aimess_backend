/**
 * AIM-72 — rate-limit counters shared across replicas and surviving a restart.
 *
 * express-rate-limit's default store keeps counters in process memory, so a
 * redeploy handed an attacker mid-run a fresh budget, and the moment a second
 * replica existed every limit multiplied by the replica count — selectably,
 * because the API's nginx config uses `ip_hash`, which lets a client pick its
 * replica by source address.
 *
 * The store is exercised here against a fake ioredis rather than through the
 * app, because the rest of the suite runs it on the in-process store (there is
 * no Redis in the harness). Without this file the Redis path would be exactly
 * the "never exercised before production" shape the codebase already warns
 * about elsewhere.
 */

/** Minimal ioredis stand-in: enough to run the store's Lua script by hand. */
const state = new Map<string, { value: number; expiresAt: number }>();
let evalBehaviour: "ok" | "throw" = "ok";

jest.mock("ioredis", () => {
  class FakeRedis {
    on() {
      return this;
    }
    connect() {
      return Promise.resolve();
    }
    // Mirrors INCR + PEXPIRE-on-first-hit + PTTL, which is what the store's
    // script does atomically in a real Redis.
    eval(_script: string, _numKeys: number, key: string, windowMs: string) {
      if (evalBehaviour === "throw") {
        return Promise.reject(new Error("CLUSTERDOWN"));
      }
      const now = Date.now();
      const existing = state.get(key);
      const live = existing && existing.expiresAt > now ? existing : undefined;
      const next = live
        ? { value: live.value + 1, expiresAt: live.expiresAt }
        : { value: 1, expiresAt: now + Number(windowMs) };
      state.set(key, next);
      return Promise.resolve([next.value, next.expiresAt - now]);
    }
    decr(key: string) {
      const existing = state.get(key);
      if (existing) existing.value -= 1;
      return Promise.resolve(existing?.value ?? 0);
    }
    del(key: string) {
      return Promise.resolve(state.delete(key) ? 1 : 0);
    }
  }
  return { __esModule: true, default: { default: FakeRedis } };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RedisRateLimitStore } =
  require("../../src/middleware/redis-rate-limit-store.js") as typeof import("../../src/middleware/redis-rate-limit-store.js");

function makeStore(windowMs = 60_000) {
  const store = new RedisRateLimitStore();
  store.init({ windowMs } as never);
  return store;
}

beforeEach(() => {
  state.clear();
  evalBehaviour = "ok";
});

describe("RedisRateLimitStore", () => {
  it("counts hits per key", async () => {
    const store = makeStore();

    expect((await store.increment("ip:1.2.3.4")).totalHits).toBe(1);
    expect((await store.increment("ip:1.2.3.4")).totalHits).toBe(2);
    expect((await store.increment("ip:1.2.3.4")).totalHits).toBe(3);
  });

  it("keeps separate callers in separate buckets", async () => {
    const store = makeStore();

    await store.increment("ip:1.1.1.1");
    await store.increment("ip:1.1.1.1");

    expect((await store.increment("ip:2.2.2.2")).totalHits).toBe(1);
  });

  it("shares counters between store instances, which is the point", async () => {
    // Two instances stand in for two gateway replicas: the second must see the
    // first's hits, or every limit multiplies by the replica count.
    const replicaA = makeStore();
    const replicaB = makeStore();

    await replicaA.increment("ip:9.9.9.9");
    await replicaA.increment("ip:9.9.9.9");

    expect((await replicaB.increment("ip:9.9.9.9")).totalHits).toBe(3);
  });

  it("reports a reset time inside the window", async () => {
    const store = makeStore(60_000);

    const info = await store.increment("ip:1.2.3.4");

    expect(info.resetTime).toBeInstanceOf(Date);
    const ms = (info.resetTime as Date).getTime() - Date.now();
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it("does not slide the window forward on later hits", async () => {
    // A window that re-armed on every hit would never reset under steady
    // traffic, locking a caller out indefinitely rather than for one window.
    const store = makeStore(60_000);
    const elapsedMs = 40;

    const first = await store.increment("ip:1.2.3.4");
    await new Promise((resolve) => setTimeout(resolve, elapsedMs));
    const second = await store.increment("ip:1.2.3.4");

    // The reset time is derived from two separate clock reads (`Date.now()`
    // inside the script and again when building the Date), so it can differ by
    // a millisecond or so. What must NOT happen is it advancing by the elapsed
    // time, which is what re-arming the expiry looks like.
    const drift =
      (second.resetTime as Date).getTime() -
      (first.resetTime as Date).getTime();
    expect(drift).toBeLessThan(elapsedMs / 2);
  });

  it("starts a fresh window once the old one expires", async () => {
    const store = makeStore(30);

    await store.increment("ip:1.2.3.4");
    await store.increment("ip:1.2.3.4");
    await new Promise((resolve) => setTimeout(resolve, 45));

    expect((await store.increment("ip:1.2.3.4")).totalHits).toBe(1);
  });

  it("fails OPEN when Redis is unavailable", async () => {
    // A limiter that propagated the error would turn a Redis blip into a 500 on
    // every request to the whole API — worse than briefly unthrottled traffic.
    const store = makeStore();
    evalBehaviour = "throw";

    const info = await store.increment("ip:1.2.3.4");

    expect(info.totalHits).toBe(1);
    expect(info.resetTime).toBeInstanceOf(Date);
  });

  it("resets a key on demand", async () => {
    const store = makeStore();

    await store.increment("ip:1.2.3.4");
    await store.resetKey("ip:1.2.3.4");

    expect((await store.increment("ip:1.2.3.4")).totalHits).toBe(1);
  });

  it("decrements without throwing when Redis is down", async () => {
    const store = makeStore();
    evalBehaviour = "throw";

    await expect(store.decrement("ip:1.2.3.4")).resolves.toBeUndefined();
  });

  it("declares its keys as shared, not local", async () => {
    // express-rate-limit uses this to decide whether it may keep its own
    // per-process view; claiming `true` would defeat the shared counters.
    expect(makeStore().localKeys).toBe(false);
  });
});
