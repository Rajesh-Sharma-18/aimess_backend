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
 *    in the member's own list. ACTIVE and non-dismissed BANNED are visible;
 *    LEFT (voluntary or kicked) and dismissed-BANNED are not. The Prisma
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
    m: { status: CommunityMemberStatus; dismissedAt?: Date | null } | null
  ): boolean {
    if (!m) return false;
    if (m.status === CommunityMemberStatus.ACTIVE) return true;
    return m.status === CommunityMemberStatus.BANNED && !m.dismissedAt;
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
