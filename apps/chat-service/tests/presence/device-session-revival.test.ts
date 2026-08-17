/**
 * CacheRepository device sessions — the revival rule.
 *
 * A heartbeat only ever arrives from a socket that is live right now. If the
 * session hash expired in the meantime (slept machine, Redis blip, a refresh
 * window missed by more than the TTL), the heartbeat recreates it — and the
 * recreated hash MUST still say `realtimeConnected: "1"`, or `recompute` reads
 * the user as offline forever while their socket stays open ("Last seen just
 * now" on a connected peer).
 */
import { CacheRepository } from "../../src/repositories/cache.repository.js";

/** Hash-only Redis double — just enough for the device-session paths. */
function makeFakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  return {
    hashes,
    redis: {
      hmset: async (key: string, values: Record<string, string>) => {
        hashes.set(key, { ...(hashes.get(key) ?? {}), ...values });
        return "OK";
      },
      hset: async (key: string, field: string, value: string) => {
        hashes.set(key, { ...(hashes.get(key) ?? {}), [field]: value });
        return 1;
      },
      expire: async () => 1,
      scan: async (_cursor: string, _m: string, pattern: string) => [
        "0",
        [...hashes.keys()].filter((k) => k.startsWith(pattern.slice(0, -1))),
      ],
      pipeline: () => {
        const keys: string[] = [];
        return {
          hgetall: (key: string) => keys.push(key),
          exec: async () =>
            keys.map((key) => [null, hashes.get(key) ?? {}] as const),
        };
      },
    } as never,
  };
}

const isOnline = (sessions: Array<Record<string, string>>): boolean =>
  sessions.some((s) => s.realtimeConnected === "1");

describe("CacheRepository — device-session revival", () => {
  it("heartbeat on an EXPIRED session rebuilds it as connected", async () => {
    const { redis, hashes } = makeFakeRedis();
    const repo = new CacheRepository(redis);

    await repo.upsertDeviceSession({
      userId: "u1",
      deviceId: "sock-1",
      socketId: "",
      platform: "web",
      clientType: "web",
      realtimeConnected: true,
      appState: "FOREGROUND",
      now: Date.now(),
    });
    expect(isOnline(await repo.getDeviceSessions("u1"))).toBe(true);

    hashes.clear(); // TTL lapsed while the socket stayed open

    await repo.heartbeat({ userId: "u1", deviceId: "sock-1", now: Date.now() });
    expect(isOnline(await repo.getDeviceSessions("u1"))).toBe(true);
  });

  it("setAppState on an EXPIRED session rebuilds it as connected", async () => {
    const { redis, hashes } = makeFakeRedis();
    const repo = new CacheRepository(redis);

    hashes.clear();
    await repo.setAppState("u1", "sock-1", "FOREGROUND", Date.now());

    const sessions = await repo.getDeviceSessions("u1");
    expect(isOnline(sessions)).toBe(true);
    expect(sessions[0]?.appState).toBe("FOREGROUND");
  });

  it("a disconnected session stays disconnected", async () => {
    const { redis } = makeFakeRedis();
    const repo = new CacheRepository(redis);

    await repo.upsertDeviceSession({
      userId: "u1",
      deviceId: "sock-1",
      socketId: "",
      platform: "web",
      clientType: "web",
      realtimeConnected: true,
      appState: "FOREGROUND",
      now: Date.now(),
    });
    await repo.setDisconnected({
      userId: "u1",
      deviceId: "sock-1",
      nowMs: Date.now(),
    });

    expect(isOnline(await repo.getDeviceSessions("u1"))).toBe(false);
  });
});
