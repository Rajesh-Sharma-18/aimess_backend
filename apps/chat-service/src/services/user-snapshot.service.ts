import { DELETED_ACCOUNT_DISPLAY_NAME } from "@aimess/constants";
import { logger } from "@aimess/logger";

import { isUserId } from "../lib/room-id.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import {
  fetchUsersBatch,
  fetchAccountsBatch,
} from "../lib/user-service-client.js";

export interface UserSnapshot {
  userId: string;
  displayName: string;
  avatar: string;
  memberId: string;
  isDeletedUser: boolean;
  isOnline: boolean;
}

// Auth-service has an account but user-service hasn't consumed `user.registered`
// yet, so the profile (and its displayName) doesn't exist. Cache this placeholder
// briefly instead of the normal 1h TTL so it self-heals as soon as the profile
// shows up, instead of serving an empty displayName for up to an hour.
const INCOMPLETE_SNAPSHOT_TTL_SECONDS = 30;

/**
 * The identity lookup for this id did not COMPLETE — user-service/auth-service
 * was unreachable, timed out, or its circuit breaker was open (a snapshot
 * cache failure alone is just a miss). It is NOT the same as "this user does not exist", which produces a
 * placeholder snapshot without the flag and legitimately renders as
 * "Unknown User".
 *
 * Any serializer whose output a client CACHES (the conversation list, room
 * details) must refuse rather than render a flagged snapshot: the placeholder
 * is indistinguishable from a real name on the wire, so a client that stores
 * the row has nothing to tell it to look again, and a two-second blip shows as
 * "Unknown User" until the page is reloaded.
 */
export function isUnresolvedSnapshot(
  snapshot: Record<string, unknown> | null | undefined
): boolean {
  return snapshot?.isUnresolved === true;
}

/**
 * Best available display name, in priority order: fullName → displayName →
 * username → memberId → "Unknown User". Centralized here so every caller of
 * getUserSnapshotsMap resolves a name the same way instead of each serializer
 * inventing its own fallback (or none at all, which is how empty strings leak
 * into API responses).
 *
 * A deleted account short-circuits the whole chain. This is chat-service's
 * ONE name chokepoint — the private conversation list, private room details,
 * group member list, group roster, group pins, message reactions, read
 * receipts and invite links all route through it — so overriding here is what
 * makes "Deleted Account" appear on every one of those surfaces at once,
 * rather than each of them hardcoding the string. Checked BEFORE the candidate
 * chain because a stale snapshot may still carry the old memberId.
 *
 * Reached only for a snapshot that is NOT {@link isUnresolvedSnapshot} on any
 * surface a client caches — see that function for why.
 */
