import type { Cluster, Redis } from "ioredis";

// Per-USER kill switch for a permanent Super Admin system ban.
//
// Distinct from `session-active.ts`, which is keyed by SESSION: revoking every
// session of a user stops their CURRENT tokens, but says nothing about a user
// as such. Two services (community-service, stream-service) do not wire the
// session check at all, and a session created in the same millisecond as the
// ban would slip past it — so the ban itself needs its own durable, user-keyed
// flag every authenticated surface can read in one Redis GET.
//
// No TTL: a ban is permanent until a Super Admin explicitly unbans, which DELs
// the key. Written by auth-service (the only owner of AuthUser.status) at the
// moment the status flips, so the key and the database row are set together.
const USER_BANNED_PREFIX = "aimess:user:banned:";

export function userBannedKey(userId: string): string {
  return `${USER_BANNED_PREFIX}${userId}`;
}

// Flag a user as system-banned. Idempotent.
export async function markUserBanned(
  redis: Redis | Cluster,
  userId: string
): Promise<void> {
  await redis.set(userBannedKey(userId), "1");
}

// Lift a system ban. Idempotent — a DEL on a missing key is a no-op.
export async function clearUserBanned(
  redis: Redis | Cluster,
  userId: string
): Promise<void> {
  await redis.del(userBannedKey(userId));
}

// `true` only when the user is positively known to be banned.
//
// Callers decide the failure policy. The shared REST guard and the socket
// handshake both fail OPEN on a Redis error, matching the existing
// `getActiveSessionFromCache` policy: a Redis blip must not sign the whole
// platform out, and session revocation is an independent second layer that
// still holds the ban.
export async function isUserBanned(
  redis: Redis | Cluster,
  userId: string
): Promise<boolean> {
  return (await redis.get(userBannedKey(userId))) === "1";
}

// Ready-made predicate for `createAuthenticateAccessToken`'s
// `assertUserBanned` option, so all seven services wire the guard identically
// with one line each instead of hand-rolling the fail-policy.
//
// Fails OPEN on a Redis error, matching `isSessionActiveForRequest`: a Redis
// outage must not 403 the entire platform, and session revocation is an
// independent second layer that still holds every ban applied before the blip.
// `getRedis` is a thunk so the service's lazily-connected singleton is read at
// call time, not at module load.
export function createBannedUserGuard(
  getRedis: () => Redis | Cluster
): (userId: string) => Promise<boolean> {
  return async (userId: string) => {
    try {
      return await isUserBanned(getRedis(), userId);
    } catch {
      return false;
    }
  };
}

// Batch variant for list/DTO paths (inbox rows, rosters) so marking a page of
// peers is one MGET, never an N+1. Returns the subset that is banned.
export async function filterBannedUserIds(
  redis: Redis | Cluster,
  userIds: string[]
): Promise<Set<string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Set();
  const values = await redis.mget(...unique.map(userBannedKey));
  const banned = new Set<string>();
  unique.forEach((userId, index) => {
    if (values[index] === "1") banned.add(userId);
  });
  return banned;
}
