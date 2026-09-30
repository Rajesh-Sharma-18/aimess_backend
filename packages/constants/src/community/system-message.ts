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
  /** Catch-all for multi-field edits and other single fields (category…) —
   * renders "Community settings updated" ("Community category updated" when
   * `changedFields` is exactly ["category"]). Rows written before
   * COMMUNITY_PRIVACY_CHANGED existed may carry changedFields ["visibility"] +
   * `newVisibility`; those render "Community changed to private/public". */
  COMMUNITY_UPDATED: "COMMUNITY_UPDATED",
  /** PUBLIC ↔ PRIVATE. ACTOR-BEARING (unlike the lifecycle lines above): the
   * change alters who can join, so the line names who made it — "You changed
   * the community to private" / "{actor} changed the community to private".
   * metadata: `oldVisibility`, `newVisibility` ("PUBLIC" | "PRIVATE"). Posted
   * on its own even when other fields change in the same save. */
  COMMUNITY_PRIVACY_CHANGED: "COMMUNITY_PRIVACY_CHANGED",

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
  /** @deprecated RETIRED — an approved join request now posts COMMUNITY_JOINED
   *  ("You joined the community"): the line must state the membership outcome
   *  the user experienced, not the admin's decision (the decision reaches them
   *  as the separate `community.join_request_approved` notification). Kept only
   *  so rows persisted before the change still resolve; they re-render as the
   *  COMMUNITY_JOINED sentence. Nothing writes this any more. */
  JOIN_REQUEST_APPROVED: "JOIN_REQUEST_APPROVED",
  JOIN_REQUEST_REJECTED: "JOIN_REQUEST_REJECTED",
  /** An admin/moderator added this member directly (Add Member), rather than
   *  the member joining or a join request being approved. PERSONAL: only the
   *  added member reads "{admin} added you to the community". Distinct from
   *  COMMUNITY_JOINED ("You joined…") so the line always matches what actually
   *  happened. */
  MEMBER_ADDED: "MEMBER_ADDED",
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
 * Visibility scope for system messages.
 *
 *  - PERSONAL   — persisted with a `visibleToUserId` and only ever delivered to /
 *                 returned to that one user (the join onboarding lines).
 *  - COMMUNITY  — broadcast to the whole room.
 *  - MODERATION — the moderation AUDIT line (add / ban / unban / mute / unmute):
 *                 persisted room-wide (`visibleToUserId` null) but readable and
 *                 deliverable ONLY to the community's owner/admin/moderators. Two
 *                 of these subtypes ALSO have a PERSONAL companion copy addressed
 *                 to the affected member — see
 *                 {@link MODERATION_TYPES_WITH_PERSONAL_COPY}.
 */
export const CommunitySystemMessageVisibility = {
  PERSONAL: "PERSONAL",
  COMMUNITY: "COMMUNITY",
  MODERATION: "MODERATION",
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
  COMMUNITY_PRIVACY_CHANGED: "COMMUNITY",
  LIVE_STREAM_STARTED: "COMMUNITY",
  LIVE_STREAM_ENDED: "COMMUNITY",
  ROLE_CHANGED: "COMMUNITY",
  MEMBER_JOINED: "COMMUNITY",
  MEMBER_LEFT: "COMMUNITY",
  MEMBER_REMOVED: "COMMUNITY",
  MEMBER_BANNED: "MODERATION",
  MEMBER_UNBANNED: "MODERATION",
  MEMBER_MUTED: "MODERATION",
  MEMBER_UNMUTED: "MODERATION",
  PINNED_MESSAGE: "COMMUNITY",
  UNPINNED_MESSAGE: "COMMUNITY",
  COMMUNITY_INVITE_CREATED: "COMMUNITY",
  COMMUNITY_JOINED: "PERSONAL",
  JOIN_REQUEST_APPROVED: "PERSONAL",
  JOIN_REQUEST_REJECTED: "PERSONAL",
  MEMBER_ADDED: "MODERATION",
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
  COMMUNITY_PRIVACY_CHANGED: true,
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
  MEMBER_ADDED: false,
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
 * session (Telegram-style): "You joined the community" / "{admin} added you to
 * the community" (plus the retired JOIN_REQUEST_APPROVED, still listed so
 * legacy rows are purged by the same sweep). They must NOT accumulate across
 * join→leave→rejoin cycles — when
 * a membership goes inactive (left / removed / banned) every prior-session copy
 * for that (community, user) is purged, and a fresh one is created on rejoin. A
 * user must never see more than the current session's line.
 */
