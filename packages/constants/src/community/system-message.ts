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
  COMMUNITY_HANDLE_UPDATED: "COMMUNITY_HANDLE_UPDATED",
  /** Catch-all for multi-field edits and other single fields (category, rules,
   * visibility…) — renders "Community settings updated". */
  COMMUNITY_UPDATED: "COMMUNITY_UPDATED",

  // --- Live streaming (COMMUNITY-visible) -----------------------------------
  LIVE_STREAM_STARTED: "LIVE_STREAM_STARTED",
  LIVE_STREAM_ENDED: "LIVE_STREAM_ENDED",

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
  COMMUNITY_HANDLE_UPDATED: "COMMUNITY",
  COMMUNITY_UPDATED: "COMMUNITY",
  LIVE_STREAM_STARTED: "COMMUNITY",
  LIVE_STREAM_ENDED: "COMMUNITY",
  ROLE_CHANGED: "COMMUNITY",
  MEMBER_JOINED: "COMMUNITY",
  MEMBER_LEFT: "COMMUNITY",
  MEMBER_REMOVED: "COMMUNITY",
  MEMBER_BANNED: "PERSONAL",
  MEMBER_UNBANNED: "COMMUNITY",
  MEMBER_MUTED: "PERSONAL",
  MEMBER_UNMUTED: "PERSONAL",
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
  COMMUNITY_HANDLE_UPDATED: true,
  COMMUNITY_UPDATED: true,
  LIVE_STREAM_STARTED: true,
  LIVE_STREAM_ENDED: true,
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
 * Membership-lifecycle lines that are NEVER shown in the chat timeline. They are
 * SUPPRESSED end-to-end: community-service does not emit them as chat SYSTEM
 * messages, and chat-service hides any already-persisted rows on every read path.
 *
 * Why each is here:
 *  - MEMBER_LEFT:    High-churn noise; a voluntary leave must not pollute chat.
 *  - MEMBER_JOINED:  Legacy COMMUNITY-WIDE join line; duplicates the personal
 *                    COMMUNITY_JOINED line. Hidden to suppress vestigial rows.
 *  - MEMBER_REMOVED: Product rule — removal must be SILENT from the chat-message
 *                    perspective. The removed user learns via the dedicated
 *                    `community:membership:removed` socket event on their personal
 *                    channel (all devices); other members see a roster update via
 *                    `community:member:removed`. No "{name} was removed" text must
 *                    appear in chat history, sync, lastActivity, or any API surface.
 *                    Moderation history lives in the audit log and backoffice panel.
 *  - MEMBER_BANNED:  Silent from EVERY chat perspective. No one else sees a
 *                    "{name} was banned" line, and the banned user gets no
 *                    "You were banned from this community." bubble either: the
 *                    client already pins a persistent banned banner over the
 *                    composer, so the bubble was a second copy of the same
 *                    sentence sitting in their history. The ban still reaches
 *                    them out-of-band — `community:membership:restricted`
 *                    (isBanned: true), the push notification, and `isBanned` on
 *                    the community detail/list — and the read CUTOFF on their
 *                    history is unchanged. Moderation history lives in the audit
 *                    log and backoffice panel.
 *
 * MEMBER_UNBANNED is NOT hidden: it's an informational action that members may
 * legitimately see in context. MEMBER_MUTED / MEMBER_UNMUTED are PERSONAL
 * (Telegram parity: only the affected member ever sees "You are muted…" /
 * "You were unmuted" — never broadcast, never visible to other members), and
 * persist exactly like any other PERSONAL line (COMMUNITY_JOINED):
 * delivered live to the affected member's socket AND returned by history/sync/
 * catch-up/list APIs for that same member on reload/reconnect.
 * Membership history also lives in the backoffice/audit log.
 *
 * SYSTEM-EVENT POLICY TABLE
 * | Membership event        | Chat system msg | Recipient-scoped msg | Bumps lastActivity |
 * |-------------------------|-----------------|----------------------|--------------------|
 * | Member joined           | No (HIDDEN)     | Yes (COMMUNITY_JOINED PERSONAL) | No    |
 * | Member removed by admin | No (HIDDEN)     | No (socket only)     | No                 |
 * | Member banned           | No (HIDDEN)     | No (socket + push only) | No            |
 * | Member left voluntarily | No (HIDDEN)     | No                   | No                 |
 * | Member role changed     | Yes (COMMUNITY) | Yes (ROLE_CHANGED_SELF PERSONAL) | Yes  |
 * | Member muted/unmuted    | No (COMMUNITY)  | Yes (MEMBER_MUTED/UNMUTED PERSONAL) | No |
 */
