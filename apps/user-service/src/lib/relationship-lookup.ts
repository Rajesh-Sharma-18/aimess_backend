/**
 * Turns the viewer's raw friendship rows (from
 * `friendshipRepository.findAllForUser`) into a fast per-peer relationship
 * lookup, so callers can label search/discovery results with an explicit
 * friendship indicator without an extra DB query per user (no N+1).
 *
 * The `RelationshipStatus` vocabulary mirrors `user-discovery.service.ts`.
 */

export type RelationshipStatus = "FRIEND" | "PENDING" | "NONE";

export type PeerRelationship = {
  /** True only for an ACCEPTED friendship — independent of any private room. */
  isFriend: boolean;
  relationshipStatus: RelationshipStatus;
  /** Friendship row id, present for FRIEND/PENDING; null when NONE. */
  friendshipId: string | null;
  /**
   * Who sent the PENDING request (userId). Null for FRIEND/NONE. FE compares
   * this to its own userId to tell sender ("Cancel Request") from receiver
   * ("Agree" / "Cancel Request") apart under the single PENDING status.
   */
  requesterId: string | null;
};

const NONE: PeerRelationship = {
  isFriend: false,
  relationshipStatus: "NONE",
  friendshipId: null,
  requesterId: null,
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
        requesterId: null,
      });
    } else if (f.status === "PENDING") {
      byPeer.set(peerId, {
        isFriend: false,
        relationshipStatus: "PENDING",
        friendshipId: f.id,
        requesterId: f.requesterId,
      });
    }
  }
  return (peerId) => byPeer.get(peerId) ?? NONE;
}
