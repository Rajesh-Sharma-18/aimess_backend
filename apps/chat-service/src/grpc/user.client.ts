import { logger } from "@aimess/logger";
import { FriendshipRepository } from "../repositories/friendship.repository.js";

export interface UserServiceClient {
  checkFriendship(userA: string, userB: string): Promise<boolean>;
  isFriendshipBlocked(userA: string, userB: string): Promise<boolean>;
  getFriendshipStatus(userA: string, userB: string): Promise<string | null>;
}

export function createUserServiceClient(): UserServiceClient {
  const friendshipRepo = new FriendshipRepository();

  return {
    // Check if two users are friends (ACTIVE status)
    checkFriendship: async (userA: string, userB: string): Promise<boolean> => {
      try {
        const areFriends = await friendshipRepo.areFriends(userA, userB);
        logger.debug(`Friendship check: ${userA} ↔ ${userB} = ${areFriends}`);
        return areFriends;
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
