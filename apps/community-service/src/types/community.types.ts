import type { MediaObject } from "@aimess/shared-types";

import type {
  CommunityInviteStatus,
  CommunityJoinReqStatus,
  CommunityMemberRole,
  CommunityMemberStatus,
  CommunityModerationStatus,
  CommunityReportStatus,
  CommunityType,
} from "../generated/prisma/index.js";

export type CommunityImageView = {
  url: string;
  expiresIn: number;
};

/** A single live stream surfaced inside a community detail response. */
export type LiveStreamSummary = {
  id: string;
  title: string;
  thumbnail: string | null;
  creatorId: string;
  hlsUrl: string | null;
  flvUrl: string | null;
  dashUrl: string | null;
  viewerCount: number;
  /** Epoch ms when the stream went live; null if not yet stamped. */
  livedAt: number | null;
};

/** Full community payload returned by create / get / patch. */
export type CommunityData = {
  id: string;
  name: string;
  handle: string;
  description: string | null;
  type: CommunityType;
  category: {
    id: string;
    name: string;
  };
  creatorId: string;
  adminId: string;
  memberCount: number;
  /** Static platform-wide max members per community (currently a fixed cap). */
  memberLimit: number;
  /** Presigned GET URL (private bucket); null if no avatar. */
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  /** Nested media object for the avatar (additive; mirrors avatarUrl). */
  avatar: MediaObject;
  /** Presigned GET URL (private bucket); null if no cover. */
  coverUrl: string | null;
  coverUrlExpiresIn: number | null;
  /** Nested media object for the cover (additive; mirrors coverUrl). */
  cover: MediaObject;
  /** Caller's membership role, or null if not a member. */
  role: CommunityMemberRole | null;
  /** True when the caller is an active member of this community. */
  isJoined: boolean;
  /**
   * True when the caller is BANNED from this community. The community stays
   * visible in the caller's list (until they delete/hide it themselves), but
   * EVERY other action — reading messages, sending, reacting, editing, media,
   * socket room — is rejected server-side with USER_BANNED. Clients use this
   * to render the banned state and hide all affordances (Join included, since
   * re-joining is also blocked until an admin unban).
   */
  isBanned: boolean;
  /**
   * @deprecated Always false. Kicked members are plain non-members now (the
   * community disappears from their list; they rejoin via the normal flow).
   * Kept on the wire for backward compatibility only.
   */
  isKicked: boolean;
  /**
   * Caller's membership status — the single field clients should branch on.
   * ACTIVE = full member; BANNED = visible-but-blocked (see isBanned);
   * NONE = not a member (incl. left/kicked — both rejoin via the normal
   * join flow; a pending join request is signalled by joinRequestStatus).
   */
  membershipStatus: "ACTIVE" | "BANNED" | "NONE";
  /**
   * Present when the caller has a PENDING join request for this community.
   * Null if the caller is already a member, never requested, or their request
   * was approved/rejected/cancelled. Frontend shows "Requested" + cancel
   * button when this is non-null.
   */
  joinRequestId: string | null;
  joinRequestStatus: CommunityJoinReqStatus | null;
  /** True if the caller has a mute row for this community (any state). */
  isMuted: boolean;
  /** ISO-8601; null when not muted or muted indefinitely. */
  muteUntil: string | null;
  streamEnabled: boolean;
  chatEnabled: boolean;
  announcementEnabled: boolean;
  /** True when the community has at least one active livestream right now. */
  isLive: boolean;
  /** Spec-aligned alias of `isLive` — true when ≥1 livestream is LIVE. */
  hasActiveLivestream: boolean;
  /** Number of currently-LIVE streams (equals liveStreams.length, clamped 0–5). */
  liveStreamCount: number;
  /** Currently-LIVE streams for this community (the active livestreams). Empty when none. */
  liveStreams: LiveStreamSummary[];
  /**
   * True when the authenticated caller already has a LIVE or RECONNECTING
   * stream in ANY community. Clients use this to disable the Go Live button —
   * a user can only broadcast in one community at a time.
   */
  currentUserIsStreaming: boolean;
  /** ACTIVE = open; SUSPENDED = closed by admin — clients show a read-only banner. */
  moderationStatus: CommunityModerationStatus;
  /**
   * Owner-controlled lifecycle status. ACTIVE = open; CLOSED = the community
   * owner closed it (all members removed, read-only) until reopened. Absent on
   * legacy data ⇒ "ACTIVE". This is the field clients branch on to disable
   * community actions; `moderationStatus` is a separate platform concern.
   */
  status: "ACTIVE" | "CLOSED";
  createdAt: string;
  updatedAt: string;
  lastActivity: CommunityLastActivity;
  /**
   * True when the caller has an active MODERATION mute (silenced by a moderator/admin).
   * Distinct from `isMuted` which is the notification mute (caller silenced the community).
   */
  isMemberMuted: boolean;
  /**
   * ISO-8601 expiry of the caller's moderation mute; null = indefinitely muted or not muted.
   * Only meaningful when `isMemberMuted` is true.
   */
  memberMutedUntil: string | null;
};

