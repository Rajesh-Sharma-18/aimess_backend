import type {
  CommunityInviteStatus,
  CommunityJoinReqStatus,
  CommunityMemberRole,
  CommunityMemberStatus,
  CommunityReportStatus,
  CommunityType,
} from "../generated/prisma/index.js";

export type CommunityImageView = {
  url: string;
  expiresIn: number;
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
  /** Presigned GET URL (private bucket); null if no avatar. */
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  /** Presigned GET URL (private bucket); null if no cover. */
  coverUrl: string | null;
  coverUrlExpiresIn: number | null;
  /** Caller's membership role, or null if not a member. */
  myRole: CommunityMemberRole | null;
  /** True if the caller has a mute row for this community (any state). */
  myIsMuted: boolean;
  /** ISO-8601; null when not muted or muted indefinitely. */
  myMuteUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Per-user mute config for a community. Returned by `GET /:id/mute`. */
export type CommunityMuteData = {
  communityId: string;
  /** null = indefinite mute. */
  mutedUntil: string | null;
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

export type CommunityListItem = {
  id: string;
  name: string;
  handle: string;
  type: CommunityType;
  memberCount: number;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  myRole: CommunityMemberRole;
};

/**
 * A public community surfaced by discovery/browse. The caller is, by
 * definition, not a member — so there is no `myRole`. Includes description and
 * category to render browse cards.
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
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  createdAt: string;
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
  | "ADMIN_TRANSFERRED"
  | "COMMUNITY_JOINED"
  | "COMMUNITY_DELETED"
  | "JOIN_REQUEST_APPROVED"
  | "JOIN_REQUEST_REJECTED"
  | "MEMBER_INVITED"
  | "INVITE_ACCEPTED"
  | "INVITE_DECLINED"
  | "COMMUNITY_REPORT_REVIEWED"
  | "COMMUNITY_REPORT_ACTIONED"
  | "COMMUNITY_REPORT_DISMISSED"
  | "MEMBER_LEFT"
  | "INVITE_LINK_CREATED"
  | "INVITE_LINK_REVOKED"
  | "INVITE_LINK_REDEEMED";

/** Shareable community invite link DTO (distinct from 1:1 CommunityInvite). */
export type CommunityInviteLinkData = {
  linkId: string;
  code: string;
  /** Built from INVITE_LINK_BASE_URL when set, else just the code. */
  url: string;
  communityId: string;
  createdBy: string;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** Computed: not revoked, not expired, not exhausted. */
  isActive: boolean;
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

/** Join-request row enriched with requester snapshot — for mod-facing list. */
export type CommunityJoinRequestWithUserData = CommunityJoinRequestData & {
  user: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    avatarUrlExpiresIn: number | null;
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
    avatarUrl: string | null;
    avatarUrlExpiresIn: number | null;
  };
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
    avatarUrl: string | null;
    avatarUrlExpiresIn: number | null;
  };
};

/** Plain report DTO (create / resolve responses, mine list base). */
export type CommunityReportData = {
  reportId: string;
  communityId: string;
  reporterId: string;
  targetUserId: string | null;
  reason: string;
  status: CommunityReportStatus;
  reviewedBy: string | null;
  /** ISO-8601 */
  reviewedAt: string | null;
  resolution: string | null;
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
  };
  target: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    avatarUrlExpiresIn: number | null;
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
    avatarUrl: string | null;
    avatarUrlExpiresIn: number | null;
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