export const PERSONAL_JOIN_SESSION_TYPES = [
  "COMMUNITY_JOINED",
  "JOIN_REQUEST_APPROVED",
  "MEMBER_ADDED",
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
 *
 * The five MODERATION subtypes (add / ban / unban / mute / unmute) are NOT in this
 * set and must not be "tidied" into it. They ARE emitted, as an audit line that
 * only the community's owner/admin/moderators can read or receive — see
 * {@link MODERATION_ONLY_SYSTEM_MESSAGE_TYPES}. Ban and unmute are still silent
 * for everybody ELSE, including the affected member, which is now enforced by the
 * MODERATION scope rather than by hiding the subtype outright: they carry no
 * PERSONAL companion copy (see {@link MODERATION_TYPES_WITH_PERSONAL_COPY}), so a
 * banned member still gets no "You were banned" bubble — only the persistent
 * banner, `community:membership:restricted` and the push — and an unmuted member
 * still gets no "You were unmuted" bubble, only the `community:member:unmuted`
 * event plus the retraction of the stale mute line.
 *
 * SYSTEM-EVENT POLICY TABLE
 * | Membership event        | Chat system msg     | Recipient-scoped msg | Bumps lastActivity |
 * |-------------------------|---------------------|----------------------|--------------------|
 * | Member joined           | No (HIDDEN)         | Yes (COMMUNITY_JOINED PERSONAL) | No    |
 * | Member removed by admin | No (HIDDEN)         | No (socket only)     | No                 |
 * | Member added by admin   | Yes (MODERATION)    | Yes (MEMBER_ADDED PERSONAL)     | No    |
 * | Member banned           | Yes (MODERATION)    | No (socket + push only) | No              |
 * | Member unbanned         | Yes (MODERATION)    | No (socket only)     | No                 |
 * | Member muted            | Yes (MODERATION)    | Yes (MEMBER_MUTED PERSONAL)     | No    |
 * | Member unmuted          | Yes (MODERATION)    | No (socket only: :unmuted)      | No    |
 * | Member left voluntarily | No (HIDDEN)         | No                   | No                 |
 * | Member role changed     | Yes (COMMUNITY)     | Yes (ROLE_CHANGED_SELF PERSONAL) | Yes  |
 *
 * "Chat system msg (MODERATION)" means persisted room-wide but withheld from
 * ordinary members on every read path and every socket fan-out — see
 * {@link canViewSystemMessage}. The "Recipient-scoped msg" column is deliberately
 * NOT gated: that copy is the affected member's own notice, not an audit record.
 * None of these bump `lastActivity`, so moderation churn never becomes a
 * community-list preview or reorders anybody's list.
 */
export const HIDDEN_SYSTEM_MESSAGE_TYPES = [
  "MEMBER_LEFT",
  "MEMBER_JOINED",
  "MEMBER_REMOVED",
] as const satisfies readonly CommunitySystemMessageType[];

/** True when the subtype must never appear in the chat timeline (see above). */
export function isHiddenSystemMessage(
  type: string | null | undefined
): boolean {
  return inTypeSet(HIDDEN_SYSTEM_MESSAGE_TYPES, type);
}

/**
 * MODERATION-RESTRICTED subtypes — the Community moderation audit lines.
 *
 * A community-scoped (broadcast) system line of one of these subtypes describes a
 * moderation ACTION taken against a member (add / ban / unban / mute / unmute).
 * Moderation activity is privileged information: a normal member must never learn
 * from the timeline that someone was banned, muted or added by an admin. Only the
 * community's OWNER / ADMIN / MODERATOR may read them — see
 * {@link canViewSystemMessage}, which is the single enforcement point every read
 * path, socket fan-out and preview producer routes through.
 *
 * SCOPE — this gate applies to the community-scoped copy of the line
 * (`visibleToUserId == null`), which is the AUDIT record. It deliberately does NOT
 * touch the PERSONAL, target-addressed companion copy that two of these subtypes
 * also post — "{admin} added you to the community" (MEMBER_ADDED) and "You are
 * muted until …" (MEMBER_MUTED) are the target's OWN membership notices, not audit
 * records about a third party, and they keep PERSONAL behaviour (delivered to, and
 * only to, that one member). The two concepts must not be conflated — see the
 * SYSTEM-EVENT POLICY TABLE above and {@link MODERATION_TYPES_WITH_PERSONAL_COPY}.
 *
 * Authorization is structural: it keys off `systemMessageType` +
 * `visibleToUserId` + the viewer's CURRENT community role, never off the rendered
 * English sentence, so it holds for every locale and for legacy rows persisted
 * before this policy existed (they carry the same structured subtype, so no data
 * migration is needed).
 */
export const MODERATION_ONLY_SYSTEM_MESSAGE_TYPES = [
  "MEMBER_ADDED",
  "MEMBER_BANNED",
  "MEMBER_UNBANNED",
  "MEMBER_MUTED",
  "MEMBER_UNMUTED",
] as const satisfies readonly CommunitySystemMessageType[];

/**
 * The MODERATION subtypes that ALSO post a PERSONAL companion copy addressed to
 * the affected member, on top of the moderator-only audit line:
 *
 *  - MEMBER_ADDED — "{admin} added you to the community" (their join-session line;
 *    it is also in {@link PERSONAL_JOIN_SESSION_TYPES}, so it is purged and
 *    re-created across leave→rejoin cycles).
 *  - MEMBER_MUTED — "You are muted until …" (state the member must be able to see,
 *    since it explains why the composer is disabled). Retracted on unmute.
 *
 * Ban, unban and unmute deliberately have NO companion copy: the affected member
 * learns about them out-of-band (persistent banned banner +
 * `community:membership:restricted` + push for a ban; `community:member:unmuted`
 * plus the retraction of the stale mute line for an unmute), and a bubble would be
 * a second copy of the same sentence. So a target-addressed row of one of those
 * three subtypes can only be a LEGACY artifact, and
 * {@link canViewSystemMessage} withholds it rather than showing the affected
 * member a bubble the product removed.
 */
export const MODERATION_TYPES_WITH_PERSONAL_COPY = [
  "MEMBER_ADDED",
  "MEMBER_MUTED",
] as const satisfies readonly CommunitySystemMessageType[];

/**
 * The complement: MODERATION subtypes whose target-addressed row can only be a
 * legacy artifact. Read paths drop such a row for EVERYONE (see
 * {@link canViewSystemMessage} rule 3b and the raw-Mongo guard that mirrors it),
 * while the community-scoped audit copy of the same subtype stays role-gated.
 */
export const MODERATION_TYPES_WITHOUT_PERSONAL_COPY =
  MODERATION_ONLY_SYSTEM_MESSAGE_TYPES.filter(
    (type) => !MODERATION_TYPES_WITH_PERSONAL_COPY.includes(type as never)
  ) as readonly CommunitySystemMessageType[];

/**
 * True when this MODERATION subtype legitimately has a PERSONAL companion copy
 * addressed to the affected member (see the registry above).
 */
export function hasPersonalModerationCopy(
  type: string | null | undefined
): boolean {
  return inTypeSet(MODERATION_TYPES_WITH_PERSONAL_COPY, type);
}

/** True when a community-scoped line of this subtype is moderator-only. */
export function isModerationOnlySystemMessage(
  type: string | null | undefined
): boolean {
  return inTypeSet(MODERATION_ONLY_SYSTEM_MESSAGE_TYPES, type);
}

/**
 * Community roles authorized to read MODERATION-restricted system messages.
 * `owner` is included because the community creator's RoomMember role is `owner`
 * in chat-service while community-service calls the same person `ADMIN` — both
 * spellings must pass.
 */
export const MODERATION_VIEWER_ROLES = ["owner", "admin", "moderator"] as const;

/**
 * Whether a community role may read moderation-restricted system messages.
 * Case-insensitive so it accepts both the chat-service (`moderator`) and
 * community-service (`MODERATOR`) spellings. Fails CLOSED on null/unknown.
 */
export function isModerationViewerRole(
  role: string | null | undefined
): boolean {
  if (!role) return false;
  return (MODERATION_VIEWER_ROLES as readonly string[]).includes(
    role.toLowerCase()
  );
}

/**
 * SINGLE SOURCE OF TRUTH for "may this viewer see this system message?".
 *
 * Every community message read path (history, pagination, around-message,
 * by-id/context, sync/catch-up, reply-quote hydration, pinned, media, list
 * preview) and every real-time fan-out MUST route through this instead of
 * re-deriving conditions like `if (type === "MEMBER_BANNED")`. Returns true for
 * ordinary (non-system) messages, so it is safe to call on every row.
 *
 * Rules, in order:
 *  1. Platform super-admin / backoffice monitoring sees everything. A super admin
 *     is NOT a community member and has no community role, so it must never be
 *     treated as a normal member and dropped by rule 4.
 *  2. HIDDEN subtypes are never shown in the chat timeline, to anyone.
 *  3. PERSONAL (target-addressed) lines belong to exactly one user, and rule 4
 *     does NOT apply to them: a target's own membership notice is not a
 *     moderation audit record. Two extra conditions ride along —
 *       a. the membership-session guard hides a viewer's OWN join-onboarding line
 *          once they are no longer an active member;
 *       b. a target-addressed row of a MODERATION subtype that has no companion
 *          copy (ban / unban / unmute — see
 *          {@link MODERATION_TYPES_WITH_PERSONAL_COPY}) can only be a LEGACY
 *          artifact, so it is withheld rather than shown to the affected member
 *          as a bubble the product deliberately removed. It is still readable as
 *          an audit record by moderators via rule 4's sibling row.
 *  4. Community-scoped MODERATION subtypes require a CURRENT owner/admin/
 *     moderator role. Because the role is read at query time, a promoted member
 *     immediately gains access to the moderation lines already in their
 *     authorized history, and a demoted moderator immediately loses it.
 */
export function canViewSystemMessage(args: {
  message: {
    systemMessageType?: string | null;
    visibleToUserId?: string | null;
  };
  /** The reading user's id. */
  viewerId: string;
  /** The viewer's CURRENT community/room role (`member`, `moderator`, …). */
  viewerRole?: string | null;
  /** False when the viewer left / was removed / is banned (session guard). */
  viewerIsActiveMember?: boolean;
  /** Platform super-admin or trusted backoffice monitoring context. */
  viewerIsPlatformAdmin?: boolean;
}): boolean {
  const { message, viewerId } = args;
  const type = message.systemMessageType;

  if (args.viewerIsPlatformAdmin) return true;
  if (isHiddenSystemMessage(type)) return false;

  const target = message.visibleToUserId;
  if (target) {
    if (target !== viewerId) return false;
    if (
      args.viewerIsActiveMember === false &&
      isPersonalJoinSessionType(type)
    ) {
      return false;
    }
    // Legacy target-addressed ban / unban / unmute row — the product posts no
    // such bubble any more, so it stays withheld from the affected member (and,
    // being target-addressed, from everyone else already). The moderator-readable
    // audit record is a separate, community-scoped row of the same subtype.
    if (
      isModerationOnlySystemMessage(type) &&
      !hasPersonalModerationCopy(type)
    ) {
      return false;
    }
    return true;
  }

  if (isModerationOnlySystemMessage(type)) {
    return isModerationViewerRole(args.viewerRole);
  }
  return true;
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