/**
 * Public community resolver response — `GET /communities/by-handle/:handle`.
 * Returned ONLY for PUBLIC communities (a private community's handle yields 404,
 * so this surface never reveals private metadata). Drives the deep-link
 * "Join" preview screen on all clients (Sharing & Deep-Linking spec §3/§9.1).
 */
export type PublicCommunityResponse = {
  communityId: string;
  handle: string;
  name: string;
  description: string | null;
  /** Presigned GET URL (private bucket); null if no avatar. */
  avatarUrl: string | null;
  /** Presigned GET URL for the cover image; null if none. */
  bannerUrl: string | null;
  memberCount: number;
  /** by-handle only ever resolves PUBLIC communities. */
  type: "PUBLIC";
  /**
   * Canonical HTTPS share URL for this public community: `https://aimess.me/<handle>`
   * (Sharing & Deep-Linking spec §9.5). Server-owned — clients MUST use this
   * verbatim and never reconstruct it. No `+` marker (that prefix is reserved
   * for code-based PRIVATE invite links).
   */
  shareUrl: string;
  /** App deep-link: `aimess://resolve?handle=<handle>` (spec §4.1/§9.5). */
  appDeepLink: string;
  /** True when the caller is an ACTIVE member. */
  isJoined: boolean;
  /** Caller's role, or null if not an ACTIVE member. */
  role: CommunityMemberRole | null;
  /** Always false here — a banned caller gets 403, never a body. */
  isBanned: boolean;
};

/**
 * Minimal PUBLIC community metadata for the gateway's unauthenticated link
 * preview (OG card). Internal-only — never returned to end clients.
 */
export type PublicCommunityCard = {
  communityId: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  memberCount: number;
};

