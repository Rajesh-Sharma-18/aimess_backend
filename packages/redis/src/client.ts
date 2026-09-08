import Redis from "ioredis";

let redis: Redis | undefined;

export const connectRedis = ({
  url,
  host,
  port,
  username,
  password,
  tls,
}: {
  /**
   * Full `redis://` / `rediss://` URL, as an alternative to the parts below.
   * api-gateway declares only REDIS_URL, so without this it could not populate
   * the singleton at all and every `getRedis()` call threw.
   */
  url?: string;
  host?: string;
  port?: number;
  /** ACL user. Omit for a password-only (`requirepass`) server. */
  username?: string;
  /**
   * Omit for an unauthenticated server (local dev). Required by any Redis
   * reachable off-box — a shared/remote instance must not be left open, and
   * without this the client fails every command with NOAUTH.
   */
  password?: string;
  /**
   * Wrap the connection in TLS.
   *
   * The client had no TLS option at all, so every deployment that reached Redis
   * across hosts did so in cleartext — including one that dialled a Redis on a
   * different network block entirely. That exposes the AUTH password and, since
   * Redis pub/sub is this platform's realtime fan-out, the body of every chat
   * and community message to anyone able to observe the path.
   *
   * Off by default so a local, loopback, or private-network Redis is unchanged.
   * Services pass `REDIS_TLS=true` where the connection leaves the host.
   */
  tls?: boolean;
}): Redis => {
  if (!redis) {
    const common = {
      lazyConnect: true,
      // Fail fast when Redis is unreachable/misconfigured so callers' try/catch
      // can fall back instead of the request hanging forever. (A hung command
      // cannot be caught — these bounds turn a hang into a fast rejection.)
      connectTimeout: 5000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (attempt: number) => Math.min(attempt * 200, 2000),
    } as const;

    redis = url
      ? new Redis(url, { ...common })
      : new Redis({
          host,
          port,
          // ioredis sends AUTH only when these are set, so leaving them
          // undefined keeps the no-auth dev path byte-identical to before.
          username,
          password,
          // `{}` selects Node's default TLS settings (verified certificate
          // chain, SNI from `host`). ioredis only speaks TLS when this key is
          // present, so omitting it entirely keeps the plaintext path unchanged.
          ...(tls ? { tls: {} } : {}),
          ...common,
        });
    // Without a listener, ioredis throws unhandled 'error' events when Redis is
    // down and crashes the process; log + swallow so the service stays up.
    redis.on("error", () => {
      /* connection errors surface as command rejections; avoid crashing here */
    });
  }
  return redis;
};

export function getRedis(): Redis {
  if (!redis) {
    throw new Error("Redis client not initialized. Call connectRedis() first.");
  }
  return redis;
}

/**
 * A SEPARATE connection, for subscriber mode.
 *
 * `connectRedis` returns a process-wide SINGLETON. Calling `subscribe` or
 * `psubscribe` on it puts that shared client into subscriber mode, after which
 * ioredis rejects every ordinary command on it with "Connection in subscriber
 * mode, only subscriber commands may be used" — which silently killed
 * `cacheGetJson` / `cacheSetJson` for the entire process. Measured in
 * notifications-service: 114 failures/hour, every notification-settings read
 * and write, with the cache falling through to gRPC on every push.
 *
 * `duplicate()` clones the singleton's options, so host / port / auth / TLS are
 * identical. The clone carries `lazyConnect`, so the caller must connect it.
 */
export function createSubscriber(): Redis {
  return getRedis().duplicate();
}
