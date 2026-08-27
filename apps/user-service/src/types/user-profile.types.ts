import type { MediaObject } from "@aimess/shared-types";

import type { ProfileGenderValue } from "../lib/profile-fields.util.js";

import type { SignInProvider } from "./auth-account.types.js";

/** Profile fields returned by GET/PATCH /profiles/me. */
export type UserProfileData = {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  bio: string | null;
  /** Primary auth/login account from auth-service; null if unavailable. */
  account: string | null;
  /** Primary account email from auth-service; null if unset or auth unavailable. */
  email: string | null;
  /**
   * True once `email` has been proven by OTP. False when unset, still pending
   * verification, or auth-service is unavailable — clients treat it as "not
   * verified yet" and offer the link-email flow.
   */
  emailVerified: boolean;
  /**
   * True when the account has a password hash in auth-service — i.e. whether a
   * password confirmation is required by DELETE /auth/account and
   * PATCH /auth/password. This is the ONLY correct predicate for "show the
   * password field": `primaryAccount` is the first provider ever LINKED and is
   * null for anyone who registered with account + password and never linked an
   * email or social provider, so gating a password prompt on it hides the field
   * from exactly the users who need it. Defaults to true when auth-service is
   * unavailable — prompting for a password the server may not want is
   * recoverable; hiding one it does want is not.
   */
  hasPassword: boolean;
  /** True when a GOOGLE provider is linked in auth-service. */
  isGoogleLogin: boolean;
  /** True when an APPLE provider is linked in auth-service. */
  isAppleLogin: boolean;
  /**
   * First sign-in method ever linked (from auth-service). Returns null when
   * unset, when the field is missing on older records, or when auth-service is
   * unavailable — the field is always present for a consistent client contract.
   */
  primaryAccount: SignInProvider | null;
  /** Email of the linked Google account; null when Google is not linked or no email is available. Always present. */
  googleEmail: string | null;
  /** Email of the linked Apple account; null when Apple is not linked or no email is available. Always present. */
  appleEmail: string | null;
  /** ISO date (YYYY-MM-DD); null when the user hasn't set a date of birth. */
  dateOfBirth: string | null;
  gender: ProfileGenderValue | null;
  /** Presigned GET URL (private bucket). Refresh via profile API when expired. */
  avatarUrl: string | null;
  /** Seconds until `avatarUrl` expires; null if no avatar. */
  avatarUrlExpiresIn: number | null;
  /**
   * Nested media object for the avatar. Inner fields are all null when no avatar
   * is set. Additive alongside the legacy `avatarUrl`/`avatarUrlExpiresIn`.
   */
  avatar: MediaObject;
  updatedAt: string;
};

/**
 * Another user's profile as seen by a viewer — `GET /users/:userId`.
 *
 * Deliberately NOT a subset of [UserProfileData]: that shape carries `email`,
 * `account`, `dateOfBirth` and the linked-provider emails, none of which may
 * ever cross to a third party. Fields the viewer isn't allowed to see are
 * nulled rather than omitted, so the client contract stays stable.
 */
export type PublicUserProfileData = {
  userId: string;
  username: string;
  /**
   * The real name for every viewer — identity is not gated by
   * `whoCanViewProfile` (see `visibleIdentity`). Null only for a DELETED
   * account, where the handle (`username`) and `userId` still resolve so
   * history rows stay addressable.
   */
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  avatar: MediaObject;
  coverImageUrl: string | null;
  /** Null when the target's `whoCanSeeOnlineStatus` excludes this viewer. */
  isOnline: boolean | null;
  lastSeenAt: string | null;
  /** Null when the target's `whoCanViewProfile` excludes this viewer. */
  friendsCount: number | null;
  groupsCount: number | null;
  communitiesCount: number | null;
  isDeletedUser: boolean;
  /**
   * The VIEWER blocked this user. Blocks are one-way, so the blocker still
   * resolves the profile. `relationship.status` collapses BLOCKED to NONE
   * (search vocabulary), so this is the flag clients branch on to show
   * "Unblock" instead of "Add friend".
   */
  isBlockedByMe: boolean;
  /**
   * This user blocked the VIEWER. True only when the pair already has a private
   * conversation — that is the one case where the profile stays reachable, so
   * that every door into the pair (chat list, search, recent, profile, deep
   * link) lands on the same screen. Every other blocked-by pair still 404s and
   * this is never observable.
   *
   * Both flags are true under a mutual block.
   */
  isBlockedByPeer: boolean;
  relationship: {
    friendshipId: string | null;
    status: string;
    direction: string | null;
    canAccept: boolean;
    canReject: boolean;
    canCancel: boolean;
    /**
     * Effective add-friend eligibility for THIS viewer — the target's
     * `whoCanSendFriendRequests` scope plus the self/block/friend/pending
     * preconditions, resolved by `canSendFriendRequest`. The raw scope is
     * never returned; clients render the action from this flag alone.
     */
    canSendRequest: boolean;
  };
};