export function resolveDisplayName(
  snapshot: Record<string, unknown> | null | undefined
): string {
  if (!snapshot) return "Unknown User";
  if (snapshot.isDeletedUser === true) return DELETED_ACCOUNT_DISPLAY_NAME;
  const candidates = [
    snapshot.fullName,
    snapshot.displayName,
    snapshot.username,
    snapshot.memberId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return "Unknown User";
}

/**
 * The sender's REAL live name, or `""` when there is none to show.
 *
 * Same candidate chain as {@link resolveDisplayName} minus its placeholders: a
 * deleted account and a profile that resolved to nothing both come back empty
 * rather than as "Deleted Account" / "Unknown User". Callers that BACKFILL a
 * name into a stored sentence need that distinction — writing a placeholder
 * into `systemData.actorName` would bake "Unknown User shared a group invite"
 * onto the row, where leaving the gap lets the renderer fall back to its own
 * neutral "Someone …" wording.
 */
export function resolveRealDisplayName(
  snapshot: Record<string, unknown> | null | undefined
): string {
  if (!snapshot || snapshot.isDeletedUser === true) return "";
  for (const candidate of [
    snapshot.fullName,
    snapshot.displayName,
    snapshot.username,
    snapshot.memberId,
  ]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return "";
}

/**
 * User snapshot service — fetches user info from Redis cache.
 * Falls back to a minimal placeholder if not cached.
 * In production, a background worker periodically syncs from user-service.
 */
export class UserSnapshotService {
  /**
   * Get user snapshots for a list of user IDs.
   * Returns a Map of userId → snapshot data.
   */
  async getUserSnapshotsMap(
    userIds: string[],
    cacheRepo: CacheRepository
  ): Promise<Map<string, Record<string, unknown>>> {
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    if (!uniqueIds.length) return new Map();

    try {
      // A cache outage is a MISS, not a failed identity lookup. Refusing here
      // answered 503 for every inbox during a Redis blip even though
      // user-service — the actual identity source — was perfectly healthy.
      // Everything below then fetches upstream, and only a failure THERE
      // flags ids as unresolved.
      const cached = await cacheRepo
        .getUserSnapshots(uniqueIds)
        .catch((error: unknown) => {
          logger.warn(
            `UserSnapshotService|getUserSnapshotsMap|cache read failed, falling back to user-service|ids=${uniqueIds.length}|error=${error}`
          );
          return new Map<string, Record<string, unknown>>();
        });

      // A non-UUID id ("undefined", a `grp_` room id, junk written by a
      // pre-validation `POST /rooms/:peerId`) can never be a user, so it is a
      // permanently MISSING identity, never a failed lookup. It must also never
      // reach the upstream batch: both identity columns are Postgres `uuid`, so
      // ONE such id makes user-service AND auth-service answer INTERNAL for the
      // whole batch — every real peer on the page came back unresolved (a
      // CHAT_IDENTITY_UNAVAILABLE no retry could clear), and the failures fed
      // the shared circuit breakers, taking the lookup down for other users too.
      const missingIds = uniqueIds.filter(
        (id) => !cached.has(id) && isUserId(id)
      );

      // Set by either lookup returning `null` — "I could not ask", as opposed to
      // "I asked and this id is not mine". Only the first of those may be
      // reported as an unresolved identity; the second is a genuinely missing
      // user and keeps today's placeholder.
      let lookupFailed = false;

      if (missingIds.length > 0) {
        const fetched = await fetchUsersBatch(missingIds);
        if (fetched === null) lookupFailed = true;
        for (const user of fetched ?? []) {
          const snapshot: Record<string, unknown> = {
            userId: user.userId,
            // Already anonymized upstream for deleted accounts (displayName is
            // the shared literal, username/avatar are ""); nothing to blank here.
            displayName: user.displayName,
            avatar: user.avatar,
            memberId: user.username,
            isDeletedUser: user.isDeleted,
            // A deleted account is never online. Presence is separately masked
            // on read, but pinning it false here stops a cached snapshot from
            // ever describing the account as active.
            isOnline: user.isDeleted ? false : user.isOnline,
          };
          cached.set(user.userId, snapshot);
          cacheRepo.setUserSnapshot(user.userId, snapshot).catch(() => {});
        }
      }

      // Still missing after user-service? Fall back to auth-service account name.
      // This happens when user-service has no profile yet (user.registered event not consumed).
      //
      // A DELETED user never reaches here: user-service returns deleted
      // profiles (anonymized) rather than omitting them, so the id is already
      // in `cached` above. And if the profile row genuinely never existed,
      // auth-service's bulkGetAccounts filters deleted rows out — so this path
      // can never resurrect a deleted account's login handle either way.
      const stillMissingIds = uniqueIds.filter(
        (id) => !cached.has(id) && isUserId(id)
      );
      if (stillMissingIds.length > 0) {
        const accounts = await fetchAccountsBatch(stillMissingIds);
        if (accounts === null) lookupFailed = true;
        for (const entry of accounts ?? []) {
          const snapshot: Record<string, unknown> = {
            userId: entry.userId,
            displayName: "", // no full name yet
            avatar: "",
            memberId: entry.account, // account = the login username
            username: entry.account,
            isDeletedUser: false,
            isOnline: false,
          };
          cached.set(entry.userId, snapshot);
          cacheRepo
            .setUserSnapshot(
              entry.userId,
              snapshot,
              INCOMPLETE_SNAPSHOT_TTL_SECONDS
            )
            .catch(() => {});
        }
      }

      for (const id of uniqueIds) {
        if (!cached.has(id)) {
          cached.set(id, {
            userId: id,
            displayName: "",
            avatar: "",
            memberId: "",
            isDeletedUser: false,
            isOnline: false,
            // NEVER cached: an outage must not outlive itself in Redis.
            ...(lookupFailed && isUserId(id) ? { isUnresolved: true } : {}),
          });
        }
      }

      return cached;
    } catch (error) {
      logger.warn(`UserSnapshotService|getUserSnapshotsMap|error=${error}`);
      // Unexpected: the cache read and both fetches report failure without
      // throwing. Nothing in this batch is known to have resolved.
      const fallback = new Map<string, Record<string, unknown>>();
      for (const id of uniqueIds) {
        fallback.set(id, {
          userId: id,
          displayName: "",
          avatar: "",
          memberId: "",
          isDeletedUser: false,
          isOnline: false,
          ...(isUserId(id) ? { isUnresolved: true } : {}),
        });
      }
      return fallback;
    }
  }

  /**
   * Resolve user identity with fallback.
   * Prefers snapshot data over fallback values.
   */
  resolveUserIdentity(
    snapshot: Record<string, unknown> | null,
    fallback: { userId?: string; displayName?: string; avatar?: string }
  ): { displayName: string; avatar: string; isDeletedUser: boolean } {
    if (!snapshot) {
      return {
        displayName: fallback.displayName || "Unknown User",
        avatar: fallback.avatar || "",
        isDeletedUser: false,
      };
    }

    return {
      displayName: resolveDisplayName(snapshot) || fallback.displayName || "",
      avatar: (snapshot.avatar as string) || fallback.avatar || "",
      isDeletedUser: snapshot.isDeletedUser === true,
    };
  }
}
