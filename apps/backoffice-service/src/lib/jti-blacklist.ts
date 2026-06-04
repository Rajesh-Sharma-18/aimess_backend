import { redis } from "../config/redis.js";

const JTI_BLACKLIST_PREFIX = "aimess:admin:jti:blk:";

function jtiKey(jti: string): string {
  return `${JTI_BLACKLIST_PREFIX}${jti}`;
}

/**
 * Blacklist a JWT id until it would have expired anyway (ttlSeconds), so the
 * key self-cleans. Used on logout / forced revocation.
 */
export async function blacklistJti(
  jti: string,
  ttlSeconds: number
): Promise<void> {
  const ttl = Math.max(1, Math.floor(ttlSeconds));
  await redis.set(jtiKey(jti), "1", "EX", ttl);
}

export async function isJtiBlacklisted(jti: string): Promise<boolean> {
  const value = await redis.get(jtiKey(jti));
  return value === "1";
}
