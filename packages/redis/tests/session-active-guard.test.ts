/**
 * AIM-06 — the predicate that makes logout actually end a session in
 * community-service, stream-service and media-service.
 *
 * Those three verified the JWT signature and nothing else, so a token stayed
 * usable after the user logged out or remotely terminated the device: the
 * revocation writes this Redis marker, but a JWT already in an attacker's hands
 * cannot be un-issued. The truth table below is deliberately identical to the
 * per-service helpers auth, user, chat and notifications already used, so
 * wiring it adds the check without changing anything else.
 */
import type { Redis } from "ioredis";

import {
  createSessionActiveGuard,
  sessionActiveRedisKey,
} from "../src/session-active.js";

/** Minimal Redis stand-in: only `get` is exercised by the guard. */
function fakeRedis(get: (key: string) => Promise<string | null>): Redis {
  return { get: jest.fn(get) } as unknown as Redis;
}

describe("createSessionActiveGuard", () => {
  it("denies a session that was explicitly revoked", async () => {
    // This is the case the three services could not see at all.
    const guard = createSessionActiveGuard(() => fakeRedis(async () => "0"));
    await expect(guard("sess-1")).resolves.toBe(false);
  });

  it("allows a session explicitly marked active", async () => {
    const guard = createSessionActiveGuard(() => fakeRedis(async () => "1"));
    await expect(guard("sess-1")).resolves.toBe(true);
  });

  it("allows a session with no marker, so pre-existing logins keep working", async () => {
    const guard = createSessionActiveGuard(() => fakeRedis(async () => null));
    await expect(guard("sess-1")).resolves.toBe(true);
  });

  it("fails open on a Redis error rather than signing the platform out", async () => {
    const guard = createSessionActiveGuard(() =>
      fakeRedis(async () => {
        throw new Error("connection refused");
      })
    );
    await expect(guard("sess-1")).resolves.toBe(true);
  });

  it("skips the lookup entirely when the cache is not ready", async () => {
    const redis = fakeRedis(async () => "0");
    const guard = createSessionActiveGuard(
      () => redis,
      () => false
    );

    // Would deny if consulted — the point is that it is not consulted.
    await expect(guard("sess-1")).resolves.toBe(true);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("reads the same key the revoking services write", async () => {
    const redis = fakeRedis(async () => "0");
    const guard = createSessionActiveGuard(() => redis);

    await guard("sess-42");

    expect(redis.get).toHaveBeenCalledWith(sessionActiveRedisKey("sess-42"));
  });

  it("resolves the client through the thunk on every call, not at wiring time", async () => {
    // Services pass a lazily-connected singleton; reading it eagerly would
    // capture an unconnected client.
    let calls = 0;
    const guard = createSessionActiveGuard(() => {
      calls += 1;
      return fakeRedis(async () => "1");
    });

    await guard("sess-1");
    await guard("sess-2");

    expect(calls).toBe(2);
  });
});
