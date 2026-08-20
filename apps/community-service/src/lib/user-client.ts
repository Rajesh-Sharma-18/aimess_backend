import { logger } from "@aimess/logger";

import { userGrpcClient } from "../grpc/user.client.js";

export type UserSnapshot = {
  userId: string;
  username: string;
  displayName: string;
  avatarObjectKey: string | null;
  /** Account deleted — render "Deleted Account", expose no member actions. */
  isDeleted: boolean;
};

const FALLBACK_SNAPSHOT = (userId: string): UserSnapshot => ({
  userId,
  username: userId,
  displayName: "Unknown",
  avatarObjectKey: null,
  isDeleted: false,
});

/**
 * Returns a map of ONLY the users user-service actually resolved — no
 * `"Unknown"` placeholder back-fill. A userId absent from the returned map was
 * not resolved, either because the profile is genuinely gone OR because
 * user-service was unavailable (gRPC error / breaker open → empty map).
 *
 * Read paths that already hold a denormalized snapshot (e.g. the community
 * member list, whose membership docs persist last-known-good name/avatar) MUST
 * use this instead of {@link fetchUserSnapshots}: a transient user-service
 * hiccup then leaves the stored snapshot intact rather than clobbering every
 * member's real name with the `"Unknown"` placeholder.
 */
export async function fetchUserSnapshotHits(
  userIds: string[]
): Promise<Map<string, UserSnapshot>> {
  if (userIds.length === 0) return new Map();

  try {
    const users = await userGrpcClient.bulkGetUserSnapshots(userIds);
    return new Map<string, UserSnapshot>(
      users.map((u) => [
        u.userId,
        {
          userId: u.userId,
          username: u.username,
          displayName: u.displayName,
          avatarObjectKey: u.avatarObjectKey === "" ? null : u.avatarObjectKey,
          isDeleted: u.isDeleted === true,
        },
      ])
    );
  } catch (error) {
    logger.error(
      "fetchUserSnapshotHits (gRPC) failed — caller will fall back to stored data"
    );
    logger.error(error);
    return new Map();
  }
}

export async function fetchUserSnapshots(
  userIds: string[]
): Promise<Map<string, UserSnapshot>> {
  if (userIds.length === 0) return new Map();

  // Resolve the real hits, then back-fill a placeholder for any id user-service
  // did not return so callers WITHOUT a stored snapshot always get a name.
  const map = await fetchUserSnapshotHits(userIds);
  for (const id of userIds) {
    if (!map.has(id)) {
      logger.warn(`User snapshot missing for userId=${id}, using fallback`);
      map.set(id, FALLBACK_SNAPSHOT(id));
    }
  }
  return map;
}

/**
 * Returns the subset of `userIds` that correspond to REAL existing users in
 * user-service. Unlike {@link fetchUserSnapshots} (which back-fills a placeholder
 * snapshot for every requested id so callers always get a name), this preserves
 * the gap: an id absent from the result simply does not exist. Use it to validate
 * recipients before fanning out.
 *
 * Returns `null` when the user-service lookup is UNAVAILABLE (gRPC error / breaker
 * open) — distinct from "exists but empty" — so callers can decide whether to
 * fail-open or fail-closed rather than mistaking an outage for "no users exist".
 */
export async function fetchExistingUserIds(
  userIds: string[]
): Promise<Set<string> | null> {
  if (userIds.length === 0) return new Set();

  try {
    const users = await userGrpcClient.bulkGetUserSnapshots(userIds);
    // `isDeleted` rows are returned by the RPC (so history can render them) but
    // they are NOT existing users for this question. Every caller here is
    // gating an action that requires a live account — invite, add member,
    // notify — and a deleted account must fail all three.
    return new Set(users.filter((u) => !u.isDeleted).map((u) => u.userId));
  } catch (error) {
    logger.error(
      "fetchExistingUserIds (gRPC) failed — user existence could not be verified"
    );
    logger.error(error);
    return null;
  }
}

/**
 * Why an invite may not be sent to a recipient. `null`/absent = eligible.
 *
 *  - NOT_FOUND  — no such account.
 *  - DELETED    — the account was deleted (tombstone; renders in history only).
 *  - SUSPENDED  — admin-banned/suspended; they cannot log in to act on it.
 *  - BLOCKED    — a block exists in EITHER direction between the two users.
 */
export type InviteIneligibility =
  | "NOT_FOUND"
  | "DELETED"
  | "SUSPENDED"
  | "BLOCKED";

/**
 * Wire code for each ineligibility — ALSO the `@aimess/constants` message key,
 * so the controller localizes with `t(code, locale)` and clients can map the
 * code themselves. Shared verbatim with chat-service's group invite bulk-send.
 */
export const INVITE_INELIGIBILITY_CODE: Record<InviteIneligibility, string> = {
  NOT_FOUND: "INVITE_RECIPIENT_NOT_FOUND",
  DELETED: "INVITE_RECIPIENT_DELETED",
  SUSPENDED: "INVITE_RECIPIENT_SUSPENDED",
  BLOCKED: "INVITE_RECIPIENT_BLOCKED",
};

/**
 * ONE eligibility gate for every invite path (direct invites AND invite-link
 * bulk-share). Two batch RPCs, never per-user.
 *
 * FAILS OPEN on a user-service outage — an eligible send must not be blocked by
 * a verification blip, and every one of these states is re-checked at redeem /
 * accept time. That mirrors the pre-existing `fetchExistingUserIds` policy.
 */
export async function fetchInviteIneligibility(
  callerId: string,
  candidateIds: string[]
): Promise<Map<string, InviteIneligibility>> {
  const out = new Map<string, InviteIneligibility>();
  if (candidateIds.length === 0) return out;

  const [snapshots, relationships] = await Promise.all([
    userGrpcClient
      .bulkGetUserSnapshots(candidateIds)
      .catch((error: unknown) => {
        logger.error(
          "fetchInviteIneligibility: snapshot lookup failed — failing open"
        );
        logger.error(error);
        return null;
      }),
    userGrpcClient
      .checkRelationships(callerId, candidateIds)
      .catch((error: unknown) => {
        logger.error(
          "fetchInviteIneligibility: relationship lookup failed — failing open"
        );
        logger.error(error);
        return null;
      }),
  ]);

  if (snapshots) {
    const byId = new Map(snapshots.map((u) => [u.userId, u]));
    for (const id of candidateIds) {
      const snap = byId.get(id);
      if (!snap) out.set(id, "NOT_FOUND");
      else if (snap.isDeleted) out.set(id, "DELETED");
      else if (snap.isSuspended) out.set(id, "SUSPENDED");
    }
  }

  // A block outranks nothing — an id already marked DELETED/SUSPENDED keeps
  // that (more specific) reason; only eligible ids can become BLOCKED.
  if (relationships) {
    for (const rel of relationships) {
      if (rel.blockedEitherWay && !out.has(rel.userId)) {
        out.set(rel.userId, "BLOCKED");
      }
    }
  }

  return out;
}

export async function fetchAcceptedFriendIds(
  callerId: string,
  candidateIds: string[]
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();

  try {
    const friendIds = await userGrpcClient.checkFriendships(
      callerId,
      candidateIds
    );
    return new Set(friendIds);
  } catch (error) {
    logger.error(
      "fetchAcceptedFriendIds (gRPC) failed — treating all candidates as NOT_FRIEND"
    );
    logger.error(error);
    return new Set();
  }
}
