/**
 * Community SYSTEM message framework (Telegram-style).
 *
 * A SYSTEM message is an auto-generated, immutable, sender-less event line in the
 * community timeline ("Community created", "John joined the community", …). The
 * client renders localized text from `systemMessageType` + `systemMetadata`; the
 * backend stores a deterministic English fallback (never a dynamically-composed
 * sentence). This module is the SINGLE SOURCE OF TRUTH for which subtypes exist
 * and how each one behaves (visibility + whether it bumps the community list).
 */

export const CommunitySystemMessageType = {
  // --- Community lifecycle (COMMUNITY-visible) ---------------------------------
  COMMUNITY_CREATED: "COMMUNITY_CREATED",
  COMMUNITY_NAME_UPDATED: "COMMUNITY_NAME_UPDATED",
  COMMUNITY_DESCRIPTION_UPDATED: "COMMUNITY_DESCRIPTION_UPDATED",
  COMMUNITY_AVATAR_UPDATED: "COMMUNITY_AVATAR_UPDATED",
  COMMUNITY_BANNER_UPDATED: "COMMUNITY_BANNER_UPDATED",
  /** Catch-all for multi-field edits and other single fields (handle, category,
   * rules, visibility…) — renders "Community details updated". */
  COMMUNITY_UPDATED: "COMMUNITY_UPDATED",

  // --- Membership / moderation (COMMUNITY-visible) ----------------------------
  ROLE_CHANGED: "ROLE_CHANGED",
  MEMBER_JOINED: "MEMBER_JOINED",
  MEMBER_LEFT: "MEMBER_LEFT",
  MEMBER_REMOVED: "MEMBER_REMOVED",
  MEMBER_BANNED: "MEMBER_BANNED",
  MEMBER_UNBANNED: "MEMBER_UNBANNED",
  MEMBER_MUTED: "MEMBER_MUTED",
  MEMBER_UNMUTED: "MEMBER_UNMUTED",

  // --- Message actions (COMMUNITY-visible) ------------------------------------
  PINNED_MESSAGE: "PINNED_MESSAGE",
  UNPINNED_MESSAGE: "UNPINNED_MESSAGE",
  COMMUNITY_INVITE_CREATED: "COMMUNITY_INVITE_CREATED",

  // --- Personal (visible ONLY to the affected user) ---------------------------
  COMMUNITY_JOINED: "COMMUNITY_JOINED",
  JOIN_REQUEST_APPROVED: "JOIN_REQUEST_APPROVED",
  JOIN_REQUEST_REJECTED: "JOIN_REQUEST_REJECTED",
  /** Personal counterpart to ROLE_CHANGED — delivered only to the user whose
   *  role changed so they see "You are now a moderator" while everyone else
   *  sees the community-wide "X is now a moderator" line. */
  ROLE_CHANGED_SELF: "ROLE_CHANGED_SELF",

  /** @deprecated use ROLE_CHANGED — kept so old persisted rows still resolve. */
  MEMBER_ROLE_CHANGED: "MEMBER_ROLE_CHANGED",
} as const;

export type CommunitySystemMessageType =
  (typeof CommunitySystemMessageType)[keyof typeof CommunitySystemMessageType];

/**
 * Visibility scope for system messages. PERSONAL messages are persisted with a
 * `visibleToUserId` and only ever delivered to / returned to that user (the join
 * onboarding lines); COMMUNITY messages are broadcast to the whole room.
 */
export const CommunitySystemMessageVisibility = {
  PERSONAL: "PERSONAL",
  COMMUNITY: "COMMUNITY",
} as const;

export type CommunitySystemMessageVisibility =
  (typeof CommunitySystemMessageVisibility)[keyof typeof CommunitySystemMessageVisibility];

/**
 * Per-subtype visibility — the Phase 4/5 rule, centralized so it can't drift.
 * The system-message service derives visibility from this map; publishers no
 * longer hand-pass it.
 */
