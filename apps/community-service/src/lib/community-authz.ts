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
