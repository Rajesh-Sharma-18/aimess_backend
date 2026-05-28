import type {
  CommunityMemberRole,
  CommunityMemberStatus,
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

export type MyCommunitiesResult = {
  communities: CommunityListItem[];
  nextCursor: string | null;
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

export type CommunityMembersResult = {
  members: CommunityMemberData[];
  nextCursor: string | null;
};

/** Reason a requested userId was skipped by the add-members endpoint. */
export type AddMemberSkipReason = "ALREADY_MEMBER" | "BANNED";

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
  | "ADMIN_TRANSFERRED";

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

export type CommunityAuditLogsResult = {
  logs: CommunityAuditLogData[];
  nextCursor: string | null;
};