export const SYSTEM_MESSAGE_VISIBILITY: Record<
  CommunitySystemMessageType,
  CommunitySystemMessageVisibility
> = {
  COMMUNITY_CREATED: "COMMUNITY",
  COMMUNITY_NAME_UPDATED: "COMMUNITY",
  COMMUNITY_DESCRIPTION_UPDATED: "COMMUNITY",
  COMMUNITY_AVATAR_UPDATED: "COMMUNITY",
  COMMUNITY_BANNER_UPDATED: "COMMUNITY",
  COMMUNITY_UPDATED: "COMMUNITY",
  ROLE_CHANGED: "COMMUNITY",
  MEMBER_JOINED: "COMMUNITY",
  MEMBER_LEFT: "COMMUNITY",
  MEMBER_REMOVED: "COMMUNITY",
  MEMBER_BANNED: "COMMUNITY",
  MEMBER_UNBANNED: "COMMUNITY",
  MEMBER_MUTED: "COMMUNITY",
  MEMBER_UNMUTED: "COMMUNITY",
  PINNED_MESSAGE: "COMMUNITY",
  UNPINNED_MESSAGE: "COMMUNITY",
  COMMUNITY_INVITE_CREATED: "COMMUNITY",
  COMMUNITY_JOINED: "PERSONAL",
  JOIN_REQUEST_APPROVED: "PERSONAL",
  JOIN_REQUEST_REJECTED: "PERSONAL",
  ROLE_CHANGED_SELF: "PERSONAL",
  MEMBER_ROLE_CHANGED: "COMMUNITY",
};

/**
 * Whether a subtype bumps the community-list `lastActivity` preview. Most do;
 * personal onboarding lines and low-signal actions (unpin, invite-link created)
 * do not, matching Telegram (they don't reorder everyone's chat list).
 */
export const SYSTEM_MESSAGE_BUMPS_ACTIVITY: Record<
  CommunitySystemMessageType,
  boolean
> = {
  COMMUNITY_CREATED: true,
  COMMUNITY_NAME_UPDATED: true,
  COMMUNITY_DESCRIPTION_UPDATED: true,
  COMMUNITY_AVATAR_UPDATED: true,
  COMMUNITY_BANNER_UPDATED: true,
  COMMUNITY_UPDATED: true,
  ROLE_CHANGED: true,
  MEMBER_JOINED: false,
  MEMBER_LEFT: true,
  MEMBER_REMOVED: true,
  MEMBER_BANNED: true,
  MEMBER_UNBANNED: true,
  MEMBER_MUTED: true,
  MEMBER_UNMUTED: true,
  PINNED_MESSAGE: true,
  UNPINNED_MESSAGE: false,
  COMMUNITY_INVITE_CREATED: false,
  COMMUNITY_JOINED: false,
  JOIN_REQUEST_APPROVED: false,
  JOIN_REQUEST_REJECTED: false,
  ROLE_CHANGED_SELF: false,
  MEMBER_ROLE_CHANGED: true,
};

/** True when the subtype is visible only to a single user. */
export function isPersonalSystemMessage(
  type: CommunitySystemMessageType
): boolean {
  return SYSTEM_MESSAGE_VISIBILITY[type] === "PERSONAL";
}

/**
 * Canonical changed-field tokens (still carried in COMMUNITY_UPDATED metadata so
 * the client can render a precise label for "other field" changes). `name` and
 * `avatar` now have dedicated subtypes and are emitted as those instead.
 */
export const CommunityChangedField = {
  AVATAR: "avatar",
  NAME: "name",
  DESCRIPTION: "description",
  VISIBILITY: "visibility",
  HANDLE: "handle",
  CATEGORY: "category",
  RULES: "rules",
  BANNER: "banner",
} as const;

export type CommunityChangedField =
  (typeof CommunityChangedField)[keyof typeof CommunityChangedField];
