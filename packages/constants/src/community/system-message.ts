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
  // Membership / moderation churn — NEVER eligible as a community-list
  // lastActivity preview (Telegram parity: admin/member lifecycle lines must not
  // dominate the list; previews should prioritize real conversation/community
  // activity). They still render in chat history where applicable.
  MEMBER_LEFT: false,
  MEMBER_REMOVED: false,
  MEMBER_BANNED: false,
  MEMBER_UNBANNED: false,
  MEMBER_MUTED: false,
  MEMBER_UNMUTED: false,
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
 * SINGLE SOURCE OF TRUTH for community-list `lastActivity` eligibility.
 *
 * Returns whether a message may become the community's `lastActivity` preview in
 * the Mine / List / Discovery / Summary APIs (and, equivalently, whether it
 * reorders the list). Regular conversation messages (no `systemMessageType`) are
 * always eligible. SYSTEM messages defer to `SYSTEM_MESSAGE_BUMPS_ACTIVITY` —
 * membership/moderation churn (left, removed, banned, unbanned, muted, unmuted)
 * is excluded so "John left the community" / "Jim was removed" can never become
 * the preview. Such messages still appear in chat history where applicable.
 *
 * Every lastActivity producer (chat-service system-message bump gate; any
 * activity publisher) MUST route through this so the rule can't drift per query.
 */
export function isEligibleForLastActivity(
  systemMessageType?: string | null
): boolean {
  if (!systemMessageType) return true; // regular conversation message
  // The registry is an exhaustive Record over the enum, so the `?? true` branch
  // is only reached by an OFF-enum/legacy string — default ELIGIBLE so a future
  // subtype can't be silently swallowed (a real churn type must be added to the
  // map, which is type-checked). Known churn types resolve to false from the map.
  return (
    SYSTEM_MESSAGE_BUMPS_ACTIVITY[
      systemMessageType as CommunitySystemMessageType
    ] ?? true
  );
}

/**
 * PERSONAL onboarding lines that are bound to the user's CURRENT membership
 * session (Telegram-style): "You joined the community" / "Your request to join
 * was approved". They must NOT accumulate across join→leave→rejoin cycles — when
 * a membership goes inactive (left / removed / banned) every prior-session copy
 * for that (community, user) is purged, and a fresh one is created on rejoin. A
 * user must never see more than the current session's line.
 */
export const PERSONAL_JOIN_SESSION_TYPES = [
  "COMMUNITY_JOINED",
  "JOIN_REQUEST_APPROVED",
] as const satisfies readonly CommunitySystemMessageType[];

/** Membership test for a readonly subtype tuple (handles null/undefined). */
function inTypeSet(
  set: readonly string[],
  type: string | null | undefined
): boolean {
  return !!type && set.includes(type);
}

/** True when the subtype is a current-membership-session join onboarding line. */
export function isPersonalJoinSessionType(
  type: string | null | undefined
): boolean {
  return inTypeSet(PERSONAL_JOIN_SESSION_TYPES, type);
}

/**
 * Membership-lifecycle lines that are NEVER shown in the chat timeline (Telegram
 * parity: join/leave/kick/ban service lines clutter history and don't belong in
 * the conversation). They are SUPPRESSED end-to-end:
 *  - community-service does not emit them as chat SYSTEM messages (the domain
 *    event + roster socket + notifications still fire — only the chat line is
 *    dropped), and
 *  - chat-service hides any already-persisted rows of these types on every read
 *    path (clears history that accumulated before this rule).
 *
 * Why each is here:
 *  - MEMBER_REMOVED / MEMBER_BANNED / MEMBER_UNBANNED: "Peter was removed" /
 *    "You were removed" piled up across remove→rejoin cycles.
 *  - MEMBER_LEFT: "Peter Parker left the community" must not show to anyone.
 *  - MEMBER_JOINED: the legacy COMMUNITY-WIDE join line is personalized to "You
 *    joined the community" for the joiner, DUPLICATING the personal
 *    COMMUNITY_JOINED line (the current flow emits only COMMUNITY_JOINED, so this
 *    only hides vestigial rows). The joiner keeps the single personal line.
 *
 * Membership history still lives in the backoffice/audit log, not the chat.
 */
export const HIDDEN_SYSTEM_MESSAGE_TYPES = [
  "MEMBER_REMOVED",
  "MEMBER_BANNED",
  "MEMBER_UNBANNED",
  "MEMBER_LEFT",
  "MEMBER_JOINED",
] as const satisfies readonly CommunitySystemMessageType[];

/** True when the subtype must never appear in the chat timeline (see above). */
export function isHiddenSystemMessage(
  type: string | null | undefined
): boolean {
  return inTypeSet(HIDDEN_SYSTEM_MESSAGE_TYPES, type);
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
