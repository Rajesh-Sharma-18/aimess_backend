import Redis from "ioredis";

let redis: Redis | undefined;

export const connectRedis = ({
  host,
  port,
  username,
  password,
  tls,
}: {
  host: string;
  port: number;
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
    redis = new Redis({
      host,
      port,
      // ioredis sends AUTH only when these are set, so leaving them undefined
      // keeps the no-auth dev path byte-identical to before.
      username,
      password,
      // `{}` selects Node's default TLS settings (verified certificate chain,
      // SNI from `host`). ioredis only speaks TLS when this key is present, so
      // omitting it entirely is what keeps the plaintext path unchanged.
      ...(tls ? { tls: {} } : {}),
      lazyConnect: true,
      // Fail fast when Redis is unreachable/misconfigured so callers' try/catch
      // can fall back instead of the request hanging forever. (A hung command
      // cannot be caught — these bounds turn a hang into a fast rejection.)
      connectTimeout: 5000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
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
