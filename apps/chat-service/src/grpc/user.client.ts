import { logger } from "@aimess/logger";
import { FriendshipRepository } from "../repositories/friendship.repository.js";
import { userGrpcClient } from "./user-snapshot.client.js";

export interface UserServiceClient {
  checkFriendship(userA: string, userB: string): Promise<boolean>;
  isFriendshipBlocked(userA: string, userB: string): Promise<boolean>;
  /**
   * Is EITHER party blocking the other? A block is stored one-way, but its
   * effect on a DM is mutual — neither side may write into the conversation
   * afterwards. The write gate needs this rather than the directional check
   * above, or the BLOCKED party's refusal falls through to the friendship
   * branch and is reported as a plain "you are not friends", which is a
   * different situation with different copy and a different way out.
   */
  isBlockedEitherWay(userA: string, userB: string): Promise<boolean>;
  getFriendshipStatus(userA: string, userB: string): Promise<string | null>;
}

/** Short-lived negative cache for confirmed non-friends, so a client retrying a rejected
 *  send can't turn every attempt into a user-service round trip. Only DEFINITIVE denials are
 *  cached — never an inconclusive upstream. Kept short: an accepted friend request must not
 *  stay blocked, though in practice the consumer writes an ACTIVE row and the fast path above
 *  wins before this is ever consulted. */
const DENY_TTL_MS = 30_000;
const DENY_MAX_ENTRIES = 10_000;
const denyUntil = new Map<string, number>();

function rememberDenial(key: string): void {
  // Map preserves insertion order — drop the oldest rather than growing unbounded.
  if (denyUntil.size >= DENY_MAX_ENTRIES) {
    const oldest = denyUntil.keys().next().value;
    if (oldest !== undefined) denyUntil.delete(oldest);
  }
  denyUntil.set(key, Date.now() + DENY_TTL_MS);
}

function denialIsFresh(key: string): boolean {
  const expiresAt = denyUntil.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  denyUntil.delete(key);
  return false;
}

export function createUserServiceClient(): UserServiceClient {
  const friendshipRepo = new FriendshipRepository();

  /**
   * Authoritative second opinion for a local read-model MISS.
   *
   * Returns `true`/`false` when user-service answered, and `null` when the call
   * was inconclusive (transport failure / breaker open). A SUCCESSFUL call always
   * returns one relationship entry per requested candidate, so a missing entry can
   * only mean the transport failed — never "no relationship".
   */
  async function confirmFriendshipUpstream(
    userA: string,
    userB: string
  ): Promise<boolean | null> {
    const relationships = await userGrpcClient.checkFriendships(userA, [userB]);
    const info = relationships.get(userB);
    if (!info) return null;
    return info.status === "FRIEND";
  }

  return {
    // Check if two users are friends (ACTIVE status)
    checkFriendship: async (userA: string, userB: string): Promise<boolean> => {
      try {
        const localStatus = await friendshipRepo.getFriendshipStatus(
          userA,
          userB
        );
        if (localStatus === "ACTIVE") return true;
        // A local BLOCKED/BANNED row is a decision, not a gap — never heal past it.
        if (localStatus === "BLOCKED" || localStatus === "BANNED") {
          logger.debug(
            `Friendship check: ${userA} ↔ ${userB} = ${localStatus}`
          );
          return false;
        }

        // MISS. This local copy is event-sourced off `user.events` and is lossy —
        // a dropped message, a consumer that was down, or a friendship accepted
        // before the read-model path existed all leave NO row, which is
        // indistinguishable from "not friends". Rejecting on its say-so is what
        // produced FORBIDDEN/CHAT_FRIENDSHIP_REQUIRED for users the rest of the
        // app (which reads user-service directly) correctly shows as friends.
        // So confirm upstream before denying, and heal the row on the way.
        const key = `${userA}|${userB}`;
        if (denialIsFresh(key)) return false;

        const upstream = await confirmFriendshipUpstream(userA, userB);
        if (upstream === null) {
          // Inconclusive — same optimistic policy as a DB failure below.
          logger.warn(
            `Friendship check: ${userA} ↔ ${userB} unresolved upstream — allowing`
          );
          return true;
        }
        if (upstream) {
          await friendshipRepo.createFriendship(userA, userB, "ACTIVE");
          await friendshipRepo.createFriendship(userB, userA, "ACTIVE");
          logger.info(
            `Friendship read-model healed from user-service: ${userA} ↔ ${userB}`
          );
        } else {
          rememberDenial(key);
        }
        return upstream;
      } catch (err) {
        logger.error(
          `Error checking friendship for ${userA} ↔ ${userB}`,
          err instanceof Error ? err.message : String(err)
        );
        // Optimistic fallback: allow operation if DB check fails
        // The eventual consistency will correct it when events arrive
        return true;
      }
    },

    // Check if friendship is blocked
    isFriendshipBlocked: async (
      userA: string,
      userB: string
    ): Promise<boolean> => {
      try {
        const isBlocked = await friendshipRepo.isFriendshipBlocked(
          userA,
          userB
        );
        logger.debug(`Block check: ${userA} ↔ ${userB} = ${isBlocked}`);
        return isBlocked;
      } catch (err) {
        logger.error(
          `Error checking friendship block for ${userA} ↔ ${userB}`,
          err instanceof Error ? err.message : String(err)
        );
        return false;
      }
    },

    // Block in EITHER direction — see the interface doc.
    isBlockedEitherWay: async (
      userA: string,
      userB: string
    ): Promise<boolean> => {
      try {
        return await friendshipRepo.isBlockedEitherWay(userA, userB);
      } catch (err) {
        logger.error(
          `Error checking either-way block for ${userA} ↔ ${userB}`,
          err instanceof Error ? err.message : String(err)
        );
        return false;
      }
    },

    // Get friendship status (ACTIVE, BLOCKED, BANNED, PENDING, or null)
    getFriendshipStatus: async (
      userA: string,
      userB: string
    ): Promise<string | null> => {
      try {
        const status = await friendshipRepo.getFriendshipStatus(userA, userB);
        logger.debug(
          `Friendship status: ${userA} ↔ ${userB} = ${status ?? "NONE"}`
        );
        return status;
      } catch (err) {
        logger.error(
          `Error getting friendship status for ${userA} ↔ ${userB}`,
          err instanceof Error ? err.message : String(err)
        );
        return null;
      }
    },
  };
}