export const HIDDEN_SYSTEM_MESSAGE_TYPES = [
  "MEMBER_LEFT",
  "MEMBER_JOINED",
  "MEMBER_REMOVED",
  "MEMBER_BANNED",
] as const satisfies readonly CommunitySystemMessageType[];

/** True when the subtype must never appear in the chat timeline (see above). */
export function isHiddenSystemMessage(
  type: string | null | undefined
): boolean {
  return inTypeSet(HIDDEN_SYSTEM_MESSAGE_TYPES, type);
}

/**
 * Pure, ACTOR-LESS lifecycle SYSTEM types. Their canonical text describes the
 * EVENT and never the actor ("Community created", "Community photo updated"), so
 * the actor's identity must NEVER reach the client. A client that localizes from
 * `systemMessageType` + `systemMetadata` (the documented contract) would otherwise
 * render "{name} created the community" off a leaked `actorName`/`creatorName`.
 * For these types the persisted + wire `systemMetadata` carries ONLY the event
 * fields (communityName, newName, duration) — all actor/target identity is
 * stripped via {@link sanitizeCommunitySystemMetadata}.
 */
export const ACTOR_LESS_SYSTEM_MESSAGE_TYPES = [
  "COMMUNITY_CREATED",
  "COMMUNITY_NAME_UPDATED",
  "COMMUNITY_DESCRIPTION_UPDATED",
  "COMMUNITY_AVATAR_UPDATED",
  "COMMUNITY_BANNER_UPDATED",
  "COMMUNITY_HANDLE_UPDATED",
  "COMMUNITY_UPDATED",
] as const satisfies readonly CommunitySystemMessageType[];

/** True when the subtype is a pure event whose text must never name an actor. */
export function isActorLessSystemMessage(
  type: string | null | undefined
): boolean {
  return inTypeSet(ACTOR_LESS_SYSTEM_MESSAGE_TYPES, type);
}

/**
 * Identity keys that must never reach the client for an ACTOR-LESS SYSTEM type.
 * Covers both the current schema (actorUserId/actorName) and the legacy schema
 * (creatorId/creatorName) so old persisted rows are cleaned on read too.
 */
const ACTOR_IDENTITY_METADATA_KEYS = [
  "actorUserId",
  "actorName",
  "creatorId",
  "creatorName",
  "targetUserId",
  "targetName",
] as const;

/**
 * Strip actor/target identity from an ACTOR-LESS SYSTEM message's metadata so no
 * client can interpolate a name into a pure-event line ("{name} created the
 * community"). No-op for actor-bearing types (role change, pin, member
 * moderation) and for null/non-system metadata — those legitimately render the
 * actor/target. Single source of truth shared by the persist path, the socket
 * publish, and every read path (history / sync).
 */
export function sanitizeCommunitySystemMetadata<
  T extends Record<string, unknown> | null | undefined,
>(type: string | null | undefined, metadata: T): T {
  if (!metadata || !isActorLessSystemMessage(type)) return metadata;
  const out: Record<string, unknown> = { ...metadata };
  for (const k of ACTOR_IDENTITY_METADATA_KEYS) delete out[k];
  return out as T;
}

/**
 * Canonical changed-field tokens (still carried in COMMUNITY_UPDATED metadata so
 * the client can render a precise label for "other field" changes when 2+
 * fields change at once — see the COMMUNITY_UPDATE_SINGLE_FIELD_SUBTYPE
 * LIMITATION note in community.service.ts). `name`, `description`, `avatar`,
 * `banner`, and `handle` now have dedicated subtypes and are emitted as those
 * instead when they are the ONLY field that changed; only `visibility`,
 * `category`, and `rules` never get a dedicated subtype.
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
