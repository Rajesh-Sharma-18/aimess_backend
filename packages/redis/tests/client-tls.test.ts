/**
 * `connectRedis` — the TLS switch has to reach the client on BOTH construction
 * paths.
 *
 * `tls` was applied only when the caller passed host/port. api-gateway (and any
 * service that moves to a URL) passes `url`, so a deployment that set the
 * switch got a silent cleartext connection: the AUTH password and, because
 * Redis pub/sub is this platform's realtime fan-out, the body of every chat and
 * community message travelled in the clear with nothing reporting a problem.
 *
 * These assert on the OPTIONS handed to ioredis rather than opening a socket —
 * the presence of the `tls` key is exactly what decides whether ioredis speaks
 * TLS, and a real connection would need a real server.
 */
const constructed: { args: unknown[] }[] = [];

class FakeRedis {
  public status = "wait";
  public on = jest.fn();
  public duplicate = jest.fn();
  constructor(...args: unknown[]) {
    constructed.push({ args });
  }
}

jest.mock("ioredis", () => ({
  __esModule: true,
  default: FakeRedis,
}));

type ConnectOptions = Parameters<
  typeof import("../src/client.js").connectRedis
>[0];

/** Build a client under a fresh module registry and return ioredis' arguments. */
async function connect(options: ConnectOptions): Promise<unknown[]> {
  constructed.length = 0;
  await jest.isolateModulesAsync(async () => {
    const { connectRedis } = await import("../src/client.js");
    connectRedis(options);
  });
  expect(constructed).toHaveLength(1);
  return constructed[0].args;
}

describe("connectRedis — TLS", () => {
  it("enables TLS on a URL connection when the switch is on", async () => {
    // The finding: this used to drop `tls` entirely.
    const [url, opts] = await connect({
      url: "redis://cache.internal:6379",
      tls: true,
    });

    expect(url).toBe("redis://cache.internal:6379");
    expect(opts).toHaveProperty("tls", {});
  });

  it("leaves a URL connection plaintext when the switch is off", async () => {
    const [, opts] = await connect({ url: "redis://localhost:6379" });
    expect(opts).not.toHaveProperty("tls");
  });

  it("passes a rediss:// URL through untouched", async () => {
    // The scheme already implies TLS in ioredis; nothing here may rewrite it.
    const [url, opts] = await connect({ url: "rediss://cache.internal:6380" });

    expect(url).toBe("rediss://cache.internal:6380");
    expect(opts).not.toHaveProperty("tls");
  });

  it("enables TLS on a host/port connection when the switch is on", async () => {
    const [opts] = (await connect({
      host: "cache.internal",
      port: 6379,
      password: "secret",
      tls: true,
    })) as [Record<string, unknown>];

    expect(opts).toMatchObject({
      host: "cache.internal",
      port: 6379,
      password: "secret",
      tls: {},
    });
  });

  it("leaves a host/port connection plaintext when the switch is off", async () => {
    const [opts] = (await connect({
      host: "127.0.0.1",
      port: 6379,
    })) as [Record<string, unknown>];

    expect(opts).not.toHaveProperty("tls");
  });

  it("keeps the pooling and reconnect bounds on both paths", async () => {
    // These turn an unreachable Redis into a fast rejection instead of a hang,
    // which every caller's fail-open/fail-closed policy depends on.
    const expected = {
      lazyConnect: true,
      connectTimeout: 5000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    };

    const [, urlOpts] = await connect({ url: "redis://localhost:6379" });
    expect(urlOpts).toMatchObject(expected);

    const [hostOpts] = (await connect({ host: "127.0.0.1", port: 6379 })) as [
      Record<string, unknown>,
    ];
    expect(hostOpts).toMatchObject(expected);
  });

  it("returns the same singleton for later calls, options and all", async () => {
    // Why the consumers must not re-declare their own options: whoever calls
    // first wins, so a partial option set could decide the whole process's
    // connection — and drop TLS from it.
    constructed.length = 0;
    await jest.isolateModulesAsync(async () => {
      const { connectRedis } = await import("../src/client.js");
      const first = connectRedis({ host: "127.0.0.1", port: 6379, tls: true });
      const second = connectRedis({ host: "other.host", port: 1234 });
      expect(second).toBe(first);
    });

    expect(constructed).toHaveLength(1);
  });
});
