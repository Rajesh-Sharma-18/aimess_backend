// PrivateRoom.blockedBy is non-empty while either participant blocks the other.
export function isBlockedRoom(blockedBy: unknown): boolean {
  return Array.isArray(blockedBy) && blockedBy.length > 0;
}
