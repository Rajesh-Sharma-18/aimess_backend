import { ForbiddenError } from "@aimess/errors";

import {
  CommunityMemberRole,
  CommunityMemberStatus,
} from "../generated/prisma/index.js";

/**
 * Privilege ordering for community roles. Higher rank = more privileges, so a
 * gate of "at least MODERATOR" is satisfied by MODERATOR and ADMIN alike.
 */
export const COMMUNITY_ROLE_RANK: Record<CommunityMemberRole, number> = {
  [CommunityMemberRole.MEMBER]: 0,
  [CommunityMemberRole.MODERATOR]: 1,
  [CommunityMemberRole.ADMIN]: 2,
};

/** A membership row that carries (at least) a role and status. */
export type CommunityMembershipGate = {
  role: CommunityMemberRole;
  status: CommunityMemberStatus;
};

/**
 * Assert the caller's membership is ACTIVE and ranks at or above `minRole`.
 *
 * Throws `ForbiddenError("COMMUNITY_FORBIDDEN")` when the membership is missing,
 * not ACTIVE, or below the required role. On success narrows `membership` to a
 * non-null `CommunityMembershipGate` for the rest of the calling scope.
 */
export function assertCommunityRole(
  membership: CommunityMembershipGate | null,
  minRole: CommunityMemberRole
): asserts membership is CommunityMembershipGate {
  if (
    !membership ||
    membership.status !== CommunityMemberStatus.ACTIVE ||
    COMMUNITY_ROLE_RANK[membership.role] < COMMUNITY_ROLE_RANK[minRole]
  ) {
    throw new ForbiddenError("COMMUNITY_FORBIDDEN");
  }
}

/**
 * Assert the caller is not BANNED from the community. Single source of truth for
 * the ban gate across access / join / invite / view paths, so the BANNED check
 * is no longer hand-rolled at each call site.
 *
 * Pass the caller's membership row (or null when they have none). Throws
 * `ForbiddenError("COMMUNITY_JOIN_BANNED")` only when the row exists AND is
 * BANNED; a missing row (non-member) or any non-banned status passes — callers
 * that additionally require ACTIVE membership should use `assertCommunityRole`.
 */
export function assertNotBanned(
  membership: { status: CommunityMemberStatus } | null
): void {
  if (membership?.status === CommunityMemberStatus.BANNED) {
    throw new ForbiddenError("COMMUNITY_JOIN_BANNED");
  }
}

/**
 * Central membership-status → capability policy (the "permission service").
 * Two independent axes:
 *
 *  - VISIBILITY (`canAppearInCommunityList`): whether the community shows up
 *    in the member's own list. ACTIVE, non-dismissed BANNED, and the
 *    non-dismissed post-unban row (LEFT with `unbannedAt` set — an admin
 *    lifted the ban but the user has NOT rejoined) are visible; an ordinary
 *    LEFT (voluntary leave or kick) and any dismissed row are not. The Prisma
 *    `memberVisibilityFilter` in community.repository.ts#listMineByActivity
 *    is the query-side mirror of this predicate — change them together.
 *
 *  - PERMISSION (everything else): whether the member may act. ONLY ACTIVE
 *    may read/send/react/edit/upload/join the socket room. LEFT/REMOVED are
 *    denied as non-members; BANNED is denied with USER_BANNED (enforced in
 *    chat-service's access-guard.ts, which owns every message/media path —
 *    see assertRoomMemberActive / assertCommunityReadAccess there).
 */
export const communityPermission = {
  canAppearInCommunityList(
    m: {
      status: CommunityMemberStatus;
      dismissedAt?: Date | null;
      unbannedAt?: Date | null;
    } | null
  ): boolean {
    if (!m) return false;
    if (m.status === CommunityMemberStatus.ACTIVE) return true;
    if (m.dismissedAt) return false;
    if (m.status === CommunityMemberStatus.BANNED) return true;
    return m.status === CommunityMemberStatus.LEFT && Boolean(m.unbannedAt);
  },
  canAccessCommunity(m: { status: CommunityMemberStatus } | null): boolean {
    return m?.status === CommunityMemberStatus.ACTIVE;
  },
  // All action capabilities collapse to "is an ACTIVE member" — kept as named
  // methods so call sites read as intent, not as a status comparison.
  canReadMessages(m: { status: CommunityMemberStatus } | null): boolean {
    return this.canAccessCommunity(m);
  },
  canSendMessages(m: { status: CommunityMemberStatus } | null): boolean {
    return this.canAccessCommunity(m);
  },
  canReact(m: { status: CommunityMemberStatus } | null): boolean {
    return this.canAccessCommunity(m);
  },
  canUploadMedia(m: { status: CommunityMemberStatus } | null): boolean {
    return this.canAccessCommunity(m);
  },
  canJoinSocket(m: { status: CommunityMemberStatus } | null): boolean {
    return this.canAccessCommunity(m);
  },
};

/**
 * The caller's membership state as it appears ON THE WIRE — the single shape
 * every surface must agree on: the community detail API (toCommunityData), the
 * community list API (enrichMineCommunities), AND the personal socket events
 * that announce a membership transition (`community:membership:restricted`).
 *
 * Having one derivation is the point: a realtime event must leave the client in
 * exactly the state a fresh GET would produce, so the UI after a socket update
 * is identical to the UI after a hard refresh. Emitting these fields ad-hoc per
 * call site is what previously let the socket payload disagree with the REST
 * response (socket said `membershipStatus: "LEFT"`, REST said `"NONE"`, and the
 * socket carried no `isJoined` at all — so a client that unbanned in place kept
 * rendering the composer instead of the Join Community button).
 */
export type CommunityMembershipState = {
  /**
   * True ONLY for an ACTIVE membership — the single question "may this caller
   * act as a member right now?". False for BANNED (access revoked) and for
   * every non-member state, so a client can gate the composer / member-only
   * UI on this one flag. This is the community DETAIL API's long-standing
   * semantics (see tests/community/get-by-id-banned-access.test.ts); the list
   * API previously hardcoded `true` for every listed row, which is exactly the
   * disagreement this shared derivation removes. Visibility ("does the row
   * appear in my list at all?") is a SEPARATE axis — see
   * communityPermission.canAppearInCommunityList.
   */
  isJoined: boolean;
  isBanned: boolean;
  /** "NONE" is the canonical non-member value, shared with the detail API. */
  membershipStatus: "ACTIVE" | "BANNED" | "NONE";
};

/**
 * Derive the wire membership state from a membership row (or null for "no row
 * at all"). A BANNED row is listed but not joined (read-only, `isBanned` drives
 * the banner). The post-unban row (LEFT) reports as a plain non-member: the ban
 * is cleared (`isBanned: false`) but membership was never restored, so the
 * client must show the join flow, not member UI.
 */
export function deriveMembershipState(
  m: { status: CommunityMemberStatus } | null | undefined
): CommunityMembershipState {
  const status = m?.status;
  if (status === CommunityMemberStatus.BANNED) {
    return { isJoined: false, isBanned: true, membershipStatus: "BANNED" };
  }
  if (status === CommunityMemberStatus.ACTIVE) {
    return { isJoined: true, isBanned: false, membershipStatus: "ACTIVE" };
  }
  return { isJoined: false, isBanned: false, membershipStatus: "NONE" };
}
