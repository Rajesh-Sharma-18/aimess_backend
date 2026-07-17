/**
 * Turns the viewer's raw friendship rows (from
 * `friendshipRepository.findAllForUser`) into a fast per-peer relationship
 * lookup, so callers can label search/discovery results with an explicit
 * friendship indicator without an extra DB query per user (no N+1).
 *
 * The `RelationshipStatus` vocabulary mirrors `user-discovery.service.ts`.
 */

import {
  buildFriendshipView,
  toSearchRelationship,
} from "./friendship-view.js";

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
  /** OUTGOING/INCOMING for PENDING, else null — mirrors `buildFriendshipView`. */
  direction: "OUTGOING" | "INCOMING" | null;
  canAccept: boolean;
  canReject: boolean;
  canCancel: boolean;
};

const NONE: PeerRelationship = {
  isFriend: false,
  relationshipStatus: "NONE",
  friendshipId: null,
  requesterId: null,
  direction: null,
  canAccept: false,
  canReject: false,
  canCancel: false,
};

type FriendshipRow = {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: string;
};

/**
 * Returns `(peerId) => PeerRelationship`, defaulting to NONE for strangers.
 * Direction/action flags are derived via the same `buildFriendshipView` +
 * `toSearchRelationship` used by the realtime `friend:*` socket payloads, so
 * the search REST response and the live update event never disagree.
 */
export function buildRelationshipLookup(
  viewerId: string,
  rows: FriendshipRow[]
): (peerId: string) => PeerRelationship {
  const byPeer = new Map<string, PeerRelationship>();
  for (const f of rows) {
    if (f.status !== "ACCEPTED" && f.status !== "PENDING") continue;
    const peerId = f.requesterId === viewerId ? f.addresseeId : f.requesterId;
    const search = toSearchRelationship(buildFriendshipView(viewerId, f));
    byPeer.set(peerId, {
      isFriend: f.status === "ACCEPTED",
      relationshipStatus: search.status,
      friendshipId: f.id,
      requesterId: f.status === "PENDING" ? f.requesterId : null,
      direction: search.direction,
      canAccept: search.canAccept,
      canReject: search.canReject,
      canCancel: search.canCancel,
    });
  }
  return (peerId) => byPeer.get(peerId) ?? NONE;
}

/**
 * Peer ids the viewer has an ACCEPTED friendship with — the sole source of
 * truth for "is this user a friend", independent of any private room.
 */
export function getFriendPeerIds(
  viewerId: string,
  rows: FriendshipRow[]
): string[] {
  return rows
    .filter((f) => f.status === "ACCEPTED")
    .map((f) => (f.requesterId === viewerId ? f.addresseeId : f.requesterId));
}
