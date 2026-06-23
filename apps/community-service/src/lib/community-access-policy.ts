import { ForbiddenError } from "@aimess/errors";

import {
  CommunityModerationStatus,
  CommunityStatus,
} from "../generated/prisma/index.js";

/**
 * CommunityAccessPolicy — the single source of truth for "is this community
 * writable / joinable right now?".
 *
 * A community has THREE independent lifecycle axes:
 *   - `status`           — owner-controlled (ACTIVE | CLOSED). CLOSED is a
 *                          reversible "owner closed this community" state.
 *   - `moderationStatus` — platform/backoffice (ACTIVE | SUSPENDED).
 *   - `deletedAt`        — permanent soft-delete (handled by `findById`, which
 *                          returns null for deleted rows → NOT_FOUND).
 *
 * Either CLOSED or SUSPENDED makes the community non-writable. This module is
 * the ONLY place that interprets those flags — never scatter
 * `if (community.status === CLOSED)` checks through controllers/services/
 * consumers. Adding a future status value means editing ONLY this file.
 *
 * Backward-compat: a legacy row with `status` absent/null is treated as ACTIVE.
 */

/** The minimal lifecycle shape the policy reads. */
export interface CommunityLifecycleState {
  status?: CommunityStatus | null;
  moderationStatus: CommunityModerationStatus;
}

/** Owner-closed (status axis). Absent/null ⇒ ACTIVE (backward-compat). */
export function isOwnerClosed(c: { status?: CommunityStatus | null }): boolean {
  return (c.status ?? CommunityStatus.ACTIVE) === CommunityStatus.CLOSED;
}

/** Platform-suspended (moderation axis). */
export function isPlatformSuspended(c: {
  moderationStatus: CommunityModerationStatus;
}): boolean {
  return c.moderationStatus === CommunityModerationStatus.SUSPENDED;
}

/** True when either axis renders the community non-writable. */
export function isEffectivelyClosed(c: CommunityLifecycleState): boolean {
  return isOwnerClosed(c) || isPlatformSuspended(c);
}

/**
 * Owner-facing status for serialization into every API/socket response.
 * Absent/null ⇒ "ACTIVE". This is the ONLY value clients should branch on for
 * "is the community open?" — `moderationStatus` is a separate platform concern.
 */
export function deriveStatus(c: {
  status?: CommunityStatus | null;
}): "ACTIVE" | "CLOSED" {
  return isOwnerClosed(c) ? "CLOSED" : "ACTIVE";
}

/**
 * Assert the community can be mutated right now. CLOSED (owner) and SUSPENDED
 * (platform) raise DISTINCT errors so the client can message correctly. Call
 * after the community is loaded in EVERY mutating path: update, join, approve,
 * add members, member moderation (kick/ban/mute/warn), etc.
 *
 * Read-only paths (view/list/messages history) and the close/reopen lifecycle
 * actions themselves intentionally do NOT call this.
 */
export function assertWritable(c: CommunityLifecycleState): void {
  if (isOwnerClosed(c)) {
    throw new ForbiddenError("COMMUNITY_IS_CLOSED");
  }
  if (isPlatformSuspended(c)) {
    throw new ForbiddenError("COMMUNITY_SUSPENDED");
  }
}

/** Same gate, semantically named for join / approve / invite-redeem paths. */
export function assertJoinable(c: CommunityLifecycleState): void {
  assertWritable(c);
}

export const communityAccessPolicy = {
  isOwnerClosed,
  isPlatformSuspended,
  isEffectivelyClosed,
  deriveStatus,
  assertWritable,
  assertJoinable,
};