/** Per-user mute config for a community. Returned by `GET /:id/mute`. */
export type CommunityMuteData = {
  communityId: string;
  /** null = indefinite mute. */
  mutedUntil: string | null;
  streamEnabled: boolean;
  chatEnabled: boolean;
  announcementEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CommunityAvailability = {
  name?: string;
  handle?: string;
  available: boolean;
};

export type CommunityCategoryData = {
  id: string;
  name: string;
  slug: string;
};
/**
 * Community-list "last activity" preview, surfaced by every list/summary surface
 * (`/communities/mine`, search/discover, get-by-id) and the socket bumps.
 *
 * Two shapes, discriminated by the nature of the activity (Telegram parity):
 *
 * - **USER MESSAGE** (`message` / `reaction` / `edited` / `deleted`): a real
 *   member action. `username` is the sender's name and the CLIENT renders
 *   `"<username>: <preview>"` (or `"You: <preview>"`).
 *
 * - **SYSTEM / lifecycle** (`system` / `created` / `join` / `removal` /
 *   `pinned` / `unpinned`): the `preview` is already a complete, self-describing
 *   sentence (e.g. "Community photo updated", "John Doe became admin"). For these
 *   `username` is ALWAYS `null`, so the client shows the text standalone with NO
 *   sender prefix. Never render `"<actor>: <preview>"` for this shape.
 */
export type CommunityLastActivityType =
  | "message"
  | "reaction"
  | "edited"
  | "deleted"
  | "system"
  | "created"
  | "join"
  | "removal"
  | "pinned"
  | "unpinned";

export type CommunityLastActivity =
  | {
      // USER MESSAGE — client prefixes the preview with the sender / "You".
      type: "message" | "edited" | "deleted";
      userId: string | null;
      username: string;
      preview: string;
      dateTime: number;
    }
  | {
      // SYSTEM / lifecycle — standalone text, NEVER prefixed (username === null).
      // "reaction" lives here: its preview is always a complete Telegram-style
      // sentence ("You reacted ❤️ to X's message" / "X reacted ❤️ to your
      // message" / "X reacted ❤️ to Y's message") with the actor's name already
      // baked in by community.service.ts's selectListPreview — never re-prefix it.
      type:
        | "system"
        | "created"
        | "join"
        | "removal"
        | "pinned"
        | "unpinned"
        | "reaction";
      userId: null;
      username: null;
      preview: string;
      dateTime: number;
    };
export type AdminCategoryData = {
  id: string;
  name: string;
  slug: string;
  /** true = visible to users; false = hidden */
  visible: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
  /** Communities in this category with status=ACTIVE and deletedAt unset. */
  communityCount: number;
};

export type AdminCategoryListResult = {
  categories: AdminCategoryData[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
};

export type CommunityListItem = {
  id: string;
  name: string;
  handle: string;
  type: CommunityType;
  memberCount: number;
  /** Static platform-wide max members per community (currently a fixed cap). */
  memberLimit: number;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  /** Nested media object for the avatar (additive; mirrors avatarUrl). */
  avatar: MediaObject;
  role: CommunityMemberRole;
  /** True when the caller is an active member of this community. Always true for listMine results. */
  isJoined: boolean;
  /**
   * True when the caller's membership is BANNED. The community stays visible
   * in `mine` for a banned member (membership row is never deleted), but the
   * client must lock the row to read-only / show a "banned" state — no open,
   * no send, no live updates. False for every other membership status.
   */
  isBanned: boolean;
  /** @deprecated Always false — kicked members no longer appear in this list. Wire compat only. */
  isKicked: boolean;
  /** Caller's membership status for this list entry. Only ACTIVE and BANNED rows are ever listed (LEFT/kicked/dismissed-banned are excluded). */
  membershipStatus: "ACTIVE" | "BANNED";
  /** Latest activity (latest community message, else createdAt), epoch milliseconds. */
  lastActivityAt: number;
  /** Unread community-chat messages for the caller (member-only); 0 otherwise. */
  unreadMessageCount: number;
  /** Oldest unread message id, so the client can jump to it. Null iff unreadMessageCount === 0. */
  firstUnreadMessageId: string | null;
  /** Last activity for this community (denormalized). */
  lastActivity: CommunityLastActivity;
  /** True when the caller has an active mute-setting row for this community. */
  isMuted: boolean;
  /** ISO-8601; null when not muted or muted indefinitely. */
  muteUntil: string | null;
  streamEnabled: boolean;
  chatEnabled: boolean;
  announcementEnabled: boolean;
  /** True when the community has at least one active livestream right now. */
  isLive: boolean;
  /** Spec-aligned alias of `isLive` — true when ≥1 livestream is LIVE. */
  hasActiveLivestream: boolean;
  /** Number of currently-LIVE streams (0–5). */
  liveStreamCount: number;
  /** ACTIVE = open; SUSPENDED = closed by platform admin (read-only banner). */
  moderationStatus: CommunityModerationStatus;
  /** Owner lifecycle status: ACTIVE = open; CLOSED = owner closed (read-only). */
  status: "ACTIVE" | "CLOSED";
  /** True when the caller has an active MODERATION mute (silenced by a mod/admin). */
  isMemberMuted: boolean;
  /** ISO-8601 expiry of the caller's moderation mute; null = indefinite or not muted. */
  memberMutedUntil: string | null;
  /**
   * True when the authenticated caller already has a LIVE or RECONNECTING
   * stream in ANY community. Clients use this to disable the Go Live button —
   * a user can only broadcast in one community at a time.
   */
  currentUserIsStreaming: boolean;
};

/**
 * A public community surfaced by discovery/browse. The caller is, by
 * definition, not a member — so there is no `role`. Includes description and
 * category to render browse cards.
 *
 * Exception: when used by the /communities/mine search alias (includeJoined=true),
 * results may include communities the caller already belongs to — `isJoined` reflects that.
 */
export type CommunityDiscoverItem = {
  id: string;
  name: string;
  handle: string;
  description: string | null;
  type: CommunityType;
  category: {
    id: string;
    name: string;
  };
  memberCount: number;
  /** Static platform-wide max members per community (currently a fixed cap). */
  memberLimit: number;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  /** Nested media object for the avatar (additive; mirrors avatarUrl). */
  avatar: MediaObject;
  /** Creation time as epoch milliseconds. */
  createdAt: number;
  /**
   * Unread community-chat messages for the caller. Only populated by the
   * /communities/mine search mode (member-only); absent on the public alias.
   */
  unreadMessageCount?: number;
  /**
   * Oldest unread message id, so the client can jump to it. Null iff
   * unreadMessageCount === 0. Only populated by the /communities/mine search
   * mode; absent on the public discover alias.
   */
  firstUnreadMessageId?: string | null;
  /**
   * Last activity for this community. Only populated by the /communities/mine
   * search mode; absent on the public discover alias.
   */
  lastActivity?: CommunityLastActivity;
  /** True when the caller is an active member of this community. */
  isJoined: boolean;
  /** True when the caller is BANNED from this community — visible but every action returns USER_BANNED. Only ever true in the /communities/mine search mode (includeJoined); always false on public discover/browse. */
  isBanned: boolean;
  /** @deprecated Always false — kicked members are plain non-members now. Wire compat only. */
  isKicked: boolean;
  /** Caller's membership status. BANNED only ever appears in the /communities/mine search mode. */
  membershipStatus: "ACTIVE" | "BANNED" | "NONE";
  /** True when the caller has a PENDING join request for this community. */
  hasRequested: boolean;
  isMuted: boolean;
  muteUntil: string | null;
  streamEnabled: boolean;
  chatEnabled: boolean;
  announcementEnabled: boolean;
  /** True when the community has at least one active livestream right now. */
  isLive: boolean;
  /** Spec-aligned alias of `isLive` — true when ≥1 livestream is LIVE. */
  hasActiveLivestream: boolean;
  /** Number of currently-LIVE streams (0–5). */
  activeLivestreamCount: number;
  /**
   * True when the authenticated caller already has a LIVE or RECONNECTING
   * stream in ANY community. Clients use this to disable the Go Live button —
   * a user can only broadcast in one community at a time.
   */
  currentUserIsStreaming: boolean;
  liveStreamCount: number;
  /** ACTIVE = open; SUSPENDED = closed by platform admin (read-only banner). */
  moderationStatus: CommunityModerationStatus;
  /** Owner lifecycle status: ACTIVE = open; CLOSED = owner closed (read-only). */
  status: "ACTIVE" | "CLOSED";
};

/** A single community member row returned by the member-listing endpoint. */
export type CommunityMemberData = {
  userId: string;
  role: CommunityMemberRole;
  status: CommunityMemberStatus;
  /** ISO-8601 timestamp of when the member joined. */
  joinedAt: string;
  snapshotUsername: string;
  snapshotDisplayName: string;
  /** Presigned GET URL for the member's avatar (private bucket); null if none. */
  snapshotAvatarUrl: string | null;
  snapshotAvatarUrlExpiresIn: number | null;
  /** Nested media object for the snapshot avatar (additive; mirrors snapshotAvatarUrl). */
  snapshotAvatar: MediaObject;
  /**
   * True only when the member's user profile genuinely could not be resolved
   * (deleted user with no usable stored snapshot). When false (the default),
   * snapshotUsername/snapshotDisplayName carry the live profile if user-service
   * resolved it, otherwise the last-known-good stored snapshot — never a
   * synthetic "Unknown" placeholder for a valid user.
   */
  profileUnavailable?: boolean;
  /** ISO-8601 timestamp of when the member was banned; null when not banned. */
  bannedAt: string | null;
  /** AuthUser.id of the admin who banned the member; null when not banned. */
  bannedBy: string | null;
  /** Operator-supplied ban reason; null when not banned or no reason given. */
  banReason: string | null;
  /** ISO-8601 timestamp of when the active mute was applied; null if not muted. */
  mutedAt: string | null;
  /** AuthUser.id of the moderator who muted the member; null if not muted. */
  mutedBy: string | null;
  /** ISO-8601 timestamp when the mute expires; null = indefinite or not muted. */
  mutedUntil: string | null;
  /**
   * True while a moderation mute is currently effective for this member
   * (derived: `mutedAt != null && (mutedUntil == null || mutedUntil > now)`).
   * Single source of truth for "is this member muted" in member-roster reads.
   * Distinct from the per-user notification mute on `CommunityData.isMuted`.
   */
  isMuted: boolean;
};

/**
 * A single currently-banned member row. Returned by the banned-members list.
 *
 * Only members whose status is BANNED right now appear here — historical bans
 * that were later lifted live in the moderation audit trail (`listAuditLogs`),
 * not in this active list.
 */
export type CommunityBannedMemberData = {
  userId: string;
  username: string;
  displayName: string;
  /** Presigned GET URL for the member's avatar (private bucket); null if none. */
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  /** Nested media object for the avatar (additive; mirrors avatarUrl). */
  avatar: MediaObject;
  /** Epoch milliseconds of when the ban was applied; null if unknown. */
  bannedAt: number | null;
  /**
   * The moderator/admin who applied the ban. `displayName` is resolved from the
   * banning member's snapshot when they are still in the community, else null.
   */
  bannedBy: { userId: string; displayName: string | null } | null;
  banReason: string | null;
  /**
   * Ban duration class. Today all community bans are indefinite, so this is
   * always "PERMANENT"; the field is reserved for future temporary bans.
   */
  banType: "PERMANENT";
};

/** A single moderation-muted member row. Returned by mute / list-muted. */
export type CommunityMutedMemberData = {
  userId: string;
  snapshotUsername: string;
  snapshotDisplayName: string;
  snapshotAvatarUrl: string | null;
  snapshotAvatarUrlExpiresIn: number | null;
  /** Nested media object for the avatar (additive; mirrors snapshotAvatarUrl). */
  snapshotAvatar: MediaObject;
  /** AuthUser.id of the moderator/admin who muted the member. */
  mutedBy: string;
  reason: string | null;
  /** ISO-8601 timestamp of when the mute was created. */
  mutedAt: string;
  /** ISO-8601; null = indefinite mute. */
  mutedUntil: string | null;
};

/** A single moderation warning issued to a member. */
export type CommunityMemberWarningData = {
  warningId: string;
  userId: string;
  warnedBy: string;
  note: string;
  createdAt: string;
};

/** Per-community notification preference toggles for the calling member. */
export type CommunityNotificationPreferenceData = {
  communityId: string;
  /** null = not muted or muted indefinitely. */
  mutedUntil: string | null;
  streamEnabled: boolean;
  chatEnabled: boolean;
  announcementEnabled: boolean;
  /**
   * Derived convenience flag for the FE mute badge: true when EVERY category
   * toggle is off (stream + chat + announcement all disabled). Not stored —
   * computed from the three toggles above.
   */
  isMuted: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

/** Reason a requested userId was skipped by the add-members endpoint. */
export type AddMemberSkipReason = "ALREADY_MEMBER" | "BANNED" | "NOT_FRIEND";

/** Result of adding members: rows added vs. userIds skipped (with reason). */
export type AddMembersResult = {
  added: CommunityMemberData[];
  skipped: { userId: string; reason: AddMemberSkipReason }[];
};

/** Moderation actions recorded in the community audit log. */
export type CommunityAuditAction =
  | "MEMBER_PROMOTED"
  | "MEMBER_DEMOTED"
  | "MEMBER_KICKED"
  | "MEMBER_BANNED"
  | "MEMBER_UNBANNED"
  | "MEMBER_MUTED"
  | "MEMBER_UNMUTED"
  | "MEMBER_WARNED"
  | "ADMIN_TRANSFERRED"
  | "COMMUNITY_JOINED"
  | "COMMUNITY_DELETED"
  | "COMMUNITY_CLOSED"
  | "COMMUNITY_REOPENED"
  | "JOIN_REQUEST_APPROVED"
  | "JOIN_REQUEST_REJECTED"
  | "MEMBER_INVITED"
  | "INVITE_ACCEPTED"
  | "INVITE_DECLINED"
  | "COMMUNITY_REPORT_REVIEWED"
  | "COMMUNITY_REPORT_ACTIONED"
  | "COMMUNITY_REPORT_DISMISSED"
  | "COMMUNITY_REPORT_DELETED"
  | "MEMBER_LEFT"
  | "INVITE_LINK_CREATED"
  | "INVITE_LINK_REVOKED"
  | "INVITE_LINK_REDEEMED"
  | "INVITE_LINK_BULK_SENT"
  // Backoffice (admin panel) moderation: close/reopen a community.
  | "ADMIN_SUSPEND_COMMUNITY"
  | "ADMIN_REOPEN_COMMUNITY";

/** Shareable community invite link DTO (distinct from 1:1 CommunityInvite). */
export type CommunityInviteLinkData = {
  linkId: string;
  code: string;
  /**
   * Primary shareable HTTPS link, generated from the community's privacy:
   *  • PUBLIC  → handle-based, deterministic, code-independent: `<base>/<handle>`
   *  • PRIVATE → invite-code-based, revocable: `<base>/+<code>`
   * Falls back to the bare handle/code when no base URL is configured (local/dev).
   */
  url: string;
  /**
   * App deep-link matching `url`'s privacy mechanism:
   *  • PUBLIC  → `aimess://resolve?handle=<handle>`
   *  • PRIVATE → `aimess://join?code=<code>`
   */
  appDeepLink: string;
  /**
   * Which mechanism produced `url`/`appDeepLink`. Lets clients branch without
   * re-deriving privacy from the URL shape:
   *  • "PUBLIC_HANDLE"  → handle-based (PUBLIC community)
   *  • "PRIVATE_INVITE" → invite-code-based (PRIVATE community)
   */
  linkType: "PUBLIC_HANDLE" | "PRIVATE_INVITE";
  communityId: string;
  createdBy: string;
  maxUses: number | null;
  usedCount: number;
  /** When true, redeeming this link directly adds the member instead of creating a join request. */
  autoApprove: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** Computed: not revoked, not expired, not exhausted. */
  isActive: boolean;
  /** True when this represents the community's permanent invitation code (stored on the Community row, not a CommunityInviteLink row). */
  isPermanent: boolean;
};

/**
 * Community preview returned for an unauthenticated (or optional-auth) invite-link
 * lookup. Exposes enough detail for the "Join via invite" screen without leaking
 * full member lists or private metadata.
 */
export type InviteLinkPreviewData = {
  communityId: string;
  communityName: string;
  description: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  memberCount: number;
  communityType: CommunityType;
  isJoined: boolean;
  /**
   * Caller's PENDING join-request id for this community, or null. Non-null →
   * the client renders PRIVATE_REQUESTED (+Cancel) instead of "Request to Join"
   * (Sharing & Deep-Linking spec §3/§6, flow F5/E5).
   */
  joinRequestId: string | null;
  joinRequestStatus: "PENDING" | null;
  invitationCode: string;
  inviteUrl: string;
  appDeepLink: string;
  expiresAt: number | null;
  creatorId: string;
};

/**
 * Response for `GET /communities/:id/invitation-link`.
 *
 * The permanent invitation link for a PRIVATE community — generated once during
 * the community's lifetime and NEVER changed unless an admin explicitly requests
 * regeneration (future `POST /communities/:id/regenerate-invitation` feature).
 * Callers may safely cache this response indefinitely; the link is stable.
 */
export type PermanentInvitationLinkData = {
  communityId: string;
  communityName: string;
  invitationCode: string;
  /** HTTPS shareable link: `https://aimess.me/+<code>` */
  invitationLink: string;
  /** App deep-link: `aimess://join?code=<code>` */
  appDeepLink: string;
  /** Epoch ms — when the code was first generated. */
  createdAt: number;
};

/** Liked/favorited community record. */
export type CommunityFavoriteData = {
  favoriteId: string;
  communityId: string;
  createdAt: string;
};

/** Plain join-request DTO (used by approve/reject/cancel/my-self-fetch responses). */
export type CommunityJoinRequestData = {
  requestId: string;
  communityId: string;
  userId: string;
  status: CommunityJoinReqStatus;
  message: string | null;
  decidedBy: string | null;
  /** ISO-8601 */
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Discriminated union returned by `communityService.joinCommunity()`.
 * - JOINED: PUBLIC community — user is now ACTIVE.
 * - ALREADY_MEMBER: caller was already ACTIVE in any community type.
 * - REQUEST_CREATED: PRIVATE community — PENDING join request created/recycled.
 */
export type CommunityJoinResult =
  | {
      status: "JOINED";
      membershipStatus: "ACTIVE";
      member: CommunityMemberData;
    }
  | {
      status: "ALREADY_MEMBER";
      membershipStatus: "ACTIVE";
      member: CommunityMemberData;
    }
  | {
      status: "REQUEST_CREATED";
      membershipStatus: "PENDING";
      request: CommunityJoinRequestData;
    };

/** Join-request row enriched with requester snapshot — for mod-facing list. */
export type CommunityJoinRequestWithUserData = CommunityJoinRequestData & {
  user: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    avatarUrlExpiresIn: number | null;
    /** Nested media object for the avatar (additive; mirrors avatarUrl). */
    avatar: MediaObject;
  };
};

/** Join-request row enriched with the community summary — for the caller's "mine" list. */
export type MyJoinRequestData = CommunityJoinRequestData & {
  community: {
    id: string;
    name: string;
    handle: string;
    type: CommunityType;
    memberCount: number;
    /** Static platform-wide max members per community (currently a fixed cap). */
    memberLimit: number;
    avatarUrl: string | null;
    avatarUrlExpiresIn: number | null;
    /** Nested media object for the avatar (additive; mirrors avatarUrl). */
    avatar: MediaObject;
    /** Owner lifecycle status: ACTIVE = open; CLOSED = owner closed. */
    status: "ACTIVE" | "CLOSED";
  };
};

export type BulkInviteOutcome =
  | "INVITED"
  | "ALREADY_INVITED"
  | "ALREADY_MEMBER"
  | "FAILED";

export type BulkInviteUserResult = {
  userId: string;
  outcome: BulkInviteOutcome;
  inviteId?: string;
  reason?: string;
};

/** Summary returned by the bulk-invite endpoint. */
export type BulkInviteResult = {
  totalRequested: number;
  invited: number;
  alreadyInvited: number;
  alreadyMembers: number;
  failed: number;
  results: BulkInviteUserResult[];
};

/** Plain invite DTO (accept/decline responses, create response). */
export type CommunityInviteData = {
  inviteId: string;
  communityId: string;
  inviterId: string;
  inviteeId: string;
  status: CommunityInviteStatus;
  createdAt: string;
  updatedAt: string;
};

/** Invite row enriched with invitee snapshot — for mod-facing list. */
export type CommunityInviteWithUserData = CommunityInviteData & {
  invitee: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    avatarUrlExpiresIn: number | null;
    /** Nested media object for the avatar (additive; mirrors avatarUrl). */
    avatar: MediaObject;
  };
};

/** Invite row enriched with community summary — for invitee's "mine" list. */
export type MyInviteData = CommunityInviteData & {
  community: {
    id: string;
    name: string;
    handle: string;
    type: CommunityType;
    memberCount: number;
    /** Static platform-wide max members per community (currently a fixed cap). */
    memberLimit: number;
    avatarUrl: string | null;
    avatarUrlExpiresIn: number | null;
    /** Nested media object for the avatar (additive; mirrors avatarUrl). */
    avatar: MediaObject;
    /** Owner lifecycle status: ACTIVE = open; CLOSED = owner closed. */
    status: "ACTIVE" | "CLOSED";
  };
};

/** Plain report DTO (create / resolve responses, mine list base). */
export type CommunityReportData = {
  reportId: string;
  /**
   * Short, human-friendly id derived deterministically from `reportId`
   * (clients render it as e.g. "#99421"). Stable per report; display-only.
   */
  displayId: string;
  communityId: string;
  reporterId: string;
  targetUserId: string | null;
  reason: string;
  /** Mandatory custom description when `reason` is "OTHER"; null otherwise. */
  otherReason: string | null;
  status: CommunityReportStatus;
  reviewedBy: string | null;
  /** ISO-8601 */
  reviewedAt: string | null;
  resolution: string | null;
  /**
   * Reported-content snapshot — all null/empty when the report is user-level
   * only (no specific message referenced).
   */
  reportedMessageId: string | null;
  /** CONTENT_TYPES (UPPER): TEXT, IMAGE, VIDEO, … */
  reportedContentType: string | null;
  /** Text / caption snapshot of the reported content. */
  reportedContentText: string | null;
  /** ISO-8601 — when the reported content was originally posted. */
  reportedContentPostedAt: string | null;
  /** Reported attachments, resolved to presigned media on read ([] when none). */
  reportedContentMedia: MediaObject[];
  createdAt: string;
  updatedAt: string;
};

/**
 * Report row enriched with reporter + (optional) target user snapshots —
 * for mod-facing list under a community.
 */
export type CommunityReportWithUsersData = CommunityReportData & {
  reporter: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    avatarUrlExpiresIn: number | null;
    /** Nested media object for the avatar (additive; mirrors avatarUrl). */
    avatar: MediaObject;
  };
  target: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    avatarUrlExpiresIn: number | null;
    /** Nested media object for the avatar (additive; mirrors avatarUrl). */
    avatar: MediaObject;
  } | null;
};

/** Report row enriched with the community summary — for caller's "mine" list. */
export type MyReportData = CommunityReportData & {
  community: {
    id: string;
    name: string;
    handle: string;
    type: CommunityType;
    memberCount: number;
    /** Static platform-wide max members per community (currently a fixed cap). */
    memberLimit: number;
    avatarUrl: string | null;
    avatarUrlExpiresIn: number | null;
    /** Nested media object for the avatar (additive; mirrors avatarUrl). */
    avatar: MediaObject;
    /** Owner lifecycle status: ACTIVE = open; CLOSED = owner closed. */
    status: "ACTIVE" | "CLOSED";
  };
};

/** A single audit-log row returned by the audit-log endpoint. */
export type CommunityAuditLogData = {
  id: string;
  communityId: string;
  actorId: string;
  action: CommunityAuditAction;
  targetUserId: string | null;
  reason: string | null;
  /** Action-specific structured context (as stored); null when absent. */
  metadata: unknown;
  /** ISO-8601 timestamp of when the action was recorded. */
  createdAt: string;
};
