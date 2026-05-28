import { nanoid } from "nanoid";

/**
 * Generate a unique room ID with a prefix.
 * Format: `{prefix}_{nanoid(16)}`
 */
export function generateRoomId(prefix = "room"): string {
  return `${prefix}_${nanoid(16)}`;
}

/**
 * Build a deterministic participants key for a private room.
 * Sorts the two user IDs lexicographically and joins with `:`.
 * This ensures one room per pair regardless of who initiates.
 */
export function buildParticipantsKey(userId1: string, userId2: string): string {
  const sorted = [userId1, userId2].sort();
  return `${sorted[0]}:${sorted[1]}`;
}

/**
 * Build a deterministic pair key for friendships.
 * Same logic as participants key.
 */
export function buildPairKey(userId1: string, userId2: string): string {
  return buildParticipantsKey(userId1, userId2);
}
