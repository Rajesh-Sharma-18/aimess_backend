/**
 * Turns the viewer's raw friendship rows (from
 * `friendshipRepository.findAllForUser`) into a fast per-peer relationship
 * lookup, so callers can label search/discovery results with an explicit
 * friendship indicator without an extra DB query per user (no N+1).
 *
 * The `RelationshipStatus` vocabulary mirrors `user-discovery.service.ts`.
 */

export type RelationshipStatus =
  | "FRIEND"
  | "PENDING_IN"
  | "PENDING_OUT"
  | "NONE";

export type PeerRelationship = {
  /** True only for an ACCEPTED friendship — independent of any private room. */
  isFriend: boolean;
  relationshipStatus: RelationshipStatus;
  /** Friendship row id, present for ACCEPTED/PENDING; null when NONE. */
  friendshipId: string | null;
};

const NONE: PeerRelationship = {
  isFriend: false,
  relationshipStatus: "NONE",
  friendshipId: null,
};

type FriendshipRow = {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: string;
};

/** Returns `(peerId) => PeerRelationship`, defaulting to NONE for strangers. */
export function buildRelationshipLookup(
  viewerId: string,
  rows: FriendshipRow[]
): (peerId: string) => PeerRelationship {
  const byPeer = new Map<string, PeerRelationship>();
  for (const f of rows) {
    const peerId = f.requesterId === viewerId ? f.addresseeId : f.requesterId;
    if (f.status === "ACCEPTED") {
      byPeer.set(peerId, {
        isFriend: true,
        relationshipStatus: "FRIEND",
        friendshipId: f.id,
      });
    } else if (f.status === "PENDING") {
      byPeer.set(peerId, {
        isFriend: false,
        relationshipStatus:
          f.requesterId === viewerId ? "PENDING_OUT" : "PENDING_IN",
        friendshipId: f.id,
      });
    }
  }
  return (peerId) => byPeer.get(peerId) ?? NONE;
}
