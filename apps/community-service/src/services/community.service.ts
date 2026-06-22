import { randomBytes } from "node:crypto";

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from "@aimess/errors";
import { logger } from "@aimess/logger";
import { publishChatUserEvent, publishCommunityRoomEvent } from "@aimess/redis";
import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import type {
  CommunityMemberAddedPayload,
  CommunityMemberRemovedPayload,
  CommunityMemberUnbannedPayload,
  CommunityStatsUpdatedPayload,
  MediaObject,
} from "@aimess/shared-types";

import { redis } from "../config/redis.js";
import { mediaUrlStrategy } from "../config/storage.js";
import { communityRepository } from "../repositories/community.repository.js";
import { communityCache } from "../lib/community-cache.js";
import {
  assertCommunityRole,
  assertNotBanned,
  COMMUNITY_ROLE_RANK,
} from "../lib/community-authz.js";
import {
  buildPaginatedResponse,
  type PaginatedResponse,
} from "../lib/pagination.js";
import {
  normalizeHandle,
  normalizeName,
  slugifyCategoryName,
} from "../lib/community-slug.util.js";
import { COMMUNITY_MEMBER_LIMIT } from "../constants/index.js";
import { env } from "../config/env.js";
import {
  CommunityInviteStatus,
  CommunityJoinReqStatus,
  CommunityMemberRole,
  CommunityMemberStatus,
  CommunityModerationStatus,
  CommunityReportStatus,
  CommunityType,
  Prisma,
  type Community,
  type CommunityInvite,
  type CommunityInviteLink,
  type CommunityJoinRequest,
  type CommunityReport,
} from "../generated/prisma/index.js";
import type {
  AddMembersResult,
  AdminCategoryData,
  AdminCategoryListResult,
  CommunityAuditAction,
  CommunityAuditLogData,
  CommunityAvailability,
  CommunityCategoryData,
  CommunityData,
  CommunityDiscoverItem,
  CommunityJoinResult,
  CommunityLastActivity,
  CommunityInviteData,
  CommunityInviteLinkData,
  CommunityInviteWithUserData,
  CommunityFavoriteData,
  CommunityJoinRequestData,
  CommunityJoinRequestWithUserData,
  CommunityListItem,
  CommunityBannedMemberData,
  CommunityMemberData,
  CommunityMemberWarningData,
  CommunityMutedMemberData,
  CommunityMuteData,
  CommunityNotificationPreferenceData,
  CommunityReportData,
  CommunityReportWithUsersData,
  InviteLinkPreviewData,
  MyInviteData,
  MyJoinRequestData,
  MyReportData,
} from "../types/community.types.js";
import { communityImageService } from "./community-image.service.js";
import { memberAvatarService } from "./member-avatar.service.js";
import { getChatClient } from "../grpc/chat.client.js";
import {
  fetchAcceptedFriendIds,
  fetchUserSnapshots,
} from "../lib/user-client.js";
import type {
  CreateCommunityInput,
  UpdateCommunityInput,
} from "../api/validators/community.validator.js";
import {
  publishCommunityAdminTransferredSafe,
  publishCommunityDeletedSafe,
  publishCommunityInviteAcceptedSafe,
  publishCommunityInviteSentSafe,
  publishCommunityJoinRequestApprovedSafe,
  publishCommunityJoinRequestCancelledSafe,
  publishCommunityJoinRequestedSafe,
  publishCommunityJoinRequestRejectedSafe,
  publishCommunityMemberAddedSafe,
  publishCommunityMemberBannedSafe,
  publishCommunityMemberJoinedSafe,
  publishCommunityMemberKickedSafe,
  publishCommunityMemberLeftSafe,
  publishCommunityMemberMutedSafe,
  publishCommunityMemberUnbannedSafe,
  publishCommunityMemberUnmutedSafe,
  publishCommunityMemberWarnedSafe,
  publishCommunityMemberRoleChangedSafe,
  publishCommunityReportActionedSafe,
  publishCommunityReportCreatedSafe,
} from "../messaging/publish-community.js";
import {
  publishCommunityCreatedForChatSafe,
  publishCommunityDeletedForChatSafe,
  publishCommunityInviteLinkSharedForChatSafe,
  publishCommunityStatusChangedForChatSafe,
  publishCommunitySystemMessageForChatSafe,
  publishCommunityVisibilityChangedForChatSafe,
} from "../messaging/publish-community-chat.js";
import { publishAdminReportIngestSafe } from "../messaging/publish-admin-report.js";

type CommunityWithCategory = Community & {
  category: { id: string; name: string };
};

function isUniqueConstraintError(
  error: unknown
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/** Map a P2002 to the right conflict (name vs handle) using the meta target. */
function uniqueViolationToConflict(
  error: Prisma.PrismaClientKnownRequestError
): ConflictError {
  const target = error.meta?.target;
  const text = Array.isArray(target)
    ? target.join(",")
    : typeof target === "string"
      ? target
      : "";
  if (text.toLowerCase().includes("handle")) {
    return new ConflictError("COMMUNITY_HANDLE_TAKEN");
  }
  return new ConflictError("COMMUNITY_NAME_TAKEN");
}

/**
 * Guard: throws 403 COMMUNITY_SUSPENDED when a community has been closed by an
 * admin. Call this after the community is loaded in any write path that should
 * be blocked while the community is suspended (join, update, add members, etc.).
 * Read-only paths and existing-member moderation actions (kick/ban/mute/leave)
 * are intentionally NOT blocked.
 */
function assertCommunityNotSuspended(community: {
  moderationStatus: CommunityModerationStatus;
}): void {
  if (community.moderationStatus === CommunityModerationStatus.SUSPENDED) {
    throw new ForbiddenError("COMMUNITY_SUSPENDED");
  }
}

const COMMUNITY_IMAGE_PREFIXES = MEDIA_PREFIXES.community;
const AVATAR_PREFIXES = MEDIA_PREFIXES.userAvatars;

/**
 * Build the additive nested {@link MediaObject} for a community image (avatar or
 * cover) from the RAW stored DB value (object key or legacy URL). Resolves the
 * presigned download URL via the shared strategy; a null/empty value yields an
 * all-null MediaObject.
 */
function buildCommunityImageMedia(
  stored: string | null | undefined
): Promise<MediaObject> {
  return toMediaObject({
    bucket: env.MINIO_BUCKET_COMMUNITY,
    stored: stored ?? null,
    prefixes: COMMUNITY_IMAGE_PREFIXES,
    strategy: mediaUrlStrategy,
  });
}

/**
 * Build the additive nested {@link MediaObject} for a member's snapshot avatar
 * from the RAW stored object key. The key lives in the shared avatars bucket
 * (cross-service). HEAD-free, like the legacy member-avatar resolver.
 */
function buildAvatarMedia(
  stored: string | null | undefined
): Promise<MediaObject> {
  return toMediaObject({
    bucket: env.MINIO_BUCKET_AVATARS,
    stored: stored ?? null,
    prefixes: AVATAR_PREFIXES,
    strategy: mediaUrlStrategy,
  });
}

/**
 * USER-message activity types: a real member action. The community-list preview
 * keeps the sender so the client can render "<sender>: <preview>" / "You: …".
 */
const PREFIXED_ACTIVITY_TYPES = new Set([
  "message",
  "reaction",
  "edited",
  "deleted",
]);

/**
 * SYSTEM / lifecycle activity types: the stored preview is a complete,
 * self-describing sentence (e.g. "Community photo updated", "John Doe became
 * admin", "John Doe joined the community"). These MUST be shown standalone in the
 * community list — NEVER prefixed with a sender name. This single set is the
 * source of truth for the no-prefix rule; `buildLastActivity` forces
 * `username: null` for every member of it so the Mine/List/Search/Summary DTOs
 * can never leak a "Someone: <system text>" prefix.
 */
const SENDERLESS_ACTIVITY_TYPES = new Set([
  "system",
  "created",
  "join",
  "removal",
  "pinned",
  "unpinned",
]);

const SELF_JOIN_ACTIVITY_PREVIEW = "You joined the community";

/**
 * The single `buildLastActivityPreview()`-style helper for the community list:
 * maps the denormalized `lastActivity*` columns to the {@link CommunityLastActivity}
 * DTO, applying the prefix rule centrally.
 *
 * - USER message  → `{ username, preview }` (client prefixes the sender).
 * - SYSTEM/lifecycle → `{ username: null, preview }` (standalone, no prefix).
 *
 * Exported for unit coverage (community-list-activity.test.ts).
 */
/**
 * Personalize the community-list preview for one viewer. Self-referential SYSTEM
 * lines (a role change or a join) are ABOUT one member: chat-service stores the
 * subject in `lastActivityUserId` and a first-person `lastActivitySelfPreview`
 * ("You are now a moderator" / "You joined the community"). The viewer who IS
 * the subject sees that "You …" line; everyone else sees the third-person
 * `lastActivityPreview`. Returns null only when there is no stored preview.
 *
 * Exported for unit coverage (community-self-preview.test.ts).
 */
export function selectListPreview(
  row: {
    lastActivityType?: string | null;
    lastActivityPreview?: string | null;
    lastActivitySelfPreview?: string | null;
    lastActivityUserId?: string | null;
  },
  viewerId: string
): string | null {
  if (row.lastActivitySelfPreview && row.lastActivityUserId === viewerId) {
    return row.lastActivitySelfPreview;
  }
  if (row.lastActivityType === "join" && row.lastActivityUserId === viewerId) {
    return SELF_JOIN_ACTIVITY_PREVIEW;
  }
  return row.lastActivityPreview ?? null;
}

export function buildLastActivity(community: {
  lastActivityAt: Date;
  lastActivityType?: string | null;
  lastActivityPreview?: string | null;
  lastActivityUsername?: string | null;
  lastActivityUserId?: string | null;
  createdAt: Date;
}): CommunityLastActivity {
  const rawType = community.lastActivityType ?? "created";

  // USER MESSAGE → carry the sender so the client renders "<sender>: <preview>".
  if (PREFIXED_ACTIVITY_TYPES.has(rawType)) {
    return {
      type: rawType as "message" | "reaction" | "edited" | "deleted",
      userId: community.lastActivityUserId ?? null,
      username: community.lastActivityUsername ?? "",
      preview: community.lastActivityPreview ?? "",
      dateTime: community.lastActivityAt.getTime(),
    };
  }

  // SYSTEM / lifecycle (and any unknown/legacy type → safe "created" default):
  // standalone sentence, NEVER prefixed → username is forced to null.
  const systemType = (
    SENDERLESS_ACTIVITY_TYPES.has(rawType) ? rawType : "created"
  ) as "system" | "created" | "join" | "removal" | "pinned" | "unpinned";
  const dateTime =
    systemType === "created"
      ? community.createdAt.getTime()
      : community.lastActivityAt.getTime();
  return {
    type: systemType,
    userId: null,
    username: null,
    preview:
      community.lastActivityPreview ??
      (systemType === "created" ? "Community created successfully" : ""),
    dateTime,
  };
}

/**
 * Telegram-style mapping from the set of community fields that actually changed
 * in one `update()` call to the ONE system-message subtype to post:
 *   - 0 fields            → null (nothing changed worth a line)
 *   - exactly 1 field     → its dedicated specific subtype where one exists
 *                           (name / description / avatar / banner), else the
 *                           generic COMMUNITY_UPDATED ("Community details updated")
 *   - 2+ fields           → one collapsed COMMUNITY_UPDATED ("Community details updated")
 *
 * Single source of truth for the "specific-or-collapsed" rule; exported for unit
 * coverage (community-update-system-message.test.ts).
 */
const COMMUNITY_UPDATE_SINGLE_FIELD_SUBTYPE: Record<string, string> = {
  name: "COMMUNITY_NAME_UPDATED",
  description: "COMMUNITY_DESCRIPTION_UPDATED",
  avatar: "COMMUNITY_AVATAR_UPDATED",
  banner: "COMMUNITY_BANNER_UPDATED",
};

export function selectCommunityUpdateSystemMessageType(
  changedFields: string[]
): string | null {
  if (changedFields.length === 0) return null;
  if (changedFields.length === 1) {
    return (
      COMMUNITY_UPDATE_SINGLE_FIELD_SUBTYPE[changedFields[0]!] ??
      "COMMUNITY_UPDATED"
    );
  }
  return "COMMUNITY_UPDATED";
}

/**
 * The set of community fields that ACTUALLY changed in one `update()` save —
 * the input to {@link selectCommunityUpdateSystemMessageType}. Each field counts
 * ONLY when its incoming value genuinely differs from the stored one. This is
 * the fix for the "always generic 'Community was updated'" bug: edit forms
 * resubmit the whole community (current avatar key, current category, the same
 * description) even when the user touched a single field, so a naive "field was
 * present in the payload" check inflated the set to 2+ and collapsed every save
 * into the generic line instead of the specific one (name/description/avatar).
 *
 * `name`/`handle` are passed pre-normalized and `avatar` pre-resolved (those
 * transforms are async / live in `update()`); the comparison itself is pure and
 * unit-tested. Exported as the single source of truth for the rule.
 */
export function detectCommunityChangedFields(
  current: {
    name: string;
    description: string | null;
    avatarUrl: string | null;
    type: string;
    categoryId: string;
    handle: string;
  },
  next: {
    /** Normalized next name, or undefined when not in the payload. */
    name?: string;
    description?: string | null;
    /** Whether `avatarObjectKey` was present in the payload at all. */
    avatarProvided: boolean;
    /** Resolved next avatar object key (null = cleared). */
    nextAvatarUrl: string | null;
    type?: string;
    categoryId?: string;
    /** Normalized next handle, or undefined when not in the payload. */
    handle?: string;
  }
): string[] {
  const changed: string[] = [];
  if (next.name !== undefined && next.name !== current.name) {
    changed.push("name");
  }
  if (
    next.description !== undefined &&
    (next.description ?? "") !== (current.description ?? "")
  ) {
    changed.push("description");
  }
  if (
    next.avatarProvided &&
    next.nextAvatarUrl !== (current.avatarUrl ?? null)
  ) {
    changed.push("avatar");
  }
  if (next.type !== undefined && next.type !== current.type) {
    changed.push("visibility");
  }
  if (next.categoryId !== undefined && next.categoryId !== current.categoryId) {
    changed.push("category");
  }
  if (next.handle !== undefined && next.handle !== current.handle) {
    changed.push("handle");
  }
  return changed;
}

async function toCommunityData(
  community: CommunityWithCategory,
  myRole: CommunityMemberRole | null,
  muteRow: MuteRowFragment,
  joinRequest: { id: string; status: CommunityJoinReqStatus } | null = null
): Promise<CommunityData> {
  const avatarView = await communityImageService.resolveViewUrlForClient(
    community.avatarUrl
  );
  const avatar = await buildCommunityImageMedia(community.avatarUrl);
  const cover = await buildCommunityImageMedia(community.coverUrl);

  return {
    id: community.id,
    name: community.name,
    handle: community.handle,
    description: community.description,
    type: community.type,
    category: { id: community.category.id, name: community.category.name },
    creatorId: community.creatorId,
    adminId: community.adminId,
    memberCount: community.memberCount,
    memberLimit: COMMUNITY_MEMBER_LIMIT,
    avatarUrl: avatarView?.url ?? null,
    avatarUrlExpiresIn: avatarView?.expiresIn ?? null,
    avatar,
    coverUrl: null,
    coverUrlExpiresIn: null,
    cover,
    role: myRole,
    isJoined: myRole !== null,
    joinRequestId:
      joinRequest?.status === CommunityJoinReqStatus.PENDING
        ? joinRequest.id
        : null,
    joinRequestStatus:
      joinRequest?.status === CommunityJoinReqStatus.PENDING
        ? CommunityJoinReqStatus.PENDING
        : null,
    ...muteFields(muteRow),
    moderationStatus: community.moderationStatus,
    // Phase 1 stub — wire to stream-service gRPC in Phase 2.
    isLive: false,
    createdAt: community.createdAt.toISOString(),
    updatedAt: community.updatedAt.toISOString(),
    lastActivity: buildLastActivity(community),
  };
}

/**
 * Batch-load the caller's mute rows for a set of communities, keyed by
 * communityId. One indexed query for the whole page — avoids N+1 when listing.
 */
type MuteRowFragment =
  | {
      mutedUntil: Date | null;
      streamEnabled: boolean;
      chatEnabled: boolean;
      announcementEnabled: boolean;
    }
  | null
  | undefined;

async function loadMuteMap(
  userId: string,
  communityIds: string[]
): Promise<Map<string, MuteRowFragment>> {
  if (communityIds.length === 0) return new Map();
  const rows = await communityRepository.findMutesByUserAndCommunityIds(
    userId,
    communityIds
  );
  return new Map(rows.map((row) => [row.communityId, row]));
}

/** Derive the caller-facing mute + notification-preference fields from a (possibly absent) mute row. */
function muteFields(muteRow: MuteRowFragment): {
  isMuted: boolean;
  muteUntil: string | null;
  streamEnabled: boolean;
  chatEnabled: boolean;
  announcementEnabled: boolean;
} {
  return {
    isMuted: !!muteRow,
    muteUntil: muteRow?.mutedUntil ? muteRow.mutedUntil.toISOString() : null,
    streamEnabled: muteRow?.streamEnabled ?? true,
    chatEnabled: muteRow?.chatEnabled ?? true,
    announcementEnabled: muteRow?.announcementEnabled ?? true,
  };
}

/** Map a community row to the discovery/browse DTO (resolves avatar URL). */
async function toDiscoverItem(
  community: {
    id: string;
    name: string;
    handle: string;
    description: string | null;
    type: CommunityType;
    memberCount: number;
    avatarUrl: string | null;
    createdAt: Date;
    lastActivityAt: Date;
    lastActivityType?: string | null;
    lastActivityPreview?: string | null;
    lastActivityUsername?: string | null;
    lastActivityUserId?: string | null;
    lastActivitySelfPreview?: string | null;
    moderationStatus: CommunityModerationStatus;
    category: { id: string; name: string };
  },
  muteRow: MuteRowFragment,
  isJoined: boolean,
  hasRequested: boolean,
  viewerId?: string
): Promise<CommunityDiscoverItem> {
  const avatarView = await communityImageService.resolveViewUrlForClient(
    community.avatarUrl
  );
  const avatar = await buildCommunityImageMedia(community.avatarUrl);

  return {
    id: community.id,
    name: community.name,
    handle: community.handle,
    description: community.description,
    type: community.type,
    category: { id: community.category.id, name: community.category.name },
    memberCount: community.memberCount,
    memberLimit: COMMUNITY_MEMBER_LIMIT,
    avatarUrl: avatarView?.url ?? null,
    avatarUrlExpiresIn: avatarView?.expiresIn ?? null,
    avatar,
    isJoined,
    hasRequested,
    ...muteFields(muteRow),
    // Phase 1 stub — wire to stream-service gRPC in Phase 2.
    isLive: false,
    moderationStatus: community.moderationStatus,
    createdAt: community.createdAt.getTime(),
    lastActivity: buildLastActivity({
      ...community,
      lastActivityPreview: viewerId
        ? selectListPreview(community, viewerId)
        : community.lastActivityPreview,
    }),
  };
}

/** Map a community member row to the API DTO (joinedAt → ISO string). */
async function toMemberData(member: {
  userId: string;
  role: CommunityMemberRole;
  status: CommunityMemberStatus;
  joinedAt: Date;
  snapshotUsername: string;
  snapshotDisplayName: string;
  snapshotAvatarKey: string | null;
  bannedAt?: Date | null;
  bannedBy?: string | null;
  banReason?: string | null;
}): Promise<CommunityMemberData> {
  const avatarView = await memberAvatarService.resolveViewUrl(
    member.snapshotAvatarKey
  );
  const snapshotAvatar = await buildAvatarMedia(member.snapshotAvatarKey);

  return {
    userId: member.userId,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt.toISOString(),
    snapshotUsername: member.snapshotUsername,
    snapshotDisplayName: member.snapshotDisplayName,
    snapshotAvatarUrl: avatarView?.url ?? null,
    snapshotAvatarUrlExpiresIn: avatarView?.expiresIn ?? null,
    snapshotAvatar,
    bannedAt: member.bannedAt ? member.bannedAt.toISOString() : null,
    bannedBy: member.bannedBy ?? null,
    banReason: member.banReason ?? null,
  };
}

function toJoinRequestData(
  row: CommunityJoinRequest
): CommunityJoinRequestData {
  return {
    requestId: row.id,
    communityId: row.communityId,
    userId: row.userId,
    status: row.status,
    message: row.message,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toInviteData(row: CommunityInvite): CommunityInviteData {
  return {
    inviteId: row.id,
    communityId: row.communityId,
    inviterId: row.inviterId,
    inviteeId: row.inviteeId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toReportData(row: CommunityReport): CommunityReportData {
  return {
    reportId: row.id,
    communityId: row.communityId,
    reporterId: row.reporterId,
    targetUserId: row.targetUserId,
    reason: row.reason,
    status: row.status,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    resolution: row.resolution,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Resolve a community summary row (from `findCommunitiesByIds`) into the
 * "my list" embedded shape (presigned avatar URL).
 */
async function toEmbeddedCommunitySummary(community: {
  id: string;
  name: string;
  handle: string;
  type: CommunityType;
  memberCount: number;
  avatarUrl: string | null;
}) {
  const avatarView = await communityImageService.resolveViewUrlForClient(
    community.avatarUrl
  );
  const avatar = await buildCommunityImageMedia(community.avatarUrl);
  return {
    id: community.id,
    name: community.name,
    handle: community.handle,
    type: community.type,
    memberCount: community.memberCount,
    memberLimit: COMMUNITY_MEMBER_LIMIT,
    avatarUrl: avatarView?.url ?? null,
    avatarUrlExpiresIn: avatarView?.expiresIn ?? null,
    avatar,
  };
}

/** Snapshot + presigned avatar URL view used by mod-facing list rows. */
async function buildUserSnapshotView(
  snapshot: {
    username: string;
    displayName: string;
    avatarObjectKey: string | null;
  },
  userId: string
) {
  const avatarView = await memberAvatarService.resolveViewUrl(
    snapshot.avatarObjectKey
  );
  const avatar = await buildAvatarMedia(snapshot.avatarObjectKey);
  return {
    userId,
    username: snapshot.username,
    displayName: snapshot.displayName,
    avatarUrl: avatarView?.url ?? null,
    avatarUrlExpiresIn: avatarView?.expiresIn ?? null,
    avatar,
  };
}

function generateInviteCode(): string {
  // 16 bytes = 128 bits of entropy → ~22 URL-safe base64url chars.
  // Sufficient against brute-force on the public preview endpoint.
  // create flow retries on P2002 up to 3 times to handle the (negligible) collision risk.
  return randomBytes(16).toString("base64url");
}

/** Validates that an invite link is currently usable (not revoked, expired, or exhausted). */
function assertInviteLinkActive(link: {
  revokedAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  usedCount: number;
}): void {
  if (link.revokedAt)
    throw new GoneError("COMMUNITY_INVITE_LINK_REVOKED_ERROR");
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now())
    throw new GoneError("COMMUNITY_INVITE_LINK_EXPIRED");
  if (link.maxUses !== null && link.usedCount >= link.maxUses)
    throw new GoneError("COMMUNITY_INVITE_LINK_EXHAUSTED");
}

function buildInviteUrl(code: string): string {
  return env.INVITE_LINK_BASE_URL
    ? `${env.INVITE_LINK_BASE_URL}/${code}`
    : code;
}

function toInviteLinkData(row: CommunityInviteLink): CommunityInviteLinkData {
  const now = Date.now();
  const isActive =
    !row.revokedAt &&
    (!row.expiresAt || row.expiresAt.getTime() > now) &&
    (row.maxUses === null || row.usedCount < row.maxUses);
  return {
    linkId: row.id,
    code: row.code,
    url: buildInviteUrl(row.code),
    appDeepLink: `aimess://invite/${row.code}`,
    communityId: row.communityId,
    createdBy: row.createdBy,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    autoApprove: row.autoApprove,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    isActive,
  };
}

function toAuditLogData(log: {
  id: string;
  communityId: string;
  actorId: string;
  action: string;
  targetUserId: string | null;
  reason: string | null;
  metadata: unknown;
  createdAt: Date;
}): CommunityAuditLogData {
  return {
    id: log.id,
    communityId: log.communityId,
    actorId: log.actorId,
    action: log.action as CommunityAuditAction,
    targetUserId: log.targetUserId,
    reason: log.reason,
    metadata: log.metadata ?? null,
    createdAt: log.createdAt.toISOString(),
  };
}

/** Resolved chat enrichment for one community: unread count. */
type ChatEnrichment = {
  unreadMessageCount: number;
};

/**
 * Bulk-fetch community-chat summaries (unread count) for the caller and
 * index them by communityId. Member-only data is enforced in chat-service;
 * non-member / missing ids resolve to `{ unreadMessageCount: 0 }`. Always
 * degrades gracefully (empty map on chat failure — the gRPC client already
 * falls back to []).
 */
async function fetchChatEnrichment(
  userId: string,
  communityIds: string[]
): Promise<Map<string, ChatEnrichment>> {
  const map = new Map<string, ChatEnrichment>();
  if (!communityIds.length) return map;

  const summaries = await getChatClient().getCommunityChatSummaries({
    userId,
    communityIds,
  });
  for (const s of summaries) {
    map.set(s.communityId, {
      unreadMessageCount: s.unreadMessageCount ?? 0,
    });
  }
  return map;
}

const EMPTY_CHAT_ENRICHMENT: ChatEnrichment = {
  unreadMessageCount: 0,
};

export const communityService = {
  async listCategories(): Promise<CommunityCategoryData[]> {
    return communityRepository.listActiveCategories();
  },

  async listCategoriesAdmin(query: {
    search?: string;
    status?: "visible" | "hidden" | "all";
    page: number;
    limit: number;
  }): Promise<AdminCategoryListResult> {
    const active =
      query.status === "visible"
        ? true
        : query.status === "hidden"
          ? false
          : undefined;

    const [rows, total] = await communityRepository.listCategoriesAdmin({
      search: query.search,
      active,
      page: query.page,
      limit: query.limit,
    });

    const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);
    return {
      categories: rows.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        visible: c.active,
        order: c.order,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages,
        hasNext: query.page < totalPages,
        hasPrev: query.page > 1,
      },
    };
  },

  async createCategory(input: { name: string }): Promise<AdminCategoryData> {
    const name = normalizeName(input.name);
    const slug = slugifyCategoryName(name);

    const existing = await communityRepository.findCategoryByName(name);
    if (existing) throw new ConflictError("CATEGORY_NAME_TAKEN");

    const category = await communityRepository.createCategory({ name, slug });
    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      visible: category.active,
      order: category.order,
      createdAt: category.createdAt.toISOString(),
      updatedAt: category.updatedAt.toISOString(),
    };
  },

  async updateCategory(
    id: string,
    input: { name?: string; visible?: boolean }
  ): Promise<AdminCategoryData> {
    const category = await communityRepository.findCategoryByIdAdmin(id);
    if (!category) throw new NotFoundError("CATEGORY_NOT_FOUND");

    const updates: { name?: string; slug?: string; active?: boolean } = {};

    if (input.name !== undefined) {
      const name = normalizeName(input.name);
      const duplicate = await communityRepository.findCategoryByName(name, id);
      if (duplicate) throw new ConflictError("CATEGORY_NAME_TAKEN");
      updates.name = name;
      updates.slug = slugifyCategoryName(name);
    }

    if (input.visible !== undefined) {
      updates.active = input.visible;
    }

    const updated = await communityRepository.updateCategoryById(id, updates);
    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      visible: updated.active,
      order: updated.order,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  },

  async deleteCategory(id: string): Promise<void> {
    const category = await communityRepository.findCategoryByIdAdmin(id);
    if (!category) throw new NotFoundError("CATEGORY_NOT_FOUND");

    const inUse = await communityRepository.countCommunitiesWithCategory(id);
    if (inUse > 0) throw new ConflictError("CATEGORY_IN_USE");

    await communityRepository.deleteCategoryById(id);
  },

  async checkNameAvailability(
    name: string,
    excludeId?: string
  ): Promise<CommunityAvailability> {
    const canonical = normalizeName(name);

    const cached = await communityCache.getNameAvailability(
      canonical,
      excludeId
    );
    if (cached !== null) {
      return { name: canonical, available: cached.available };
    }

    const existing = await communityRepository.findByName(canonical);
    const available = !existing || existing.id === excludeId;

    await communityCache.setNameAvailability(canonical, excludeId, available);
    return { name: canonical, available };
  },

  async checkHandleAvailability(
    handle: string,
    excludeId?: string
  ): Promise<CommunityAvailability> {
    const canonical = normalizeHandle(handle);

    const cached = await communityCache.getHandleAvailability(
      canonical,
      excludeId
    );
    if (cached !== null) {
      return { handle: canonical, available: cached.available };
    }

    const existing = await communityRepository.findByHandle(canonical);
    const available = !existing || existing.id === excludeId;

    await communityCache.setHandleAvailability(canonical, excludeId, available);
    return { handle: canonical, available };
  },

  async getById(id: string, callerId: string): Promise<CommunityData> {
    const community = await communityRepository.findById(id);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(id, callerId);
    // A BANNED user is denied the community-details view entirely (403), even
    // for PUBLIC communities — banned means no access, not "view as stranger".
    assertNotBanned(membership);
    // Only an ACTIVE membership confers a role; LEFT members are treated as
    // non-members (myRole = null).
    const myRole =
      membership && membership.status === CommunityMemberStatus.ACTIVE
        ? membership.role
        : null;

    // Fetch mute row and (for non-members only) any existing join request in
    // parallel. Members can't have a pending join request, so skip that query.
    const [muteRow, joinRequest] = await Promise.all([
      communityRepository.findMuteByUserAndCommunity(callerId, id),
      myRole === null
        ? communityRepository.findJoinRequestByCommunityAndUser(id, callerId)
        : Promise.resolve(null),
    ]);

    return toCommunityData(community, myRole, muteRow, joinRequest);
  },

  async create(
    creatorId: string,
    input: CreateCommunityInput
  ): Promise<CommunityData> {
    const name = normalizeName(input.name);
    const handle = normalizeHandle(input.handle);

    // Category must exist and be active.
    const category = await communityRepository.findActiveCategoryById(
      input.categoryId
    );
    if (!category) {
      throw new BadRequestError("COMMUNITY_CATEGORY_INVALID");
    }

    // Validate the optional avatar key (ownership + HEAD) before any write.
    const avatarUrl = input.avatarObjectKey
      ? await communityImageService.resolveObjectKeyForCommunity(
          creatorId,
          input.avatarObjectKey
        )
      : null;

    // Self-exclude (creator is added as ADMIN below).
    const requestedMemberIds = input.memberIds.filter((id) => id !== creatorId);

    // Server-side friend validation: silently drop any candidate the creator is
    // not ACCEPTED friends with. On user-service failure, fetchAcceptedFriendIds
    // returns an empty set so nothing extra is added — community is still created
    // with just the creator. Decision B3: no override.
    const friendSet =
      requestedMemberIds.length > 0
        ? await fetchAcceptedFriendIds(creatorId, requestedMemberIds)
        : new Set<string>();
    const memberIds = requestedMemberIds.filter((id) => friendSet.has(id));

    // NO $transaction: local Mongo is a standalone node (no replica set), so
    // Prisma interactive transactions fail at runtime. Use sequential writes +
    // createMany, with best-effort compensating cleanup if a later step fails.
    let community: CommunityWithCategory;
    try {
      community = await communityRepository.createCommunity({
        name,
        handle,
        description: input.description ?? null,
        type: input.type as CommunityType,
        categoryId: input.categoryId,
        // Denormalize the category name for the admin list's DB-level sort.
        categoryName: category.name,
        creatorId,
        adminId: creatorId,
        avatarUrl,
        coverUrl: null,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw uniqueViolationToConflict(error);
      }
      throw error;
    }

    try {
      const allMemberIds = [creatorId, ...memberIds];
      const snapshotMap = await fetchUserSnapshots(allMemberIds);
      const creatorSnap = snapshotMap.get(creatorId)!;

      await communityRepository.createMember({
        communityId: community.id,
        userId: creatorId,
        role: CommunityMemberRole.ADMIN,
        status: CommunityMemberStatus.ACTIVE,
        snapshotUsername: creatorSnap.username,
        snapshotDisplayName: creatorSnap.displayName,
        snapshotAvatarKey: creatorSnap.avatarObjectKey,
      });

      let insertedMembers = 0;
      if (memberIds.length > 0) {
        const memberObjects = memberIds.map((userId) => {
          const snap = snapshotMap.get(userId)!;
          return {
            userId,
            role: CommunityMemberRole.MEMBER,
            status: CommunityMemberStatus.ACTIVE,
            snapshotUsername: snap.username,
            snapshotDisplayName: snap.displayName,
            snapshotAvatarKey: snap.avatarObjectKey,
          };
        });
        const result = await communityRepository.createManyMembers(
          community.id,
          memberObjects
        );
        insertedMembers = result.count;
      }

      const memberCount = 1 + insertedMembers;
      if (memberCount !== community.memberCount) {
        await communityRepository.setMemberCount(community.id, memberCount);
        community.memberCount = memberCount;
      }
    } catch (error) {
      // Compensating cleanup — roll back the partial create by hand.
      await this.cleanupFailedCreate(community.id);
      throw error;
    }

    await communityCache.invalidateNameAvailability(name);
    await communityCache.invalidateHandleAvailability(handle);

    // Provision the community's chat room in chat-service (GeneralRoom id ===
    // community.id) so community chat works and drives lastActivityAt ordering.
    // Synchronous first: guarantees the room exists before this returns, so a
    // member's first message can't race ahead of room creation. The async event
    // below stays as a backstop for the rare case chat-service is briefly
    // unavailable (provisionForCommunity is an idempotent upsert).
    try {
      await getChatClient().ensureCommunityRoom({
        communityId: community.id,
        name: community.name,
        ownerId: creatorId,
        avatarUrl: community.avatarUrl ?? null,
      });
    } catch (err) {
      logger.warn(
        `ensureCommunityRoom failed for community ${community.id}; relying on async community.created backstop: ${String(err)}`
      );
    }
    publishCommunityCreatedForChatSafe({
      communityId: community.id,
      name: community.name,
      avatarUrl: community.avatarUrl ?? null,
      communityType: community.type,
      ownerId: creatorId,
    });
    publishCommunitySystemMessageForChatSafe({
      communityId: community.id,
      systemMessageType: "COMMUNITY_CREATED",
      metadata: {
        communityName: community.name,
        actorUserId: creatorId,
        actorName: "",
      },
      triggeredByUserId: creatorId,
      eventAt: new Date().toISOString(),
    });

    // A brand-new community has no mute row for the creator.
    const communityData = await toCommunityData(
      community,
      CommunityMemberRole.ADMIN,
      null
    );

    // Notify the creator via /chat socket so their community list updates
    // immediately without a page reload or extra API call.
    void publishChatUserEvent(
      redis,
      creatorId,
      "community:created",
      communityData
    ).catch((err: unknown) => {
      logger.warn(
        `community:created socket publish failed for ${community.id}: ${String(err)}`
      );
    });

    return communityData;
  },

  /** Best-effort rollback of a community whose member writes failed. */
  async cleanupFailedCreate(communityId: string): Promise<void> {
    try {
      await communityRepository.deleteMembersForCommunity(communityId);
      await communityRepository.deleteCommunityHard(communityId);
    } catch (cleanupError) {
      logger.error(
        `Failed to clean up partial community ${communityId} after create error`
      );
      logger.error(cleanupError);
    }
  },

  /**
   * Append a moderation audit entry. Fire-safe: an audit-write failure is logged
   * but never propagated, so it can never fail the moderation action itself.
   */
  async recordAudit(entry: {
    communityId: string;
    actorId: string;
    action: CommunityAuditAction;
    targetUserId?: string;
    reason?: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<void> {
    try {
      await communityRepository.createAuditLog(entry);
    } catch (auditError) {
      logger.error(
        `Failed to record audit log: community=${entry.communityId} action=${entry.action} actor=${entry.actorId}`
      );
      logger.error(auditError);
    }
  },

  async update(
    communityId: string,
    callerId: string,
    input: UpdateCommunityInput
  ): Promise<CommunityData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.ADMIN);
    assertCommunityNotSuspended(community);

    const data: Prisma.CommunityUpdateInput = {};
    let nextName: string | undefined;
    let nextHandle: string | undefined;
    const previousName = community.name;
    const previousHandle = community.handle;

    if (input.name !== undefined) {
      nextName = normalizeName(input.name);
      const { available } = await this.checkNameAvailability(
        nextName,
        communityId
      );
      if (!available) {
        throw new ConflictError("COMMUNITY_NAME_TAKEN");
      }
      data.name = nextName;
    }

    if (input.handle !== undefined) {
      nextHandle = normalizeHandle(input.handle);
      const { available } = await this.checkHandleAvailability(
        nextHandle,
        communityId
      );
      if (!available) {
        throw new ConflictError("COMMUNITY_HANDLE_TAKEN");
      }
      data.handle = nextHandle;
    }

    if (input.type !== undefined) {
      data.type = input.type as CommunityType;
    }

    if (input.categoryId !== undefined) {
      const category = await communityRepository.findActiveCategoryById(
        input.categoryId
      );
      if (!category) {
        throw new BadRequestError("COMMUNITY_CATEGORY_INVALID");
      }
      data.category = { connect: { id: input.categoryId } };
      // Keep the denormalized category name (admin-list sort key) in sync.
      data.categoryName = category.name;
    }

    if (input.description !== undefined) {
      data.description = input.description;
    }

    if (input.avatarObjectKey !== undefined) {
      data.avatarUrl =
        input.avatarObjectKey === null
          ? null
          : await communityImageService.resolveObjectKeyForCommunity(
              callerId,
              input.avatarObjectKey
            );
    }

    // Detect which fields ACTUALLY changed (genuine value diff, not merely
    // present in the payload) so a single real edit posts its specific system
    // line instead of the generic "Community details updated". See
    // detectCommunityChangedFields.
    const changedFields = detectCommunityChangedFields(
      {
        name: community.name,
        description: community.description,
        avatarUrl: community.avatarUrl,
        type: community.type,
        categoryId: community.categoryId,
        handle: community.handle,
      },
      {
        name: nextName,
        description: input.description,
        avatarProvided: input.avatarObjectKey !== undefined,
        nextAvatarUrl: (data.avatarUrl as string | null | undefined) ?? null,
        type: input.type,
        categoryId: input.categoryId,
        handle: nextHandle,
      }
    );

    let updated: CommunityWithCategory;
    try {
      updated = await communityRepository.updateCommunity(communityId, data);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw uniqueViolationToConflict(error);
      }
      throw error;
    }

    if (nextName && nextName !== previousName) {
      await communityCache.invalidateNameAvailability(previousName);
      await communityCache.invalidateNameAvailability(nextName);
    }
    if (nextHandle && nextHandle !== previousHandle) {
      await communityCache.invalidateHandleAvailability(previousHandle);
      await communityCache.invalidateHandleAvailability(nextHandle);
    }

    // Telegram-style system line, exactly ONE per update:
    //  - a SINGLE field change → its dedicated, specific subtype where one exists
    //    (name / description / avatar / banner), else the generic COMMUNITY_UPDATED;
    //  - MULTIPLE simultaneous fields → one collapsed COMMUNITY_UPDATED
    //    ("Community details updated").
    // This replaces the previous "emit one line per name/avatar/other group"
    // behaviour, which could post up to three separate lines for one save and
    // rendered description/banner edits as the generic "Community info" line.
    const systemMessageType =
      selectCommunityUpdateSystemMessageType(changedFields);
    if (systemMessageType) {
      publishCommunitySystemMessageForChatSafe({
        communityId,
        systemMessageType,
        metadata: {
          actorUserId: callerId,
          actorName: "",
          changedFields,
          ...(systemMessageType === "COMMUNITY_NAME_UPDATED"
            ? { newName: nextName }
            : {}),
          ...(input.type !== undefined ? { newVisibility: input.type } : {}),
        },
        triggeredByUserId: callerId,
        eventAt: new Date().toISOString(),
      });
    }
    // Visibility changed (PUBLIC↔PRIVATE): re-sync the cached community type in
    // chat-service so the read-access guard immediately reflects the new policy
    // (a now-PRIVATE community stops leaking history to non-members, and vice versa).
    if (changedFields.includes("visibility") && input.type !== undefined) {
      publishCommunityVisibilityChangedForChatSafe({
        communityId,
        communityType: input.type,
      });
    }

    if (input.memberIds !== undefined) {
      const desiredSet = new Set(input.memberIds);
      const currentIds =
        await communityRepository.findActiveMemberIds(communityId);
      const currentSet = new Set(currentIds);

      const toAdd = input.memberIds.filter((id) => !currentSet.has(id));
      const toRemove = currentIds.filter((id) => !desiredSet.has(id));

      if (toAdd.length > 0) {
        await this.addMembers(communityId, callerId, toAdd);
      }

      for (const targetUserId of toRemove) {
        try {
          await this.kickMember(communityId, callerId, targetUserId);
        } catch (err) {
          // Skip members who are no longer ACTIVE (already left/banned/never joined).
          if (err instanceof NotFoundError) continue;
          throw err;
        }
      }
    }

    // Admin who just patched the community isn't asking about mute — skip read.
    return toCommunityData(updated, membership.role, null);
  },

  async listMine(
    userId: string,
    params: { direction: "before" | "after"; ts: Date; limit: number }
  ): Promise<PaginatedResponse<CommunityListItem>> {
    // Over-fetch one extra row so hasMore is exact.
    const { rows, total } = await communityRepository.listMineByActivity({
      userId,
      direction: params.direction,
      ts: params.ts,
      limit: params.limit + 1,
    });

    const hasMore = rows.length > params.limit;
    const pageRows = rows.slice(0, params.limit);

    const communityIds = pageRows.map((row) => row.id);

    // Resolve the last-activity sender name from the LIVE member snapshot — the
    // same fresh source the chat room renders — overriding the denormalized
    // `lastActivityUsername`, which is frozen at message-send time and goes
    // stale after a rename (the cause of "<old name>: 📷 Photo" lingering on the
    // list while the chat shows the new name). Only user-message activities
    // carry a sender; system lines render sender-less in buildLastActivity.
    const senderIds = pageRows
      .map((row) => row.lastActivityUserId)
      .filter((id): id is string => Boolean(id));

    // Bulk-fetch chat enrichment, mute settings, and live sender names in parallel.
    const [chatMap, muteMap, senderNameMap] = await Promise.all([
      fetchChatEnrichment(userId, communityIds),
      loadMuteMap(userId, communityIds),
      communityRepository.getDisplayNamesByUserIds(senderIds),
    ]);

    const communities: CommunityListItem[] = await Promise.all(
      pageRows.map(async (row) => {
        const avatarView = await communityImageService.resolveViewUrlForClient(
          row.avatarUrl
        );
        const avatar = await buildCommunityImageMedia(row.avatarUrl);
        const chat = chatMap.get(row.id) ?? EMPTY_CHAT_ENRICHMENT;
        return {
          id: row.id,
          name: row.name,
          handle: row.handle,
          type: row.type,
          memberCount: row.memberCount,
          memberLimit: COMMUNITY_MEMBER_LIMIT,
          avatarUrl: avatarView?.url ?? null,
          avatarUrlExpiresIn: avatarView?.expiresIn ?? null,
          avatar,
          role: row.members[0]?.role ?? CommunityMemberRole.MEMBER,
          isJoined: true,
          lastActivityAt: row.lastActivityAt.getTime(),
          unreadMessageCount: chat.unreadMessageCount,
          lastActivity: buildLastActivity({
            ...row,
            // Prefer the live member-snapshot name; fall back to the stored value
            // when the sender has since left every community.
            lastActivityUsername:
              (row.lastActivityUserId
                ? senderNameMap.get(row.lastActivityUserId)
                : null) ?? row.lastActivityUsername,
            // Self-referential SYSTEM line (role change / join): the viewer who IS
            // the subject sees the first-person "You …" preview; everyone else
            // keeps the third-person text.
            lastActivityPreview: selectListPreview(row, userId),
          }),
          ...muteFields(muteMap.get(row.id) ?? null),
          // Phase 1 stub — wire to stream-service gRPC in Phase 2.
          isLive: false,
          moderationStatus: row.moderationStatus,
        };
      })
    );

    // Inclusive boundary (as specified) → consecutive pages can share the
    // boundary community; clients de-duplicate by id. nextCursor is epoch-ms to
    // feed straight back as before_ts/after_ts.
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow ? String(lastRow.lastActivityAt.getTime()) : null;

    return {
      pagination: {
        totalData: total,
        totalPage: Math.ceil(total / params.limit) || 1,
        currentPage: 1,
        limit: params.limit,
        nextCursor,
        hasMore,
      },
      data: communities,
    };
  },

  /**
   * Public discovery / browse / search. Two membership strategies:
   *   - default (discover alias): PUBLIC communities the caller is not already
   *     in (active/pending/banned excluded).
   *   - `includeJoined` (/communities/mine search mode): PUBLIC communities PLUS
   *     any community the caller is an ACTIVE member of (so PRIVATE communities
   *     they belong to surface), without excluding joined communities.
   * The "live"/"upcoming" filters depend on livestream data (stream-service),
   * which does not exist yet, so they return an empty page rather than
   * misleading results.
   */
  async discover(
    userId: string,
    params: {
      q?: string;
      categoryId?: string;
      filter: "all" | "live" | "upcoming";
      page: number;
      limit: number;
      includeJoined?: boolean;
      includeChatActivity?: boolean;
    }
  ): Promise<PaginatedResponse<CommunityDiscoverItem>> {
    if (params.filter !== "all") {
      // Livestream-based discovery is not available until stream-service ships.
      return buildPaginatedResponse([], 0, params.page, params.limit);
    }

    // Visibility strategy differs by caller: search mode (`includeJoined`) widens
    // to PUBLIC + the caller's ACTIVE memberships; the discover alias narrows to
    // PUBLIC and excludes communities the caller already relates to.
    const [includeMemberCommunityIds, excludeCommunityIds] =
      params.includeJoined
        ? [
            await communityRepository.listActiveMemberCommunityIds(userId),
            undefined,
          ]
        : [
            undefined,
            await communityRepository.listExcludedCommunityIds(userId),
          ];

    const { rows, total } = await communityRepository.listDiscoverable({
      q: params.q,
      categoryId: params.categoryId,
      includeMemberCommunityIds,
      excludeCommunityIds,
      page: params.page,
      limit: params.limit,
    });

    const communityIds = rows.map((row) => row.id);

    // Batch-load mute rows and pending join requests in parallel — one query each.
    const [muteByCommunityId, pendingRequestSet] = await Promise.all([
      loadMuteMap(userId, communityIds),
      communityRepository.findPendingRequestedCommunityIds(
        userId,
        communityIds
      ),
    ]);

    // Build a fast lookup for membership: used by the mine-search alias
    // (includeJoined=true). Public discover always has isJoined=false.
    const memberSet = includeMemberCommunityIds
      ? new Set(includeMemberCommunityIds)
      : new Set<string>();

    const communities: CommunityDiscoverItem[] = await Promise.all(
      rows.map((row) =>
        toDiscoverItem(
          row,
          muteByCommunityId.get(row.id) ?? null,
          memberSet.has(row.id),
          pendingRequestSet.has(row.id),
          userId
        )
      )
    );

    // /communities/mine search mode: enrich with community-chat activity. Non-
    // member rows naturally resolve to 0 unread + null preview (member-only
    // previews enforced in chat-service). The public /discover alias passes
    // includeChatActivity=false and the fields stay absent (contract unchanged).
    if (params.includeChatActivity && communities.length > 0) {
      const chatMap = await fetchChatEnrichment(
        userId,
        communities.map((c) => c.id)
      );
      for (const item of communities) {
        const chat = chatMap.get(item.id) ?? EMPTY_CHAT_ENRICHMENT;
        item.unreadMessageCount = chat.unreadMessageCount;
      }
    }

    return buildPaginatedResponse(
      communities,
      total,
      params.page,
      params.limit
    );
  },

  async listMembers(
    communityId: string,
    callerId: string,
    params: { page: number; limit: number; status?: CommunityMemberStatus }
  ): Promise<PaginatedResponse<CommunityMemberData>> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // PUBLIC communities: roster is visible to any caller. PRIVATE
    // communities remain member-only (moderator/member) as before.
    if (community.type === CommunityType.PRIVATE) {
      const membership = await communityRepository.findMembership(
        communityId,
        callerId
      );
      assertCommunityRole(membership, CommunityMemberRole.MEMBER);
    }

    const status = params.status ?? CommunityMemberStatus.ACTIVE;
    const { rows, total } = await communityRepository.listMembers({
      communityId,
      status,
      page: params.page,
      limit: params.limit,
    });

    const members: CommunityMemberData[] = await Promise.all(
      rows.map(toMemberData)
    );

    return buildPaginatedResponse(members, total, params.page, params.limit);
  },

  async updateMemberRole(
    communityId: string,
    callerId: string,
    targetUserId: string,
    role: CommunityMemberRole
  ): Promise<CommunityMemberData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Only an ACTIVE admin may change member roles.
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.ADMIN);

    if (callerId === targetUserId) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_SELF");
    }

    const target = await communityRepository.findMemberByUserId(
      communityId,
      targetUserId
    );
    if (!target || target.status !== CommunityMemberStatus.ACTIVE) {
      throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
    }

    // The community admin's role is immutable here.
    if (
      community.adminId === targetUserId ||
      target.role === CommunityMemberRole.ADMIN
    ) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN");
    }

    // Idempotent: setting the role it already has is a no-op.
    if (target.role === role) {
      return toMemberData(target);
    }

    // Single-document update — no $transaction (standalone Mongo).
    const updated = await communityRepository.updateMemberRole(
      communityId,
      targetUserId,
      role
    );

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action:
        role === CommunityMemberRole.MODERATOR
          ? "MEMBER_PROMOTED"
          : "MEMBER_DEMOTED",
      targetUserId,
      metadata: { role },
    });

    publishCommunityMemberRoleChangedSafe({
      communityId,
      eventAt: new Date().toISOString(),
      actorId: callerId,
      targetUserId,
      oldRole: target.role,
      newRole: role,
    });
    const roleChangedAt = new Date().toISOString();
    publishCommunitySystemMessageForChatSafe({
      communityId,
      systemMessageType: "ROLE_CHANGED",
      metadata: {
        actorUserId: callerId,
        actorName: "",
        targetUserId,
        targetName: "",
        oldRole: target.role as string,
        newRole: role as string,
      },
      triggeredByUserId: callerId,
      eventAt: roleChangedAt,
    });
    // Personal counterpart: the target sees "You are now a moderator/member"
    // while everyone else sees the community-wide line with their real name.
    publishCommunitySystemMessageForChatSafe({
      communityId,
      systemMessageType: "ROLE_CHANGED_SELF",
      metadata: {
        oldRole: target.role as string,
        newRole: role as string,
      },
      triggeredByUserId: targetUserId,
      eventAt: roleChangedAt,
      visibleToUserId: targetUserId,
    });

    return toMemberData(updated);
  },

  /**
   * Shared MODERATOR+ guard for member-targeted moderation actions (kick, mute,
   * warn). Performs the identical six-step gate those actions share and returns
   * the loaded `community`, `target` member row, and `callerMembership` so the
   * caller reuses them without re-querying:
   *   1. community exists (404 COMMUNITY_NOT_FOUND)
   *   2. caller is an ACTIVE MODERATOR+ (assertCommunityRole)
   *   3. caller !== target (400 COMMUNITY_MEMBER_CANNOT_MODIFY_SELF)
   *   4. target exists and is ACTIVE (404 COMMUNITY_MEMBER_NOT_FOUND)
   *   5. target is not the admin / an ADMIN (400 COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN)
   *   6. caller strictly outranks target (403 COMMUNITY_FORBIDDEN)
   *
   * NOTE: intentionally NOT used by ban/unban — ban requires ADMIN, allows
   * non-ACTIVE targets, and skips the strict-rank rule.
   */
  async _assertCanModerateMember(
    communityId: string,
    callerId: string,
    targetUserId: string
  ): Promise<{
    community: NonNullable<
      Awaited<ReturnType<typeof communityRepository.findById>>
    >;
    target: NonNullable<
      Awaited<ReturnType<typeof communityRepository.findMemberByUserId>>
    >;
    callerMembership: NonNullable<
      Awaited<ReturnType<typeof communityRepository.findMembership>>
    >;
  }> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // A MODERATOR or ADMIN may perform the action.
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.MODERATOR);

    if (callerId === targetUserId) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_SELF");
    }

    const target = await communityRepository.findMemberByUserId(
      communityId,
      targetUserId
    );
    if (!target || target.status !== CommunityMemberStatus.ACTIVE) {
      throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
    }

    // The community admin / an ADMIN can never be the target.
    if (
      community.adminId === targetUserId ||
      target.role === CommunityMemberRole.ADMIN
    ) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN");
    }

    // Strict rank rule: the caller must outrank the target, so a MODERATOR
    // cannot act on a peer MODERATOR (only ADMIN can).
    if (
      COMMUNITY_ROLE_RANK[callerMembership.role] <=
      COMMUNITY_ROLE_RANK[target.role]
    ) {
      throw new ForbiddenError("COMMUNITY_FORBIDDEN");
    }

    return { community, target, callerMembership };
  },

  async kickMember(
    communityId: string,
    callerId: string,
    targetUserId: string,
    reason?: string
  ): Promise<CommunityMemberData> {
    await this._assertCanModerateMember(communityId, callerId, targetUserId);

    // Single-document update + recompute of memberCount — no $transaction
    // (standalone Mongo). Recounting ACTIVE members is robust against drift.
    const updated = await communityRepository.updateMemberStatus(
      communityId,
      targetUserId,
      CommunityMemberStatus.LEFT
    );

    const count = await communityRepository.countActiveMembers(communityId);
    await communityRepository.setMemberCount(communityId, count);

    void communityRepository
      .updateLastActivity(
        communityId,
        new Date(),
        "removal",
        `${updated.snapshotUsername} was removed from the community`,
        updated.snapshotUsername,
        targetUserId
      )
      .catch((err) =>
        logger.warn(
          `updateLastActivity failed for community=${communityId}: ${String(err)}`
        )
      );

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "MEMBER_KICKED",
      targetUserId,
      reason,
    });

    // `reason` is operator-supplied, not PII.
    logger.info(
      `Community member kicked: community=${communityId} by=${callerId} target=${targetUserId} reason=${reason ?? "(none)"}`
    );

    publishCommunityMemberKickedSafe({
      communityId,
      eventAt: new Date().toISOString(),
      actorId: callerId,
      targetUserId,
      reason: reason ?? null,
    });

    try {
      const now = Date.now();
      await Promise.all([
        publishCommunityRoomEvent(
          redis,
          communityId,
          "community:member:removed",
          {
            communityId,
            userId: targetUserId,
            reason: "kicked",
            actorId: callerId,
            updatedAt: now,
          } satisfies CommunityMemberRemovedPayload
        ),
        publishCommunityRoomEvent(
          redis,
          communityId,
          "community:stats:updated",
          {
            communityId,
            memberCount: count,
            updatedAt: now,
          } satisfies CommunityStatsUpdatedPayload
        ),
      ]);
    } catch (err) {
      logger.warn(
        `community realtime broadcast failed kick community=${communityId}: ${String(err)}`
      );
    }

    this.emitMemberSystemMessage({
      communityId,
      systemMessageType: "MEMBER_REMOVED",
      actorId: callerId,
      targetUserId,
    });

    return toMemberData(updated);
  },

  async banMember(
    communityId: string,
    callerId: string,
    targetUserId: string,
    reason?: string
  ): Promise<CommunityMemberData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Only an ACTIVE admin may ban members.
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.ADMIN);

    if (callerId === targetUserId) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_SELF");
    }

    const target = await communityRepository.findMemberByUserId(
      communityId,
      targetUserId
    );
    if (!target) {
      throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
    }

    // The community admin can never be banned.
    if (
      community.adminId === targetUserId ||
      target.role === CommunityMemberRole.ADMIN
    ) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN");
    }

    // Idempotent: an already-banned member is returned unchanged (no write).
    if (target.status === CommunityMemberStatus.BANNED) {
      return toMemberData(target);
    }

    // Single-document update + recompute of memberCount — no $transaction
    // (standalone Mongo). Recounting ACTIVE members is robust against drift.
    const updated = await communityRepository.updateMemberStatus(
      communityId,
      targetUserId,
      CommunityMemberStatus.BANNED,
      {
        bannedAt: new Date(),
        bannedBy: callerId,
        banReason: reason ?? null,
      }
    );

    const count = await communityRepository.countActiveMembers(communityId);
    await communityRepository.setMemberCount(communityId, count);

    void communityRepository
      .updateLastActivity(
        communityId,
        new Date(),
        "removal",
        `${updated.snapshotUsername} was removed from the community`,
        updated.snapshotUsername,
        targetUserId
      )
      .catch((err) =>
        logger.warn(
          `updateLastActivity failed for community=${communityId}: ${String(err)}`
        )
      );

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "MEMBER_BANNED",
      targetUserId,
      reason,
    });

    // `reason` is operator-supplied, not PII.
    logger.info(
      `Community member banned: community=${communityId} by=${callerId} target=${targetUserId} reason=${reason ?? "(none)"}`
    );

    publishCommunityMemberBannedSafe({
      communityId,
      eventAt: new Date().toISOString(),
      actorId: callerId,
      targetUserId,
      reason: reason ?? null,
    });

    try {
      const now = Date.now();
      await Promise.all([
        publishCommunityRoomEvent(
          redis,
          communityId,
          "community:member:removed",
          {
            communityId,
            userId: targetUserId,
            reason: "banned",
            actorId: callerId,
            updatedAt: now,
          } satisfies CommunityMemberRemovedPayload
        ),
        publishCommunityRoomEvent(
          redis,
          communityId,
          "community:stats:updated",
          {
            communityId,
            memberCount: count,
            updatedAt: now,
          } satisfies CommunityStatsUpdatedPayload
        ),
      ]);
    } catch (err) {
      logger.warn(
        `community realtime broadcast failed ban community=${communityId}: ${String(err)}`
      );
    }

    this.emitMemberSystemMessage({
      communityId,
      systemMessageType: "MEMBER_BANNED",
      actorId: callerId,
      targetUserId,
    });

    return toMemberData(updated);
  },

  /**
   * Emit a community-wide SYSTEM message for a member-moderation lifecycle event
   * (joined/left/removed/banned/unbanned/muted/unmuted, role change). Thin
   * wrapper over the chat-sync publisher so every moderation method stays a
   * one-liner. Visibility + template + list-bump are decided downstream by the
   * central registry in @aimess/constants — callers never pass them. Best-effort.
   */
  emitMemberSystemMessage(args: {
    communityId: string;
    systemMessageType: string;
    actorId: string;
    targetUserId?: string;
    extra?: Record<string, unknown>;
  }): void {
    publishCommunitySystemMessageForChatSafe({
      communityId: args.communityId,
      systemMessageType: args.systemMessageType,
      metadata: {
        ...(args.targetUserId ? { targetUserId: args.targetUserId } : {}),
        ...(args.extra ?? {}),
      },
      triggeredByUserId: args.actorId,
      eventAt: new Date().toISOString(),
    });
  },

  /**
   * Internal helper (not part of the public API surface — `communityService` is
   * an object literal, so this is a plain method, not a class `private`). Call it
   * from every path that turns a member ACTIVE so the side-effects stay DRY:
   *   1. emit the enriched `community.member_added` domain event (adds
   *      requestId + communityName + moderatorRecipientIds so the notifications
   *      consumer can welcome the joiner AND inform admins/mods), and
   *   2. broadcast a `community:member:joined` roster event into the community
   *      room (best-effort; never throws into the request path).
   */
  async notifyMemberJoined(args: {
    community: { id: string; name: string };
    member: {
      userId: string;
      role: CommunityMemberRole;
      joinedAt: Date;
      snapshotUsername: string;
      snapshotDisplayName: string;
      snapshotAvatarKey: string | null;
    };
    memberCount: number;
    actorId: string;
    via: CommunityMemberAddedPayload["via"];
    requestId?: string;
    /**
     * Optional pre-resolved ADMIN/MODERATOR roster. Bulk callers (addMembers,
     * bulkApproveJoinRequests) hoist it once and pass it in to avoid an N+1 of
     * identical roster reads — one per member. Single-member callers omit it and
     * fall back to the lazy internal resolution below.
     */
    moderatorRecipientIds?: string[];
  }): Promise<void> {
    const { community, member, memberCount, actorId, via, requestId } = args;

    const moderatorRecipientIds =
      args.moderatorRecipientIds ??
      (await communityRepository.findActiveMemberIdsByRoles(community.id, [
        CommunityMemberRole.ADMIN,
        CommunityMemberRole.MODERATOR,
      ]));

    publishCommunityMemberAddedSafe({
      communityId: community.id,
      eventAt: new Date().toISOString(),
      actorId,
      targetUserId: member.userId,
      via,
      requestId,
      communityName: community.name,
      moderatorRecipientIds,
    });

    // Roster broadcast — client-facing socket DTO (joinedAt is epoch ms here,
    // matching the reserved AsyncAPI CommunityMemberDTO). Reuse the avatar
    // key→URL resolver the REST member list uses; never hand-roll presigning.
    try {
      const avatarView = await memberAvatarService.resolveViewUrl(
        member.snapshotAvatarKey
      );
      const memberDto = {
        userId: member.userId,
        username: member.snapshotUsername,
        displayName: member.snapshotDisplayName,
        avatarUrl: avatarView?.url ?? null,
        role: member.role,
        joinedAt: member.joinedAt.getTime(),
      };
      await publishCommunityRoomEvent(
        redis,
        community.id,
        "community:member:joined",
        memberDto
      );
      await publishCommunityRoomEvent(
        redis,
        community.id,
        "community:stats:updated",
        {
          communityId: community.id,
          memberCount,
          updatedAt: Date.now(),
        } satisfies CommunityStatsUpdatedPayload
      );
    } catch (error) {
      logger.warn(
        `community:member:joined broadcast failed for community=${community.id} user=${member.userId}`
      );
      logger.warn(error);
    }
  },

  async addMembers(
    communityId: string,
    callerId: string,
    userIds: string[]
  ): Promise<AddMembersResult> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // A MODERATOR or ADMIN may add members.
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.MODERATOR);
    assertCommunityNotSuspended(community);

    // Server-side friend validation BEFORE existing-row partitioning. Any
    // candidate not an ACCEPTED friend of the caller is skipped as NOT_FRIEND.
    // On user-service failure, fetchAcceptedFriendIds returns an empty set so
    // all candidates are skipped — conservative by design (Decision B8).
    // const friendSet = await fetchAcceptedFriendIds(callerId, userIds);

    // One read of all existing rows for the requested ids (incl. joinedAt),
    // then partition by status: ACTIVE → skip, BANNED → skip, LEFT →
    // reactivate, none → create.
    const existing = await communityRepository.findMembersByUserIds(
      communityId,
      userIds
    );
    const existingByUserId = new Map(
      existing.map((member) => [member.userId, member])
    );

    const skipped: AddMembersResult["skipped"] = [];
    // Reactivated members keep their existing row (incl. joinedAt) in hand, so
    // we can build their DTO without a re-read after the bulk update.
    const toReactivate: { userId: string; joinedAt: Date }[] = [];
    const toCreate: string[] = [];

    for (const userId of userIds) {
      // Caller is always ACTIVE in a community where they hold MODERATOR rank,
      // but the friend-check would otherwise mark them NOT_FRIEND (a user is
      // not their own friend). Classify them as ALREADY_MEMBER first.
      if (userId === callerId) {
        skipped.push({ userId, reason: "ALREADY_MEMBER" });
        continue;
      }
      // Friend check runs before existing-row classification — do NOT
      // re-classify NOT_FRIEND ids as ALREADY_MEMBER / BANNED / reactivate.
      // if (!friendSet.has(userId)) {
      //   skipped.push({ userId, reason: "NOT_FRIEND" });
      //   continue;
      // }
      const member = existingByUserId.get(userId);
      if (!member) {
        toCreate.push(userId);
      } else if (member.status === CommunityMemberStatus.ACTIVE) {
        skipped.push({ userId, reason: "ALREADY_MEMBER" });
      } else if (member.status === CommunityMemberStatus.BANNED) {
        skipped.push({ userId, reason: "BANNED" });
      } else {
        // LEFT (or any other inactive non-banned state) → reactivate.
        toReactivate.push({ userId, joinedAt: member.joinedAt });
      }
    }

    // Sequential single-collection writes — no $transaction (standalone Mongo).
    let added: CommunityMemberData[] = [];

    if (toReactivate.length > 0 || toCreate.length > 0) {
      const snapshotIds = [...toReactivate.map((m) => m.userId), ...toCreate];
      const snapshotMap = await fetchUserSnapshots(snapshotIds);

      if (toReactivate.length > 0) {
        for (const m of toReactivate) {
          const snap = snapshotMap.get(m.userId)!;
          await communityRepository.reactivateMemberWithSnapshot(
            communityId,
            m.userId,
            {
              snapshotUsername: snap.username,
              snapshotDisplayName: snap.displayName,
              snapshotAvatarKey: snap.avatarObjectKey,
            }
          );
        }
      }

      if (toCreate.length > 0) {
        const memberObjects = toCreate.map((userId) => {
          const snap = snapshotMap.get(userId)!;
          return {
            userId,
            role: CommunityMemberRole.MEMBER,
            status: CommunityMemberStatus.ACTIVE,
            snapshotUsername: snap.username,
            snapshotDisplayName: snap.displayName,
            snapshotAvatarKey: snap.avatarObjectKey,
          };
        });
        await communityRepository.createManyMembers(communityId, memberObjects);
      }

      const count = await communityRepository.countActiveMembers(communityId);
      await communityRepository.setMemberCount(communityId, count);

      const allAdded = [...toReactivate.map((m) => m.userId), ...toCreate];
      const lastAddedSnap =
        allAdded.length > 0
          ? snapshotMap.get(allAdded[allAdded.length - 1])
          : undefined;
      if (lastAddedSnap) {
        void communityRepository
          .updateLastActivity(
            communityId,
            new Date(),
            "join",
            `${lastAddedSnap.username} joined the community`,
            lastAddedSnap.username,
            allAdded[allAdded.length - 1] ?? null,
            SELF_JOIN_ACTIVITY_PREVIEW
          )
          .catch((err) =>
            logger.warn(
              `updateLastActivity failed for community=${communityId}: ${String(err)}`
            )
          );
      }

      const reactivated: CommunityMemberData[] = await Promise.all(
        toReactivate.map((m) => {
          const snap = snapshotMap.get(m.userId)!;
          return toMemberData({
            userId: m.userId,
            role: CommunityMemberRole.MEMBER,
            status: CommunityMemberStatus.ACTIVE,
            joinedAt: m.joinedAt,
            snapshotUsername: snap.username,
            snapshotDisplayName: snap.displayName,
            snapshotAvatarKey: snap.avatarObjectKey,
          });
        })
      );

      let created: CommunityMemberData[] = [];
      // Raw created rows (with real joinedAt/role) kept for the per-member
      // join notification below.
      let createdRows: Awaited<
        ReturnType<typeof communityRepository.findMembersByUserIds>
      > = [];
      if (toCreate.length > 0) {
        createdRows = await communityRepository.findMembersByUserIds(
          communityId,
          toCreate
        );
        created = await Promise.all(createdRows.map(toMemberData));
      }

      added = [...reactivated, ...created];

      // Resolve the ADMIN/MODERATOR roster ONCE for the whole batch and pass it
      // into every notifyMemberJoined call below — the roster is identical for
      // each added member, so hoisting it kills the per-member N+1 roster read.
      const moderatorRecipientIds =
        await communityRepository.findActiveMemberIdsByRoles(communityId, [
          CommunityMemberRole.ADMIN,
          CommunityMemberRole.MODERATOR,
        ]);

      // Notify once per added user (skipped[] are NOT emitted): enriched
      // member_added (moderator awareness) + community room roster broadcast.
      for (const m of toReactivate) {
        const snap = snapshotMap.get(m.userId)!;
        await this.notifyMemberJoined({
          community,
          member: {
            userId: m.userId,
            role: CommunityMemberRole.MEMBER,
            joinedAt: m.joinedAt,
            snapshotUsername: snap.username,
            snapshotDisplayName: snap.displayName,
            snapshotAvatarKey: snap.avatarObjectKey,
          },
          memberCount: count,
          actorId: callerId,
          via: "add_members",
          moderatorRecipientIds,
        });
      }
      for (const row of createdRows) {
        await this.notifyMemberJoined({
          community,
          member: row,
          memberCount: count,
          actorId: callerId,
          via: "add_members",
          moderatorRecipientIds,
        });
      }
    }

    return { added, skipped };
  },

  async leaveCommunity(
    communityId: string,
    callerId: string,
    reasonInput?: { reason: string | null; reasonText: string | null }
  ): Promise<CommunityMemberData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMemberByUserId(
      communityId,
      callerId
    );
    if (!membership || membership.status !== CommunityMemberStatus.ACTIVE) {
      throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
    }

    // Capture leave-reason metadata once — recorded in MEMBER_LEFT audit in
    // every branch (admin handover / auto-delete / non-admin).
    const leaveReason = reasonInput?.reason ?? null;
    const leaveReasonText = reasonInput?.reasonText ?? null;
    const leaveMeta = { reason: leaveReason, reasonText: leaveReasonText };

    const isAdmin =
      community.adminId === callerId ||
      membership.role === CommunityMemberRole.ADMIN;

    if (isAdmin) {
      if (community.memberCount === 1) {
        // Admin is the only member → delete the community (members first, then
        // community in a transaction). No audit needed since the community
        // ceases to exist; member rows are removed by the transaction.
        await communityRepository.deleteCommunityHard(communityId);
        logger.info(
          `Community deleted as last member left: community=${communityId} by=${callerId}`
        );
        // Member row is gone — synthesise the return value from the snapshot
        // fetched before deletion.
        return toMemberData({
          ...membership,
          status: CommunityMemberStatus.LEFT,
        });
      }

      throw new BadRequestError("ADMIN_CANNOT_LEAVE_COMMUNITY");
    }

    // Non-admin leave: status → LEFT + recompute. Single-document update +
    // recompute of memberCount — no $transaction.
    const updated = await communityRepository.updateMemberStatus(
      communityId,
      callerId,
      CommunityMemberStatus.LEFT
    );

    const count = await communityRepository.countActiveMembers(communityId);
    await communityRepository.setMemberCount(communityId, count);

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "MEMBER_LEFT",
      targetUserId: callerId,
      metadata: leaveMeta,
    });

    publishCommunityMemberLeftSafe({
      communityId,
      actorId: callerId,
      reason: leaveReason,
      eventAt: new Date().toISOString(),
    });

    try {
      const now = Date.now();
      await Promise.all([
        publishCommunityRoomEvent(
          redis,
          communityId,
          "community:member:removed",
          {
            communityId,
            userId: callerId,
            reason: "left",
            actorId: callerId,
            updatedAt: now,
          } satisfies CommunityMemberRemovedPayload
        ),
        publishCommunityRoomEvent(
          redis,
          communityId,
          "community:stats:updated",
          {
            communityId,
            memberCount: count,
            updatedAt: now,
          } satisfies CommunityStatsUpdatedPayload
        ),
      ]);
    } catch (err) {
      logger.warn(
        `community realtime broadcast failed leave community=${communityId}: ${String(err)}`
      );
    }

    this.emitMemberSystemMessage({
      communityId,
      systemMessageType: "MEMBER_LEFT",
      actorId: callerId,
      targetUserId: callerId,
    });

    return toMemberData(updated);
  },

  /**
   * Leave multiple communities in one call. Each communityId is processed
   * independently — failures do not abort the rest.
   *
   * Rules (mirroring single leaveCommunity):
   *  - Not an active member → FAILED / NOT_MEMBER
   *  - Community not found  → FAILED / NOT_FOUND
   *  - Admin, sole member   → community auto-deleted, status DELETED
   *  - Admin, others exist  → FAILED / ADMIN_CANNOT_LEAVE
   *  - Non-admin            → LEFT; memberCount recomputed; MEMBER_LEFT audit + event
   */
  async bulkLeaveCommunities(
    callerId: string,
    communityIds: string[]
  ): Promise<{
    results: Array<{
      communityId: string;
      status: "LEFT" | "DELETED" | "FAILED";
      errorCode?: "ADMIN_CANNOT_LEAVE" | "NOT_MEMBER" | "NOT_FOUND";
    }>;
    summary: { requested: number; left: number; failed: number };
  }> {
    // 1. Batch-fetch: active memberships + community rows (for existence check
    //    and adminId/memberCount on admin-owned communities).
    const [memberships, communities] = await Promise.all([
      communityRepository.findActiveMembershipsWithRoleByCommunityIds(
        callerId,
        communityIds
      ),
      communityRepository.findCommunitiesByIds(communityIds),
    ]);

    const membershipMap = new Map(memberships.map((m) => [m.communityId, m]));
    const communityMap = new Map(communities.map((c) => [c.id, c]));

    const results: Array<{
      communityId: string;
      status: "LEFT" | "DELETED" | "FAILED";
      errorCode?: "ADMIN_CANNOT_LEAVE" | "NOT_MEMBER" | "NOT_FOUND";
    }> = [];
    let leftCount = 0;
    let failedCount = 0;
    const eventAt = new Date().toISOString();

    for (const communityId of communityIds) {
      if (!communityMap.has(communityId)) {
        results.push({ communityId, status: "FAILED", errorCode: "NOT_FOUND" });
        failedCount++;
        continue;
      }

      const membership = membershipMap.get(communityId);
      if (!membership || membership.status !== CommunityMemberStatus.ACTIVE) {
        results.push({
          communityId,
          status: "FAILED",
          errorCode: "NOT_MEMBER",
        });
        failedCount++;
        continue;
      }

      const isAdmin = membership.role === CommunityMemberRole.ADMIN;

      if (isAdmin) {
        const community = communityMap.get(communityId)!;
        if (community.memberCount === 1) {
          // Admin is the only member — auto-delete the community.
          await communityRepository.deleteCommunityHard(communityId);
          logger.info(
            `Community auto-deleted (last member left via bulk): community=${communityId} by=${callerId}`
          );
          results.push({ communityId, status: "DELETED" });
          leftCount++;
          continue;
        }

        // Admin with other members present — block.
        results.push({
          communityId,
          status: "FAILED",
          errorCode: "ADMIN_CANNOT_LEAVE",
        });
        failedCount++;
        continue;
      }

      // Non-admin: mark LEFT, recompute memberCount, audit, publish.
      await communityRepository.updateMemberStatus(
        communityId,
        callerId,
        CommunityMemberStatus.LEFT
      );
      const count = await communityRepository.countActiveMembers(communityId);
      await communityRepository.setMemberCount(communityId, count);

      await this.recordAudit({
        communityId,
        actorId: callerId,
        action: "MEMBER_LEFT",
        targetUserId: callerId,
      });

      publishCommunityMemberLeftSafe({
        communityId,
        actorId: callerId,
        reason: null,
        eventAt,
      });

      try {
        const now = Date.now();
        await Promise.all([
          publishCommunityRoomEvent(
            redis,
            communityId,
            "community:member:removed",
            {
              communityId,
              userId: callerId,
              reason: "left",
              actorId: callerId,
              updatedAt: now,
            } satisfies CommunityMemberRemovedPayload
          ),
          publishCommunityRoomEvent(
            redis,
            communityId,
            "community:stats:updated",
            {
              communityId,
              memberCount: count,
              updatedAt: now,
            } satisfies CommunityStatsUpdatedPayload
          ),
        ]);
      } catch (err) {
        logger.warn(
          `community realtime broadcast failed bulk-leave community=${communityId}: ${String(err)}`
        );
      }

      results.push({ communityId, status: "LEFT" });
      leftCount++;
    }

    return {
      results,
      summary: {
        requested: communityIds.length,
        left: leftCount,
        failed: failedCount,
      },
    };
  },

  async unbanMember(
    communityId: string,
    callerId: string,
    targetUserId: string
  ): Promise<CommunityMemberData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Only an ACTIVE admin may unban members.
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.ADMIN);

    const target = await communityRepository.findMemberByUserId(
      communityId,
      targetUserId
    );
    if (!target) {
      throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
    }

    if (target.status !== CommunityMemberStatus.BANNED) {
      throw new BadRequestError("COMMUNITY_MEMBER_NOT_BANNED");
    }

    // Unban lifts the ban to LEFT — the user is not auto-re-added; an admin or
    // moderator must add them back (or they re-join) to become ACTIVE again.
    // Single-document update + recompute of memberCount — no $transaction.
    const updated = await communityRepository.updateMemberStatus(
      communityId,
      targetUserId,
      CommunityMemberStatus.LEFT,
      { bannedAt: null, bannedBy: null, banReason: null }
    );

    const count = await communityRepository.countActiveMembers(communityId);
    await communityRepository.setMemberCount(communityId, count);

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "MEMBER_UNBANNED",
      targetUserId,
    });

    // Cross-service event → notifications-service pushes/in-apps the unbanned
    // user ("Ban lifted"). Mirrors the MEMBER_BANNED publish on ban.
    publishCommunityMemberUnbannedSafe({
      communityId,
      eventAt: new Date().toISOString(),
      actorId: callerId,
      targetUserId,
    });

    // Unban: BANNED→LEFT. Count is unchanged (BANNED was already excluded from
    // ACTIVE). Emit only the membership-state event, not stats.
    try {
      await publishCommunityRoomEvent(
        redis,
        communityId,
        "community:member:unbanned",
        {
          communityId,
          userId: targetUserId,
          actorId: callerId,
          updatedAt: Date.now(),
        } satisfies CommunityMemberUnbannedPayload
      );
    } catch (err) {
      logger.warn(
        `community:member:unbanned broadcast failed community=${communityId}: ${String(err)}`
      );
    }

    this.emitMemberSystemMessage({
      communityId,
      systemMessageType: "MEMBER_UNBANNED",
      actorId: callerId,
      targetUserId,
    });

    return toMemberData(updated);
  },

  // ---------------------------------------------------------------------------
  // Member moderation mute (moderator-applied — distinct from notification mute)
  // ---------------------------------------------------------------------------
  async muteMember(
    communityId: string,
    callerId: string,
    targetUserId: string,
    durationMinutes: number | null | undefined,
    reason?: string
  ): Promise<CommunityMutedMemberData> {
    const { target } = await this._assertCanModerateMember(
      communityId,
      callerId,
      targetUserId
    );

    // null / undefined → indefinite; positive number → now + N minutes.
    const mutedUntil =
      durationMinutes == null
        ? null
        : new Date(Date.now() + durationMinutes * 60_000);

    const row = await communityRepository.upsertMemberMute({
      communityId,
      userId: targetUserId,
      mutedBy: callerId,
      reason: reason ?? null,
      mutedUntil,
    });

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "MEMBER_MUTED",
      targetUserId,
      reason,
      metadata: {
        reason: reason ?? null,
        mutedUntil: mutedUntil?.toISOString() ?? null,
      },
    });

    logger.info(
      `Community member muted: community=${communityId} by=${callerId} target=${targetUserId} until=${mutedUntil?.toISOString() ?? "(indefinite)"}`
    );

    publishCommunityMemberMutedSafe({
      communityId,
      eventAt: new Date().toISOString(),
      actorId: callerId,
      targetUserId,
      reason: reason ?? null,
      mutedUntil: mutedUntil?.toISOString() ?? null,
    });

    this.emitMemberSystemMessage({
      communityId,
      systemMessageType: "MEMBER_MUTED",
      actorId: callerId,
      targetUserId,
    });

    const view = await buildUserSnapshotView(
      {
        username: target.snapshotUsername,
        displayName: target.snapshotDisplayName,
        avatarObjectKey: target.snapshotAvatarKey,
      },
      targetUserId
    );

    return {
      userId: view.userId,
      snapshotUsername: view.username,
      snapshotDisplayName: view.displayName,
      snapshotAvatarUrl: view.avatarUrl,
      snapshotAvatarUrlExpiresIn: view.avatarUrlExpiresIn,
      snapshotAvatar: view.avatar,
      mutedBy: row.mutedBy,
      reason: row.reason,
      mutedAt: row.createdAt.toISOString(),
      mutedUntil: row.mutedUntil ? row.mutedUntil.toISOString() : null,
    };
  },

  async unmuteMember(
    communityId: string,
    callerId: string,
    targetUserId: string
  ): Promise<void> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.MODERATOR);

    const existing = await communityRepository.findMemberMute(
      communityId,
      targetUserId
    );
    // No active mute → 404 (a fully-expired row is treated as not muted).
    if (
      !existing ||
      (existing.mutedUntil && existing.mutedUntil.getTime() <= Date.now())
    ) {
      throw new NotFoundError("COMMUNITY_MEMBER_NOT_MUTED");
    }

    await communityRepository.deleteMemberMute(communityId, targetUserId);

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "MEMBER_UNMUTED",
      targetUserId,
    });

    logger.info(
      `Community member unmuted: community=${communityId} by=${callerId} target=${targetUserId}`
    );

    publishCommunityMemberUnmutedSafe({
      communityId,
      eventAt: new Date().toISOString(),
      actorId: callerId,
      targetUserId,
    });

    this.emitMemberSystemMessage({
      communityId,
      systemMessageType: "MEMBER_UNMUTED",
      actorId: callerId,
      targetUserId,
    });
  },

  async listMutedMembers(
    communityId: string,
    callerId: string,
    params: { page: number; limit: number }
  ): Promise<PaginatedResponse<CommunityMutedMemberData>> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const { rows, total } = await communityRepository.listMutedMembers({
      communityId,
      now: new Date(),
      page: params.page,
      limit: params.limit,
    });

    const items: CommunityMutedMemberData[] = [];
    if (rows.length > 0) {
      const userIds = rows.map((r) => r.userId);
      const members = await communityRepository.findMembersByUserIds(
        communityId,
        userIds
      );
      const memberMap = new Map(members.map((m) => [m.userId, m]));

      for (const row of rows) {
        const member = memberMap.get(row.userId);
        const avatarView = await memberAvatarService.resolveViewUrl(
          member?.snapshotAvatarKey ?? null
        );
        const avatar = await buildAvatarMedia(
          member?.snapshotAvatarKey ?? null
        );
        items.push({
          userId: row.userId,
          snapshotUsername: member?.snapshotUsername ?? "",
          snapshotDisplayName: member?.snapshotDisplayName ?? "",
          snapshotAvatarUrl: avatarView?.url ?? null,
          snapshotAvatarUrlExpiresIn: avatarView?.expiresIn ?? null,
          snapshotAvatar: avatar,
          mutedBy: row.mutedBy,
          reason: row.reason,
          mutedAt: row.createdAt.toISOString(),
          mutedUntil: row.mutedUntil ? row.mutedUntil.toISOString() : null,
        });
      }
    }

    return buildPaginatedResponse(items, total, params.page, params.limit);
  },

  // ---------------------------------------------------------------------------
  // Banned-members list (dedicated moderation view — MODERATOR+)
  // ---------------------------------------------------------------------------
  /**
   * Currently-banned members of a community, with search + sort. Visible to
   * MODERATOR+ (admins have full access; moderators may view per RBAC). Members
   * have no access. Only status === BANNED rows are returned — lifted bans are
   * available through the moderation audit trail, not here.
   */
  async listBannedMembers(
    communityId: string,
    callerId: string,
    params: {
      page: number;
      limit: number;
      search?: string;
      sortBy: "bannedAt" | "displayName" | "username";
      sortOrder: "asc" | "desc";
    }
  ): Promise<PaginatedResponse<CommunityBannedMemberData>> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const { rows, total } = await communityRepository.listBannedMembers({
      communityId,
      search: params.search,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
      page: params.page,
      limit: params.limit,
    });

    const items: CommunityBannedMemberData[] = [];
    if (rows.length > 0) {
      // Resolve banner display names from their own (still-present) member
      // snapshots in one batched read — no N+1 per banned row.
      const bannerIds = [
        ...new Set(
          rows.map((r) => r.bannedBy).filter((id): id is string => Boolean(id))
        ),
      ];
      const bannerMap = new Map<string, string>();
      if (bannerIds.length > 0) {
        const banners = await communityRepository.findMembersByUserIds(
          communityId,
          bannerIds
        );
        for (const b of banners) {
          bannerMap.set(b.userId, b.snapshotDisplayName);
        }
      }

      for (const row of rows) {
        const avatarView = await memberAvatarService.resolveViewUrl(
          row.snapshotAvatarKey
        );
        const avatar = await buildAvatarMedia(row.snapshotAvatarKey);
        items.push({
          userId: row.userId,
          username: row.snapshotUsername,
          displayName: row.snapshotDisplayName,
          avatarUrl: avatarView?.url ?? null,
          avatarUrlExpiresIn: avatarView?.expiresIn ?? null,
          avatar,
          bannedAt: row.bannedAt ? row.bannedAt.getTime() : null,
          bannedBy: row.bannedBy
            ? {
                userId: row.bannedBy,
                displayName: bannerMap.get(row.bannedBy) ?? null,
              }
            : null,
          banReason: row.banReason,
          banType: "PERMANENT",
        });
      }
    }

    return buildPaginatedResponse(items, total, params.page, params.limit);
  },

  // ---------------------------------------------------------------------------
  // Member warnings
  // ---------------------------------------------------------------------------
  async warnMember(
    communityId: string,
    callerId: string,
    targetUserId: string,
    note: string
  ): Promise<CommunityMemberWarningData> {
    await this._assertCanModerateMember(communityId, callerId, targetUserId);

    const row = await communityRepository.createMemberWarning({
      communityId,
      userId: targetUserId,
      warnedBy: callerId,
      note,
    });

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "MEMBER_WARNED",
      targetUserId,
      metadata: { note },
    });

    logger.info(
      `Community member warned: community=${communityId} by=${callerId} target=${targetUserId}`
    );

    publishCommunityMemberWarnedSafe({
      communityId,
      eventAt: new Date().toISOString(),
      actorId: callerId,
      targetUserId,
      note,
    });

    return {
      warningId: row.id,
      userId: row.userId,
      warnedBy: row.warnedBy,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    };
  },

  async listMemberWarnings(
    communityId: string,
    callerId: string,
    targetUserId: string,
    params: { page: number; limit: number }
  ): Promise<PaginatedResponse<CommunityMemberWarningData>> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const { rows, total } = await communityRepository.listMemberWarnings({
      communityId,
      userId: targetUserId,
      page: params.page,
      limit: params.limit,
    });

    const items: CommunityMemberWarningData[] = rows.map((row) => ({
      warningId: row.id,
      userId: row.userId,
      warnedBy: row.warnedBy,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    }));

    return buildPaginatedResponse(items, total, params.page, params.limit);
  },

  // ---------------------------------------------------------------------------
  // Liked / Favorited communities
  // ---------------------------------------------------------------------------
  async likeCommunity(
    communityId: string,
    callerId: string
  ): Promise<CommunityFavoriteData> {
    const community = await communityRepository.findById(communityId);
    if (!community) throw new NotFoundError("COMMUNITY_NOT_FOUND");
    assertCommunityNotSuspended(community);

    const row = await communityRepository.likeCommunity(callerId, communityId);
    return {
      favoriteId: row.id,
      communityId: row.communityId,
      createdAt: row.createdAt.toISOString(),
    };
  },

  async unlikeCommunity(communityId: string, callerId: string): Promise<void> {
    const community = await communityRepository.findById(communityId);
    if (!community) throw new NotFoundError("COMMUNITY_NOT_FOUND");

    await communityRepository.unlikeCommunity(callerId, communityId);
  },

  async listFavoriteCommunities(
    callerId: string,
    params: { cursor?: string | null; limit: number }
  ): Promise<{
    items: (CommunityDiscoverItem & { likedAt: string })[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const {
      rows: favRows,
      hasMore,
      nextCursor,
    } = await communityRepository.listFavorites({
      userId: callerId,
      cursor: params.cursor,
      limit: params.limit,
    });

    if (favRows.length === 0) {
      return { items: [], hasMore: false, nextCursor: null };
    }

    const communityIds = favRows.map((r) => r.communityId);
    const likedAtByCommunityId = new Map(
      favRows.map((r) => [r.communityId, r.createdAt.toISOString()])
    );

    const [communities, muteMap] = await Promise.all([
      communityRepository.findManyByIds(communityIds),
      loadMuteMap(callerId, communityIds),
    ]);

    // Resolve membership in bulk via findMemberships if available, else serial.
    const membershipRows = await Promise.all(
      communityIds.map((cid) =>
        communityRepository
          .findMembership(cid, callerId)
          .then((m) => ({ cid, role: m?.role ?? null }))
      )
    );
    const membershipMap = new Map(membershipRows.map((r) => [r.cid, r.role]));

    const items = await Promise.all(
      favRows
        .map((fav) => communities.find((c) => c.id === fav.communityId))
        .filter(
          (c): c is NonNullable<typeof c> => c != null && c.deletedAt == null
        )
        .map(async (community) => {
          const isJoined =
            membershipMap.get(community.id) !== null &&
            membershipMap.get(community.id) !== undefined;
          const base = await toDiscoverItem(
            community,
            muteMap.get(community.id) ?? null,
            isJoined,
            false,
            callerId
          );
          return { ...base, likedAt: likedAtByCommunityId.get(community.id)! };
        })
    );

    return { items, hasMore, nextCursor };
  },

  async joinCommunity(
    communityId: string,
    callerId: string
  ): Promise<CommunityJoinResult> {
    // STEP 1: Load community (findById already excludes soft-deleted rows).
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // STEP 2: Guard suspended.
    assertCommunityNotSuspended(community);

    // STEP 3: Load existing membership row (any status).
    const existingMember = await communityRepository.findMemberByUserId(
      communityId,
      callerId
    );

    // STEP 4: Banned → immediate rejection.
    if (existingMember?.status === CommunityMemberStatus.BANNED) {
      throw new ForbiddenError("COMMUNITY_JOIN_BANNED");
    }

    // -------------------------------------------------------------------------
    // PUBLIC BRANCH — instant ACTIVE membership
    // -------------------------------------------------------------------------
    if (community.type === CommunityType.PUBLIC) {
      // STEP 5a: Already an active member → idempotent 200.
      if (existingMember?.status === CommunityMemberStatus.ACTIVE) {
        return {
          status: "ALREADY_MEMBER",
          membershipStatus: "ACTIVE",
          member: await toMemberData(existingMember),
        };
      }

      // STEP 5b: Fetch user snapshot via gRPC (same pattern as addMembers /
      // approveJoinRequest). Falls back to empty strings on service failure.
      const snapshotMap = await fetchUserSnapshots([callerId]);
      const snap = snapshotMap.get(callerId);
      const snapshotData = {
        snapshotUsername: snap?.username ?? "",
        snapshotDisplayName: snap?.displayName ?? "",
        snapshotAvatarKey: snap?.avatarObjectKey ?? null,
      };

      // STEP 5c: Reactivate LEFT row or create a fresh ACTIVE row.
      let newRow;
      const reactivated = existingMember?.status === CommunityMemberStatus.LEFT;
      if (reactivated) {
        newRow = await communityRepository.reactivateMemberWithSnapshot(
          communityId,
          callerId,
          snapshotData
        );
      } else {
        newRow = await communityRepository.createMember({
          communityId,
          userId: callerId,
          role: CommunityMemberRole.MEMBER,
          status: CommunityMemberStatus.ACTIVE,
          ...snapshotData,
        });
      }

      // STEP 5d: Refresh member count.
      const count = await communityRepository.countActiveMembers(communityId);
      await communityRepository.setMemberCount(communityId, count);

      // STEP 5e: Best-effort last-activity update.
      void communityRepository
        .updateLastActivity(
          communityId,
          new Date(),
          "join",
          `${newRow.snapshotUsername} joined the community`,
          newRow.snapshotUsername,
          callerId,
          SELF_JOIN_ACTIVITY_PREVIEW
        )
        .catch((err) =>
          logger.warn(
            `updateLastActivity failed for community=${communityId}: ${String(err)}`
          )
        );

      // STEP 5f: Emit community:member:joined + community:stats:updated socket
      // events + publish community.member_added (for mod notification).
      // Fire-and-forget: the member row is already committed — do not fail the
      // HTTP request if the roster lookup or socket publish fails.
      void this.notifyMemberJoined({
        community,
        member: newRow,
        memberCount: count,
        actorId: callerId,
        via: "self_join",
      }).catch((err) =>
        logger.warn(
          `notifyMemberJoined failed for community=${communityId}: ${String(err)}`
        )
      );

      // STEP 5g: Publish community.member_joined (self-join dedicated event).
      const communityAvatarMedia = await buildCommunityImageMedia(
        community.avatarUrl
      );
      publishCommunityMemberJoinedSafe({
        communityId,
        userId: callerId,
        communityName: community.name,
        communityHandle: community.handle,
        communityAvatarUrl: communityAvatarMedia.downloadUrl,
        reactivated,
        eventAt: new Date().toISOString(),
      });

      // STEP 5h: Audit.
      await this.recordAudit({
        communityId,
        actorId: callerId,
        action: "COMMUNITY_JOINED",
        targetUserId: callerId,
        metadata: { reactivated },
      });

      // STEP 5h2: Personal "You joined the community" to the joiner only.
      // No community-wide join announcement — only the joiner sees it.
      publishCommunitySystemMessageForChatSafe({
        communityId,
        systemMessageType: "COMMUNITY_JOINED",
        metadata: {},
        triggeredByUserId: callerId,
        eventAt: new Date().toISOString(),
        visibleToUserId: callerId,
      });

      logger.info(
        `Community self-join (PUBLIC): community=${communityId} user=${callerId} reactivated=${reactivated}`
      );

      // STEP 5i: Return.
      return {
        status: "JOINED",
        membershipStatus: "ACTIVE",
        member: await toMemberData(newRow),
      };
    }

    // -------------------------------------------------------------------------
    // PRIVATE BRANCH — create PENDING join request
    // -------------------------------------------------------------------------

    // STEP 6a: Already an active member → idempotent 200. This must stay here
    // (createJoinRequest throws ConflictError on an ACTIVE member); short-
    // circuiting first preserves the idempotent self-join contract.
    if (existingMember?.status === CommunityMemberStatus.ACTIVE) {
      return {
        status: "ALREADY_MEMBER",
        membershipStatus: "ACTIVE",
        member: await toMemberData(existingMember),
      };
    }

    // STEP 6b: Delegate to createJoinRequest — the single source of truth for
    // the create / recycle / idempotent-PENDING logic plus moderator
    // notification. Its NotFound / suspended / BANNED / ACTIVE guards are all
    // pre-empted above (STEPs 1, 2, 4 and 6a), so they can never fire first.
    const request = await this.createJoinRequest(communityId, callerId, null);

    return {
      status: "REQUEST_CREATED",
      membershipStatus: "PENDING",
      request,
    };
  },

  async transferAdmin(
    communityId: string,
    callerId: string,
    targetUserId: string
  ): Promise<CommunityData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Only an ACTIVE admin may transfer the admin role.
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.ADMIN);

    if (callerId === targetUserId) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_SELF");
    }

    const target = await communityRepository.findMemberByUserId(
      communityId,
      targetUserId
    );
    if (!target || target.status !== CommunityMemberStatus.ACTIVE) {
      throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
    }

    // Defensive: target should never already be ADMIN here (only one admin
    // exists), but guard against a drift between adminId and member.role.
    if (target.role === CommunityMemberRole.ADMIN) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN");
    }

    // No $transaction (standalone Mongo). ORDER MATTERS so the community
    // always has a valid admin:
    // 1) promote target → ADMIN, 2) transfer ownership, 3) demote caller →
    // MEMBER (caller stays ACTIVE — Telegram-style hand-off).
    await communityRepository.updateMemberRole(
      communityId,
      targetUserId,
      CommunityMemberRole.ADMIN
    );
    await communityRepository.setCommunityAdmin(communityId, targetUserId);
    await communityRepository.updateMemberRole(
      communityId,
      callerId,
      CommunityMemberRole.MEMBER
    );

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "ADMIN_TRANSFERRED",
      targetUserId,
      metadata: { reason: "explicit_transfer" },
    });

    logger.info(
      `Community admin explicit-transfer: community=${communityId} from=${callerId} to=${targetUserId}`
    );

    publishCommunityAdminTransferredSafe({
      communityId,
      eventAt: new Date().toISOString(),
      actorId: callerId,
      targetUserId,
      reason: "explicit_transfer",
    });

    const refreshed = await communityRepository.findById(communityId);
    if (!refreshed) {
      // Should not happen — soft-delete cannot race an admin-only operation.
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }
    // Caller is now a plain MEMBER in the refreshed community.
    return toCommunityData(refreshed, CommunityMemberRole.MEMBER, null);
  },

  async deleteCommunity(communityId: string, callerId: string): Promise<void> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Only an ACTIVE admin may delete (Telegram/Discord-style — works even
    // when other ACTIVE members are present).
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.ADMIN);

    // Capture the active roster BEFORE eviction so the DELETED event can
    // notify everyone who was a member at delete time.
    const memberIds =
      await communityRepository.findActiveMemberIds(communityId);

    // No $transaction (standalone Mongo). ORDER MATTERS: soft-delete first so
    // any concurrent reader gets COMMUNITY_NOT_FOUND while we evict members.
    await communityRepository.updateCommunity(communityId, {
      deletedAt: new Date(),
    });
    await communityRepository.markAllActiveMembersLeft(communityId);
    await communityRepository.setMemberCount(communityId, 0);

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "COMMUNITY_DELETED",
      metadata: { reason: "explicit_delete" },
    });

    await communityCache.invalidateNameAvailability(community.name);
    await communityCache.invalidateHandleAvailability(community.handle);

    logger.info(`Community deleted: community=${communityId} by=${callerId}`);

    publishCommunityDeletedSafe({
      communityId,
      eventAt: new Date().toISOString(),
      actorId: callerId,
      reason: "explicit_delete",
      memberIds,
    });
    publishCommunityDeletedForChatSafe(communityId);
  },

  async listAuditLogs(
    communityId: string,
    callerId: string,
    params: { page: number; limit: number }
  ): Promise<PaginatedResponse<CommunityAuditLogData>> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Admins and moderators may view the moderation audit trail.
    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const { rows, total } = await communityRepository.listAuditLogs({
      communityId,
      page: params.page,
      limit: params.limit,
    });

    const logs: CommunityAuditLogData[] = rows.map(toAuditLogData);

    return buildPaginatedResponse(logs, total, params.page, params.limit);
  },

  // ---------------------------------------------------------------------------
  // Join requests
  // ---------------------------------------------------------------------------
  async createJoinRequest(
    communityId: string,
    callerId: string,
    message: string | null
  ): Promise<CommunityJoinRequestData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    assertCommunityNotSuspended(community);

    // Join requests are allowed for both PUBLIC and PRIVATE communities.
    // PUBLIC: user-initiated joins create a PENDING request for moderators
    // to approve. PRIVATE: users may not self-join but may still create an
    // explicit request via UI (or the server may accept moderator-created
    // add-members/invites). Keep the existing mutual-want auto-accept logic
    // below.

    const existingMember = await communityRepository.findMemberByUserId(
      communityId,
      callerId
    );
    if (existingMember?.status === CommunityMemberStatus.ACTIVE) {
      throw new ConflictError("COMMUNITY_ALREADY_MEMBER");
    }
    if (existingMember?.status === CommunityMemberStatus.BANNED) {
      throw new ForbiddenError("COMMUNITY_JOIN_BANNED");
    }

    // No auto-accept paths: always create a join request for moderators to
    // review. (Mutual-want auto-accept removed per policy.)

    const existingRequest =
      await communityRepository.findJoinRequestByCommunityAndUser(
        communityId,
        callerId
      );

    let row: CommunityJoinRequest;
    // Gate the JOIN_REQUESTED publish so the idempotent "same PENDING return"
    // does NOT emit (would spam if a client retries). Fresh create + recycled
    // request both count as "new" for downstream consumers.
    let isNewOrRecycled = false;
    if (!existingRequest) {
      row = await communityRepository.createJoinRequest({
        communityId,
        userId: callerId,
        message,
      });
      isNewOrRecycled = true;
    } else if (existingRequest.status === CommunityJoinReqStatus.PENDING) {
      row = existingRequest;
    } else {
      row = await communityRepository.recyclePendingJoinRequest(
        existingRequest.id,
        message
      );
      isNewOrRecycled = true;
    }

    logger.info(
      `Community join-request created: community=${communityId} user=${callerId} request=${row.id} status=${row.status}`
    );

    if (isNewOrRecycled) {
      const moderatorRecipientIds =
        await communityRepository.findActiveMemberIdsByRoles(communityId, [
          CommunityMemberRole.ADMIN,
          CommunityMemberRole.MODERATOR,
        ]);
      const [requesterSnaps, communityAvatarMedia] = await Promise.all([
        fetchUserSnapshots([callerId]),
        buildCommunityImageMedia(community.avatarUrl),
      ]);
      const requesterSnap = requesterSnaps.get(callerId);
      const requesterAvatarMedia = await buildAvatarMedia(
        requesterSnap?.avatarObjectKey ?? null
      );
      publishCommunityJoinRequestedSafe({
        communityId,
        communityName: community.name,
        communityHandle: community.handle,
        communityAvatarUrl: communityAvatarMedia.downloadUrl,
        eventAt: new Date().toISOString(),
        userId: callerId,
        requestId: row.id,
        message,
        moderatorRecipientIds,
        requesterDisplayName: requesterSnap?.displayName ?? "Unknown",
        requesterAvatarUrl: requesterAvatarMedia.downloadUrl,
      });
    }

    return toJoinRequestData(row);
  },

  async listCommunityJoinRequests(
    communityId: string,
    callerId: string,
    params: {
      page: number;
      limit: number;
      status?: CommunityJoinReqStatus;
    }
  ): Promise<PaginatedResponse<CommunityJoinRequestWithUserData>> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const status = params.status ?? CommunityJoinReqStatus.PENDING;
    const { rows, total } = await communityRepository.listCommunityJoinRequests(
      {
        communityId,
        status,
        page: params.page,
        limit: params.limit,
      }
    );

    const items: CommunityJoinRequestWithUserData[] = [];
    if (rows.length > 0) {
      const snapshotMap = await fetchUserSnapshots(rows.map((r) => r.userId));
      for (const row of rows) {
        const snap = snapshotMap.get(row.userId)!;
        const user = await buildUserSnapshotView(snap, row.userId);
        items.push({ ...toJoinRequestData(row), user });
      }
    }

    return buildPaginatedResponse(items, total, params.page, params.limit);
  },

  async listMyJoinRequests(
    callerId: string,
    params: {
      page: number;
      limit: number;
      status?: CommunityJoinReqStatus;
    }
  ): Promise<PaginatedResponse<MyJoinRequestData>> {
    const { rows, total } = await communityRepository.listMyJoinRequests({
      userId: callerId,
      status: params.status,
      page: params.page,
      limit: params.limit,
    });

    const items: MyJoinRequestData[] = [];
    if (rows.length > 0) {
      const communityIds = [...new Set(rows.map((r) => r.communityId))];
      const communities =
        await communityRepository.findCommunitiesByIds(communityIds);
      const communityMap = new Map(communities.map((c) => [c.id, c]));

      for (const row of rows) {
        const community = communityMap.get(row.communityId);
        if (!community) continue; // soft-deleted; best-effort filter
        items.push({
          ...toJoinRequestData(row),
          community: await toEmbeddedCommunitySummary(community),
        });
      }
    }

    return buildPaginatedResponse(items, total, params.page, params.limit);
  },

  async approveJoinRequest(
    communityId: string,
    callerId: string,
    requestId: string
  ): Promise<{
    request: CommunityJoinRequestData;
    member: CommunityMemberData;
  }> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.MODERATOR);
    assertCommunityNotSuspended(community);

    const request = await communityRepository.findJoinRequestById(requestId);
    if (!request || request.communityId !== communityId) {
      throw new NotFoundError("COMMUNITY_JOIN_REQUEST_NOT_FOUND");
    }

    // Idempotent: already-APPROVED requests return the existing member row.
    if (request.status === CommunityJoinReqStatus.APPROVED) {
      const existing = await communityRepository.findMemberByUserId(
        communityId,
        request.userId
      );
      if (existing) {
        return {
          request: toJoinRequestData(request),
          member: await toMemberData(existing),
        };
      }
      logger.warn(
        `approveJoinRequest: APPROVED request ${requestId} has no member row; re-writing`
      );
    } else if (request.status !== CommunityJoinReqStatus.PENDING) {
      throw new BadRequestError("COMMUNITY_JOIN_REQUEST_NOT_PENDING");
    }

    // A12 race: re-read member state.
    const targetMember = await communityRepository.findMemberByUserId(
      communityId,
      request.userId
    );
    if (targetMember?.status === CommunityMemberStatus.ACTIVE) {
      // Already a member — mark request APPROVED + return idempotently.
      const updated = await communityRepository.updateJoinRequest(requestId, {
        status: CommunityJoinReqStatus.APPROVED,
        decidedBy: callerId,
        decidedAt: new Date(),
      });
      return {
        request: toJoinRequestData(updated),
        member: await toMemberData(targetMember),
      };
    }
    if (targetMember?.status === CommunityMemberStatus.BANNED) {
      // Defensive: close the request out as REJECTED before throwing.
      try {
        await communityRepository.updateJoinRequest(requestId, {
          status: CommunityJoinReqStatus.REJECTED,
          decidedBy: callerId,
          decidedAt: new Date(),
        });
      } catch (closeErr) {
        logger.error(
          `Failed to close BANNED-race join-request ${requestId} during approve`
        );
        logger.error(closeErr);
      }
      throw new ForbiddenError("COMMUNITY_JOIN_BANNED");
    }

    const snapshotMap = await fetchUserSnapshots([request.userId]);
    const snap = snapshotMap.get(request.userId)!;

    if (targetMember?.status === CommunityMemberStatus.LEFT) {
      await communityRepository.reactivateMemberWithSnapshot(
        communityId,
        request.userId,
        {
          snapshotUsername: snap.username,
          snapshotDisplayName: snap.displayName,
          snapshotAvatarKey: snap.avatarObjectKey,
        }
      );
    } else {
      await communityRepository.createMember({
        communityId,
        userId: request.userId,
        role: CommunityMemberRole.MEMBER,
        status: CommunityMemberStatus.ACTIVE,
        snapshotUsername: snap.username,
        snapshotDisplayName: snap.displayName,
        snapshotAvatarKey: snap.avatarObjectKey,
      });
    }

    const count = await communityRepository.countActiveMembers(communityId);
    await communityRepository.setMemberCount(communityId, count);

    void communityRepository
      .updateLastActivity(
        communityId,
        new Date(),
        "join",
        `${snap.username} joined the community`,
        snap.username,
        request.userId,
        SELF_JOIN_ACTIVITY_PREVIEW
      )
      .catch((err) =>
        logger.warn(
          `updateLastActivity failed for community=${communityId}: ${String(err)}`
        )
      );

    const updatedRequest = await communityRepository.updateJoinRequest(
      requestId,
      {
        status: CommunityJoinReqStatus.APPROVED,
        decidedBy: callerId,
        decidedAt: new Date(),
      }
    );

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "JOIN_REQUEST_APPROVED",
      targetUserId: request.userId,
      metadata: { requestId },
    });

    logger.info(
      `Community join-request approved: community=${communityId} request=${requestId} approver=${callerId} target=${request.userId}`
    );

    const row = await communityRepository.findMemberByUserId(
      communityId,
      request.userId
    );

    // Enriched member_added (moderator awareness) + roster broadcast.
    await this.notifyMemberJoined({
      community,
      member: row!,
      memberCount: count,
      actorId: callerId,
      via: "join_request_approved",
      requestId: request.id,
    });

    // Dedicated approved event → notifies the requester (in-app/push) and drives
    // the realtime join-request UI-state update.
    const [callerSnapsApprove, communityAvatarMediaApprove] = await Promise.all(
      [
        fetchUserSnapshots([callerId]),
        buildCommunityImageMedia(community.avatarUrl),
      ]
    );
    const callerSnapApprove = callerSnapsApprove.get(callerId);
    publishCommunityJoinRequestApprovedSafe({
      communityId: community.id,
      communityName: community.name,
      communityHandle: community.handle,
      communityAvatarUrl: communityAvatarMediaApprove.downloadUrl,
      eventAt: new Date().toISOString(),
      requestId: request.id,
      userId: request.userId,
      decidedBy: {
        userId: callerId,
        username: callerSnapApprove?.username ?? null,
        displayName: callerSnapApprove?.displayName ?? "Unknown",
      },
      decidedAt: new Date().toISOString(),
    });

    // PERSONAL "Your request to join was approved" to the approved user only.
    // No community-wide join announcement — only the approved user sees it.
    publishCommunitySystemMessageForChatSafe({
      communityId: community.id,
      systemMessageType: "JOIN_REQUEST_APPROVED",
      metadata: {},
      triggeredByUserId: request.userId,
      eventAt: new Date().toISOString(),
      visibleToUserId: request.userId,
    });

    return {
      request: toJoinRequestData(updatedRequest),
      member: await toMemberData(row!),
    };
  },

  async rejectJoinRequest(
    communityId: string,
    callerId: string,
    requestId: string
  ): Promise<CommunityJoinRequestData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const request = await communityRepository.findJoinRequestById(requestId);
    if (!request || request.communityId !== communityId) {
      throw new NotFoundError("COMMUNITY_JOIN_REQUEST_NOT_FOUND");
    }
    if (request.status !== CommunityJoinReqStatus.PENDING) {
      throw new BadRequestError("COMMUNITY_JOIN_REQUEST_NOT_PENDING");
    }

    const updated = await communityRepository.updateJoinRequest(requestId, {
      status: CommunityJoinReqStatus.REJECTED,
      decidedBy: callerId,
      decidedAt: new Date(),
    });

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "JOIN_REQUEST_REJECTED",
      targetUserId: request.userId,
      metadata: { requestId },
    });

    // Dedicated rejected event → notifies the requester (in-app/push) and drives
    // the realtime join-request UI-state update.
    const [callerSnapsReject, communityAvatarMediaReject] = await Promise.all([
      fetchUserSnapshots([callerId]),
      buildCommunityImageMedia(community.avatarUrl),
    ]);
    const callerSnapReject = callerSnapsReject.get(callerId);
    publishCommunityJoinRequestRejectedSafe({
      communityId: community.id,
      communityName: community.name,
      communityHandle: community.handle,
      communityAvatarUrl: communityAvatarMediaReject.downloadUrl,
      eventAt: new Date().toISOString(),
      requestId: request.id,
      userId: request.userId,
      decidedBy: {
        userId: callerId,
        username: callerSnapReject?.username ?? null,
        displayName: callerSnapReject?.displayName ?? "Unknown",
      },
      decidedAt: new Date().toISOString(),
    });

    // PERSONAL "Your request to join was declined" — only the rejected user
    // sees it (never broadcast to the community).
    publishCommunitySystemMessageForChatSafe({
      communityId: community.id,
      systemMessageType: "JOIN_REQUEST_REJECTED",
      metadata: {},
      triggeredByUserId: request.userId,
      eventAt: new Date().toISOString(),
      visibleToUserId: request.userId,
    });

    return toJoinRequestData(updated);
  },

  async bulkApproveJoinRequests(
    communityId: string,
    callerId: string,
    requestIds: string[]
  ): Promise<{ approved: string[]; skipped: string[] }> {
    const community = await communityRepository.findById(communityId);
    if (!community) throw new NotFoundError("COMMUNITY_NOT_FOUND");

    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.MODERATOR);
    assertCommunityNotSuspended(community);

    const rows = await communityRepository.findJoinRequestsByIds(requestIds);
    const rowMap = new Map(rows.map((r) => [r.id, r]));

    const pending = requestIds.filter((id) => {
      const r = rowMap.get(id);
      return (
        r &&
        r.communityId === communityId &&
        r.status === CommunityJoinReqStatus.PENDING
      );
    });
    const skipped = requestIds.filter((id) => !pending.includes(id));

    if (pending.length === 0) return { approved: [], skipped };

    const targetUserIds = pending.map((id) => rowMap.get(id)!.userId);
    const [existingMembers, snapshotMap] = await Promise.all([
      communityRepository.findMembersByUserIds(communityId, targetUserIds),
      fetchUserSnapshots(targetUserIds),
    ]);
    const memberMap = new Map(existingMembers.map((m) => [m.userId, m]));

    const approved: string[] = [];
    const bannedSkipped: string[] = [];
    const decidedAt = new Date();

    for (const requestId of pending) {
      const request = rowMap.get(requestId)!;
      const existing = memberMap.get(request.userId);

      if (existing?.status === CommunityMemberStatus.BANNED) {
        bannedSkipped.push(requestId);
        continue;
      }

      const snap = snapshotMap.get(request.userId);
      const snapshotData = {
        snapshotUsername: snap?.username ?? "",
        snapshotDisplayName: snap?.displayName ?? "",
        snapshotAvatarKey: snap?.avatarObjectKey ?? null,
      };

      if (existing?.status === CommunityMemberStatus.LEFT) {
        await communityRepository.reactivateMemberWithSnapshot(
          communityId,
          request.userId,
          snapshotData
        );
      } else if (
        !existing ||
        existing.status !== CommunityMemberStatus.ACTIVE
      ) {
        await communityRepository.createMember({
          communityId,
          userId: request.userId,
          role: CommunityMemberRole.MEMBER,
          status: CommunityMemberStatus.ACTIVE,
          ...snapshotData,
        });
      }

      approved.push(requestId);
    }

    if (approved.length > 0) {
      await communityRepository.bulkUpdateJoinRequestStatus(
        approved,
        CommunityJoinReqStatus.APPROVED,
        callerId,
        decidedAt
      );

      const count = await communityRepository.countActiveMembers(communityId);
      await communityRepository.setMemberCount(communityId, count);

      // Re-read the now-ACTIVE member rows in one batch (real joinedAt/role) so
      // the per-member join notification carries the roster DTO without an N+1
      // member-row read; the ADMIN/MODERATOR recipient roster is likewise hoisted
      // ONCE here (identical for every approved member) instead of being resolved
      // per member inside notifyMemberJoined.
      const approvedUserIds = approved.map((id) => rowMap.get(id)!.userId);
      const joinedRows = await communityRepository.findMembersByUserIds(
        communityId,
        approvedUserIds
      );
      const joinedRowMap = new Map(joinedRows.map((m) => [m.userId, m]));

      const moderatorRecipientIds =
        await communityRepository.findActiveMemberIdsByRoles(communityId, [
          CommunityMemberRole.ADMIN,
          CommunityMemberRole.MODERATOR,
        ]);

      const [callerSnapsBulk, communityAvatarMediaBulk] = await Promise.all([
        fetchUserSnapshots([callerId]),
        buildCommunityImageMedia(community.avatarUrl),
      ]);
      const callerSnapBulk = callerSnapsBulk.get(callerId);

      for (const requestId of approved) {
        const request = rowMap.get(requestId)!;
        void this.recordAudit({
          communityId,
          actorId: callerId,
          action: "JOIN_REQUEST_APPROVED",
          targetUserId: request.userId,
          metadata: { requestId, bulk: true },
        });

        // Enriched member_added (moderator awareness) + roster broadcast.
        const joinedRow = joinedRowMap.get(request.userId);
        if (joinedRow) {
          await this.notifyMemberJoined({
            community,
            member: joinedRow,
            memberCount: count,
            actorId: callerId,
            via: "join_request_approved",
            requestId,
            moderatorRecipientIds,
          });
        }

        // Dedicated approved event for the requester (in-app/push + realtime UI).
        publishCommunityJoinRequestApprovedSafe({
          communityId: community.id,
          communityName: community.name,
          communityHandle: community.handle,
          communityAvatarUrl: communityAvatarMediaBulk.downloadUrl,
          eventAt: new Date().toISOString(),
          requestId,
          userId: request.userId,
          decidedBy: {
            userId: callerId,
            username: callerSnapBulk?.username ?? null,
            displayName: callerSnapBulk?.displayName ?? "Unknown",
          },
          decidedAt: decidedAt.toISOString(),
        });
      }

      logger.info(
        `Bulk approve join-requests: community=${communityId} approver=${callerId} approved=${approved.length} skipped=${skipped.length + bannedSkipped.length}`
      );
    }

    return { approved, skipped: [...skipped, ...bannedSkipped] };
  },

  async bulkRejectJoinRequests(
    communityId: string,
    callerId: string,
    requestIds: string[]
  ): Promise<{ rejected: string[]; skipped: string[] }> {
    const community = await communityRepository.findById(communityId);
    if (!community) throw new NotFoundError("COMMUNITY_NOT_FOUND");

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const rows = await communityRepository.findJoinRequestsByIds(requestIds);
    const rowMap = new Map(rows.map((r) => [r.id, r]));

    const pending = requestIds.filter((id) => {
      const r = rowMap.get(id);
      return (
        r &&
        r.communityId === communityId &&
        r.status === CommunityJoinReqStatus.PENDING
      );
    });
    const skipped = requestIds.filter((id) => !pending.includes(id));

    if (pending.length > 0) {
      const decidedAt = new Date();
      await communityRepository.bulkUpdateJoinRequestStatus(
        pending,
        CommunityJoinReqStatus.REJECTED,
        callerId,
        decidedAt
      );

      const [callerSnapsBulkReject, communityAvatarMediaBulkReject] =
        await Promise.all([
          fetchUserSnapshots([callerId]),
          buildCommunityImageMedia(community.avatarUrl),
        ]);
      const callerSnapBulkReject = callerSnapsBulkReject.get(callerId);

      for (const requestId of pending) {
        const request = rowMap.get(requestId)!;
        void this.recordAudit({
          communityId,
          actorId: callerId,
          action: "JOIN_REQUEST_REJECTED",
          targetUserId: request.userId,
          metadata: { requestId, bulk: true },
        });

        // Dedicated rejected event for the requester (in-app/push + realtime UI).
        publishCommunityJoinRequestRejectedSafe({
          communityId: community.id,
          communityName: community.name,
          communityHandle: community.handle,
          communityAvatarUrl: communityAvatarMediaBulkReject.downloadUrl,
          eventAt: new Date().toISOString(),
          requestId,
          userId: request.userId,
          decidedBy: {
            userId: callerId,
            username: callerSnapBulkReject?.username ?? null,
            displayName: callerSnapBulkReject?.displayName ?? "Unknown",
          },
          decidedAt: decidedAt.toISOString(),
        });
      }

      logger.info(
        `Bulk reject join-requests: community=${communityId} rejector=${callerId} rejected=${pending.length} skipped=${skipped.length}`
      );
    }

    return { rejected: pending, skipped };
  },

  async cancelJoinRequest(
    communityId: string,
    callerId: string,
    requestId: string
  ): Promise<CommunityJoinRequestData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const request = await communityRepository.findJoinRequestById(requestId);
    if (!request || request.communityId !== communityId) {
      throw new NotFoundError("COMMUNITY_JOIN_REQUEST_NOT_FOUND");
    }
    if (request.userId !== callerId) {
      throw new ForbiddenError("COMMUNITY_JOIN_REQUEST_NOT_OWNER");
    }
    if (request.status !== CommunityJoinReqStatus.PENDING) {
      throw new BadRequestError("COMMUNITY_JOIN_REQUEST_NOT_PENDING");
    }

    const updated = await communityRepository.updateJoinRequest(requestId, {
      status: CommunityJoinReqStatus.CANCELLED,
      decidedBy: callerId,
      decidedAt: new Date(),
    });

    const communityAvatarMediaCancel = await buildCommunityImageMedia(
      community.avatarUrl
    );
    publishCommunityJoinRequestCancelledSafe({
      communityId: community.id,
      communityName: community.name,
      communityHandle: community.handle,
      communityAvatarUrl: communityAvatarMediaCancel.downloadUrl,
      requestId,
      userId: callerId,
      cancelledAt: new Date().toISOString(),
      eventAt: new Date().toISOString(),
    });

    return toJoinRequestData(updated);
  },

  /**
   * Cancel the authenticated user's own pending join request for a community
   * without needing the requestId — looks up by (communityId, callerId).
   * Convenience alternative to cancelJoinRequest for clients that only have
   * communityId in scope (e.g. detail screen, no stored requestId).
   */
  async cancelMyJoinRequest(
    communityId: string,
    callerId: string
  ): Promise<CommunityJoinRequestData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const request = await communityRepository.findJoinRequestByCommunityAndUser(
      communityId,
      callerId
    );
    if (!request) {
      throw new NotFoundError("COMMUNITY_JOIN_REQUEST_NOT_FOUND");
    }
    if (request.status !== CommunityJoinReqStatus.PENDING) {
      throw new BadRequestError("COMMUNITY_JOIN_REQUEST_NOT_PENDING");
    }

    const updated = await communityRepository.updateJoinRequest(request.id, {
      status: CommunityJoinReqStatus.CANCELLED,
      decidedBy: callerId,
      decidedAt: new Date(),
    });

    const communityAvatarMediaCancelMine = await buildCommunityImageMedia(
      community.avatarUrl
    );
    publishCommunityJoinRequestCancelledSafe({
      communityId: community.id,
      communityName: community.name,
      communityHandle: community.handle,
      communityAvatarUrl: communityAvatarMediaCancelMine.downloadUrl,
      requestId: request.id,
      userId: callerId,
      cancelledAt: new Date().toISOString(),
      eventAt: new Date().toISOString(),
    });

    return toJoinRequestData(updated);
  },

  // ---------------------------------------------------------------------------
  // Invites
  // ---------------------------------------------------------------------------
  async createInvite(
    communityId: string,
    callerId: string,
    inviteeId: string
  ): Promise<CommunityInviteData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.MODERATOR);
    assertCommunityNotSuspended(community);

    if (inviteeId === callerId) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_SELF");
    }

    const existingMember = await communityRepository.findMemberByUserId(
      communityId,
      inviteeId
    );
    if (existingMember?.status === CommunityMemberStatus.ACTIVE) {
      throw new ConflictError("COMMUNITY_ALREADY_MEMBER");
    }
    if (existingMember?.status === CommunityMemberStatus.BANNED) {
      throw new ForbiddenError("COMMUNITY_INVITE_USER_BANNED");
    }

    // No auto-approve: always create (or recycle) an invite row. Pending
    // join-requests are not auto-approved by creating an invite.

    const existingInvite =
      await communityRepository.findInviteByCommunityAndInvitee(
        communityId,
        inviteeId
      );

    let invite: CommunityInvite;
    // Gate INVITE_SENT publish so the idempotent "same PENDING return" does
    // NOT emit. Fresh create + recycled invite both count as "new".
    let isNewOrRecycled = false;
    if (!existingInvite) {
      invite = await communityRepository.createInvite({
        communityId,
        inviterId: callerId,
        inviteeId,
      });
      isNewOrRecycled = true;
    } else if (existingInvite.status === CommunityInviteStatus.PENDING) {
      invite = existingInvite;
    } else {
      invite = await communityRepository.recyclePendingInvite(
        existingInvite.id,
        callerId
      );
      isNewOrRecycled = true;
    }

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "MEMBER_INVITED",
      targetUserId: inviteeId,
      metadata: { inviteId: invite.id },
    });

    logger.info(
      `Community invite created: community=${communityId} inviter=${callerId} invitee=${inviteeId} invite=${invite.id} status=${invite.status}`
    );

    if (isNewOrRecycled) {
      publishCommunityInviteSentSafe({
        communityId,
        eventAt: new Date().toISOString(),
        inviterId: callerId,
        inviteeId,
        inviteId: invite.id,
      });
    }

    return toInviteData(invite);
  },

  async listCommunityInvites(
    communityId: string,
    callerId: string,
    params: {
      page: number;
      limit: number;
      status?: CommunityInviteStatus;
    }
  ): Promise<PaginatedResponse<CommunityInviteWithUserData>> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const { rows, total } = await communityRepository.listCommunityInvites({
      communityId,
      status: params.status,
      page: params.page,
      limit: params.limit,
    });

    const items: CommunityInviteWithUserData[] = [];
    if (rows.length > 0) {
      const snapshotMap = await fetchUserSnapshots(
        rows.map((r) => r.inviteeId)
      );
      for (const row of rows) {
        const snap = snapshotMap.get(row.inviteeId)!;
        const invitee = await buildUserSnapshotView(snap, row.inviteeId);
        items.push({ ...toInviteData(row), invitee });
      }
    }

    return buildPaginatedResponse(items, total, params.page, params.limit);
  },

  async listMyInvites(
    callerId: string,
    params: {
      page: number;
      limit: number;
      status?: CommunityInviteStatus;
    }
  ): Promise<PaginatedResponse<MyInviteData>> {
    const { rows, total } = await communityRepository.listMyInvites({
      inviteeId: callerId,
      status: params.status,
      page: params.page,
      limit: params.limit,
    });

    const items: MyInviteData[] = [];
    if (rows.length > 0) {
      const communityIds = [...new Set(rows.map((r) => r.communityId))];
      const communities =
        await communityRepository.findCommunitiesByIds(communityIds);
      const communityMap = new Map(communities.map((c) => [c.id, c]));

      for (const row of rows) {
        const community = communityMap.get(row.communityId);
        if (!community) continue; // soft-deleted; best-effort filter
        items.push({
          ...toInviteData(row),
          community: await toEmbeddedCommunitySummary(community),
        });
      }
    }

    return buildPaginatedResponse(items, total, params.page, params.limit);
  },

  async acceptInvite(
    callerId: string,
    inviteId: string
  ): Promise<{ invite: CommunityInviteData; member: CommunityMemberData }> {
    const invite = await communityRepository.findInviteById(inviteId);
    if (!invite) {
      throw new NotFoundError("COMMUNITY_INVITE_NOT_FOUND");
    }
    if (invite.inviteeId !== callerId) {
      throw new ForbiddenError("COMMUNITY_INVITE_NOT_INVITEE");
    }

    const community = await communityRepository.findById(invite.communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }
    assertCommunityNotSuspended(community);

    if (invite.status === CommunityInviteStatus.ACCEPTED) {
      const existing = await communityRepository.findMemberByUserId(
        invite.communityId,
        callerId
      );
      if (existing) {
        return {
          invite: toInviteData(invite),
          member: await toMemberData(existing),
        };
      }
      logger.warn(
        `acceptInvite: ACCEPTED invite ${inviteId} has no member row; re-writing`
      );
    } else if (invite.status !== CommunityInviteStatus.PENDING) {
      throw new BadRequestError("COMMUNITY_INVITE_NOT_PENDING");
    }

    const targetMember = await communityRepository.findMemberByUserId(
      invite.communityId,
      callerId
    );
    if (targetMember?.status === CommunityMemberStatus.ACTIVE) {
      const updatedInvite = await communityRepository.updateInvite(inviteId, {
        status: CommunityInviteStatus.ACCEPTED,
      });
      return {
        invite: toInviteData(updatedInvite),
        member: await toMemberData(targetMember),
      };
    }
    if (targetMember?.status === CommunityMemberStatus.BANNED) {
      try {
        await communityRepository.updateInvite(inviteId, {
          status: CommunityInviteStatus.DECLINED,
        });
      } catch (closeErr) {
        logger.error(
          `Failed to close BANNED-race invite ${inviteId} during accept`
        );
        logger.error(closeErr);
      }
      throw new ForbiddenError("COMMUNITY_JOIN_BANNED");
    }

    const snapshotMap = await fetchUserSnapshots([callerId]);
    const snap = snapshotMap.get(callerId)!;

    if (targetMember?.status === CommunityMemberStatus.LEFT) {
      await communityRepository.reactivateMemberWithSnapshot(
        invite.communityId,
        callerId,
        {
          snapshotUsername: snap.username,
          snapshotDisplayName: snap.displayName,
          snapshotAvatarKey: snap.avatarObjectKey,
        }
      );
    } else {
      await communityRepository.createMember({
        communityId: invite.communityId,
        userId: callerId,
        role: CommunityMemberRole.MEMBER,
        status: CommunityMemberStatus.ACTIVE,
        snapshotUsername: snap.username,
        snapshotDisplayName: snap.displayName,
        snapshotAvatarKey: snap.avatarObjectKey,
      });
    }

    const count = await communityRepository.countActiveMembers(
      invite.communityId
    );
    await communityRepository.setMemberCount(invite.communityId, count);

    void communityRepository
      .updateLastActivity(
        invite.communityId,
        new Date(),
        "join",
        `${snap.username} joined the community`,
        snap.username,
        callerId,
        SELF_JOIN_ACTIVITY_PREVIEW
      )
      .catch((err) =>
        logger.warn(
          `updateLastActivity failed for community=${invite.communityId}: ${String(err)}`
        )
      );

    const updatedInvite = await communityRepository.updateInvite(inviteId, {
      status: CommunityInviteStatus.ACCEPTED,
    });

    await this.recordAudit({
      communityId: invite.communityId,
      actorId: callerId,
      action: "INVITE_ACCEPTED",
      targetUserId: callerId,
      metadata: { inviteId },
    });

    logger.info(
      `Community invite accepted: community=${invite.communityId} invite=${inviteId} by=${callerId}`
    );

    // Per E5 / spec note: explicit accept emits ONLY INVITE_ACCEPTED (the
    // consumer treats this as "X accepted your invite", not "X was added").
    // Do NOT also publish MEMBER_ADDED here.
    publishCommunityInviteAcceptedSafe({
      communityId: invite.communityId,
      eventAt: new Date().toISOString(),
      userId: callerId,
      inviteId,
      inviterId: invite.inviterId,
    });

    const row = await communityRepository.findMemberByUserId(
      invite.communityId,
      callerId
    );
    return {
      invite: toInviteData(updatedInvite),
      member: await toMemberData(row!),
    };
  },

  async declineInvite(
    callerId: string,
    inviteId: string
  ): Promise<CommunityInviteData> {
    const invite = await communityRepository.findInviteById(inviteId);
    if (!invite) {
      throw new NotFoundError("COMMUNITY_INVITE_NOT_FOUND");
    }
    if (invite.inviteeId !== callerId) {
      throw new ForbiddenError("COMMUNITY_INVITE_NOT_INVITEE");
    }
    if (invite.status !== CommunityInviteStatus.PENDING) {
      throw new BadRequestError("COMMUNITY_INVITE_NOT_PENDING");
    }

    const updated = await communityRepository.updateInvite(inviteId, {
      status: CommunityInviteStatus.DECLINED,
    });

    await this.recordAudit({
      communityId: invite.communityId,
      actorId: callerId,
      action: "INVITE_DECLINED",
      targetUserId: callerId,
      metadata: { inviteId, communityId: invite.communityId },
    });

    return toInviteData(updated);
  },

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------
  async createReport(
    communityId: string,
    callerId: string,
    input: { targetUserId?: string; reason: string }
  ): Promise<CommunityReportData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // A1: only an ACTIVE member of the community may file a report.
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    if (
      !callerMembership ||
      callerMembership.status !== CommunityMemberStatus.ACTIVE
    ) {
      throw new ForbiddenError("COMMUNITY_FORBIDDEN");
    }

    const targetUserId = input.targetUserId ?? null;

    // A2: cannot self-report.
    if (targetUserId && targetUserId === callerId) {
      throw new BadRequestError("COMMUNITY_REPORT_CANNOT_TARGET_SELF");
    }

    // A4: when targeting a member, that member row must exist (any status).
    if (targetUserId) {
      const targetMember = await communityRepository.findMemberByUserId(
        communityId,
        targetUserId
      );
      if (!targetMember) {
        throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
      }
    }

    // A5: service-level dedup — an existing OPEN report from the same
    // reporter on the same (community, target) tuple is returned idempotently.
    const existing =
      await communityRepository.findOpenReportByReporterAndTarget({
        communityId,
        reporterId: callerId,
        targetUserId,
      });
    if (existing) {
      return toReportData(existing);
    }

    const row = await communityRepository.createReport({
      communityId,
      reporterId: callerId,
      targetUserId,
      reason: input.reason,
    });

    logger.info(
      `Community report created: community=${communityId} reporter=${callerId} target=${targetUserId ?? "(community)"} report=${row.id}`
    );

    const reportModeratorRecipientIds =
      await communityRepository.findActiveMemberIdsByRoles(communityId, [
        CommunityMemberRole.ADMIN,
        CommunityMemberRole.MODERATOR,
      ]);
    // One timestamp for both events so they correlate for the same report.
    const reportEventAt = new Date().toISOString();
    publishCommunityReportCreatedSafe({
      communityId,
      eventAt: reportEventAt,
      reportId: row.id,
      reporterId: callerId,
      targetUserId,
      reason: input.reason,
      moderatorRecipientIds: reportModeratorRecipientIds,
    });

    publishAdminReportIngestSafe({
      type: targetUserId ? "user" : "community",
      targetId: targetUserId ?? communityId,
      reporterId: callerId,
      reason: input.reason,
      details: null,
      eventAt: reportEventAt,
      sourceReportId: row.id,
    });

    return toReportData(row);
  },

  async listCommunityReports(
    communityId: string,
    callerId: string,
    params: {
      page: number;
      limit: number;
      status?: CommunityReportStatus;
    }
  ): Promise<PaginatedResponse<CommunityReportWithUsersData>> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // A8: mod/admin only.
    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const status = params.status ?? CommunityReportStatus.OPEN;
    const { rows, total } = await communityRepository.listCommunityReports({
      communityId,
      status,
      page: params.page,
      limit: params.limit,
    });

    const items: CommunityReportWithUsersData[] = [];
    if (rows.length > 0) {
      // Batch-fetch reporter + (optional) target snapshots once.
      const userIds = new Set<string>();
      for (const r of rows) {
        userIds.add(r.reporterId);
        if (r.targetUserId) userIds.add(r.targetUserId);
      }
      const snapshotMap = await fetchUserSnapshots([...userIds]);
      for (const row of rows) {
        const reporterSnap = snapshotMap.get(row.reporterId)!;
        const reporter = await buildUserSnapshotView(
          reporterSnap,
          row.reporterId
        );
        let target: CommunityReportWithUsersData["target"] = null;
        if (row.targetUserId) {
          const targetSnap = snapshotMap.get(row.targetUserId)!;
          target = await buildUserSnapshotView(targetSnap, row.targetUserId);
        }
        items.push({ ...toReportData(row), reporter, target });
      }
    }

    return buildPaginatedResponse(items, total, params.page, params.limit);
  },

  async listMyReports(
    callerId: string,
    params: {
      page: number;
      limit: number;
      status?: CommunityReportStatus;
    }
  ): Promise<PaginatedResponse<MyReportData>> {
    const { rows, total } = await communityRepository.listMyReports({
      reporterId: callerId,
      status: params.status,
      page: params.page,
      limit: params.limit,
    });

    const items: MyReportData[] = [];
    if (rows.length > 0) {
      const communityIds = [...new Set(rows.map((r) => r.communityId))];
      const communities =
        await communityRepository.findCommunitiesByIds(communityIds);
      const communityMap = new Map(communities.map((c) => [c.id, c]));

      for (const row of rows) {
        const community = communityMap.get(row.communityId);
        if (!community) continue; // soft-deleted; best-effort filter
        items.push({
          ...toReportData(row),
          community: await toEmbeddedCommunitySummary(community),
        });
      }
    }

    return buildPaginatedResponse(items, total, params.page, params.limit);
  },

  /**
   * Shared transition helper for review / action / dismiss.
   * Enforces A7 transitions, A8 authz, A14 audit (for non-REVIEWED targets).
   */
  async _resolveReport(
    communityId: string,
    callerId: string,
    reportId: string,
    nextStatus:
      | typeof CommunityReportStatus.REVIEWED
      | typeof CommunityReportStatus.ACTIONED
      | typeof CommunityReportStatus.DISMISSED,
    resolution: string | null,
    auditAction:
      | "COMMUNITY_REPORT_REVIEWED"
      | "COMMUNITY_REPORT_ACTIONED"
      | "COMMUNITY_REPORT_DISMISSED"
  ): Promise<CommunityReportData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      // A15: soft-deleted community → 404.
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const report = await communityRepository.findReportById(reportId);
    if (!report || report.communityId !== communityId) {
      throw new NotFoundError("COMMUNITY_REPORT_NOT_FOUND");
    }

    // A7 transitions:
    //   OPEN → REVIEWED | ACTIONED | DISMISSED
    //   REVIEWED → ACTIONED | DISMISSED
    //   ACTIONED, DISMISSED, WITHDRAWN are terminal.
    const allowed: Record<CommunityReportStatus, CommunityReportStatus[]> = {
      [CommunityReportStatus.OPEN]: [
        CommunityReportStatus.REVIEWED,
        CommunityReportStatus.ACTIONED,
        CommunityReportStatus.DISMISSED,
      ],
      [CommunityReportStatus.REVIEWED]: [
        CommunityReportStatus.ACTIONED,
        CommunityReportStatus.DISMISSED,
      ],
      [CommunityReportStatus.ACTIONED]: [],
      [CommunityReportStatus.DISMISSED]: [],
      [CommunityReportStatus.WITHDRAWN]: [],
    };
    if (!allowed[report.status].includes(nextStatus)) {
      throw new BadRequestError("COMMUNITY_REPORT_INVALID_TRANSITION");
    }

    const updated = await communityRepository.updateReport(reportId, {
      status: nextStatus,
      reviewedBy: callerId,
      reviewedAt: new Date(),
      resolution: resolution,
    });

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: auditAction,
      targetUserId: report.targetUserId ?? undefined,
      reason: resolution ?? undefined,
      metadata: { reportId, fromStatus: report.status, toStatus: nextStatus },
    });

    logger.info(
      `Community report ${nextStatus.toLowerCase()}: community=${communityId} report=${reportId} by=${callerId} from=${report.status}`
    );

    // Per spec: only the "ACTIONED" transition publishes (review/dismiss are
    // observation events the consumer doesn't fan out yet). Withdraw goes
    // through a separate method and never emits.
    if (auditAction === "COMMUNITY_REPORT_ACTIONED") {
      publishCommunityReportActionedSafe({
        communityId,
        eventAt: new Date().toISOString(),
        reportId,
        actorId: callerId,
        reporterId: report.reporterId,
        targetUserId: report.targetUserId ?? null,
      });
    }

    return toReportData(updated);
  },

  reviewReport(
    communityId: string,
    callerId: string,
    reportId: string,
    resolution: string | null
  ): Promise<CommunityReportData> {
    return this._resolveReport(
      communityId,
      callerId,
      reportId,
      CommunityReportStatus.REVIEWED,
      resolution,
      "COMMUNITY_REPORT_REVIEWED"
    );
  },

  actionReport(
    communityId: string,
    callerId: string,
    reportId: string,
    resolution: string | null
  ): Promise<CommunityReportData> {
    return this._resolveReport(
      communityId,
      callerId,
      reportId,
      CommunityReportStatus.ACTIONED,
      resolution,
      "COMMUNITY_REPORT_ACTIONED"
    );
  },

  dismissReport(
    communityId: string,
    callerId: string,
    reportId: string,
    resolution: string | null
  ): Promise<CommunityReportData> {
    return this._resolveReport(
      communityId,
      callerId,
      reportId,
      CommunityReportStatus.DISMISSED,
      resolution,
      "COMMUNITY_REPORT_DISMISSED"
    );
  },

  /**
   * A11: reporter withdraws an OPEN report. Owner-only, OPEN-only.
   * Sets status WITHDRAWN with resolution "withdrawn_by_reporter".
   * No mod authz needed; no audit (reporter changed their mind — not a mod action).
   * No community soft-delete check: a user may withdraw a report on a deleted
   * community to clean up their own list.
   */
  async withdrawReport(
    communityId: string,
    callerId: string,
    reportId: string
  ): Promise<CommunityReportData> {
    const report = await communityRepository.findReportById(reportId);
    if (!report || report.communityId !== communityId) {
      throw new NotFoundError("COMMUNITY_REPORT_NOT_FOUND");
    }
    if (report.reporterId !== callerId) {
      throw new ForbiddenError("COMMUNITY_REPORT_NOT_OWNER");
    }
    if (report.status !== CommunityReportStatus.OPEN) {
      throw new BadRequestError("COMMUNITY_REPORT_NOT_OPEN");
    }

    const updated = await communityRepository.updateReport(reportId, {
      status: CommunityReportStatus.WITHDRAWN,
      resolution: "withdrawn_by_reporter",
    });

    logger.info(
      `Community report withdrawn: community=${communityId} report=${reportId} by=${callerId}`
    );

    return toReportData(updated);
  },

  /**
   * Hard-delete a report (MODERATOR+). Community must exist, report must exist
   * and belong to the community. Records a COMMUNITY_REPORT_DELETED audit entry
   * with the prior status in metadata.
   */
  async deleteReport(
    communityId: string,
    callerId: string,
    reportId: string
  ): Promise<void> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const report = await communityRepository.findReportById(reportId);
    if (!report || report.communityId !== communityId) {
      throw new NotFoundError("COMMUNITY_REPORT_NOT_FOUND");
    }

    await communityRepository.deleteReport(reportId);

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "COMMUNITY_REPORT_DELETED",
      targetUserId: report.targetUserId ?? undefined,
      metadata: { reportId, priorStatus: report.status },
    });

    logger.info(
      `Community report deleted: community=${communityId} report=${reportId} by=${callerId} priorStatus=${report.status}`
    );
  },

  // ---------------------------------------------------------------------------
  // Mute settings (per-user, per-community notification mute)
  // ---------------------------------------------------------------------------
  async getMute(
    communityId: string,
    callerId: string
  ): Promise<CommunityMuteData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    if (!membership || membership.status !== CommunityMemberStatus.ACTIVE) {
      throw new ForbiddenError("COMMUNITY_FORBIDDEN");
    }

    const row = await communityRepository.findMuteByUserAndCommunity(
      callerId,
      communityId
    );
    if (!row) {
      throw new NotFoundError("COMMUNITY_NOT_MUTED");
    }

    return {
      communityId,
      mutedUntil: row.mutedUntil ? row.mutedUntil.toISOString() : null,
      streamEnabled: row.streamEnabled,
      chatEnabled: row.chatEnabled,
      announcementEnabled: row.announcementEnabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  },

  async setMute(
    communityId: string,
    callerId: string,
    durationMinutes: number | null | undefined
  ): Promise<CommunityMuteData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    if (!membership || membership.status !== CommunityMemberStatus.ACTIVE) {
      throw new ForbiddenError("COMMUNITY_FORBIDDEN");
    }

    // null / undefined → indefinite mute; positive number → now + N minutes.
    const mutedUntil =
      durationMinutes == null
        ? null
        : new Date(Date.now() + durationMinutes * 60_000);

    const row = await communityRepository.upsertMute(
      callerId,
      communityId,
      mutedUntil
    );

    return {
      communityId,
      mutedUntil: row.mutedUntil ? row.mutedUntil.toISOString() : null,
      streamEnabled: row.streamEnabled,
      chatEnabled: row.chatEnabled,
      announcementEnabled: row.announcementEnabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  },

  async clearMute(communityId: string, callerId: string): Promise<void> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    if (!membership || membership.status !== CommunityMemberStatus.ACTIVE) {
      throw new ForbiddenError("COMMUNITY_FORBIDDEN");
    }

    await communityRepository.clearMute(callerId, communityId);
  },

  async bulkMute(
    callerId: string,
    communityIds: string[],
    durationMinutes: number | null | undefined
  ): Promise<{ muted: string[]; skipped: string[] }> {
    // Fetch active memberships and existing mutes in parallel.
    const [memberships, existingMutes] = await Promise.all([
      communityRepository.findActiveMembershipsByCommunityIds(
        callerId,
        communityIds
      ),
      communityRepository.findMutesByUserAndCommunityIds(
        callerId,
        communityIds
      ),
    ]);

    const activeMemberSet = new Set(memberships.map((m) => m.communityId));
    const alreadyMutedSet = new Set(existingMutes.map((m) => m.communityId));

    const toMute = communityIds.filter(
      (id) => activeMemberSet.has(id) && !alreadyMutedSet.has(id)
    );
    const skipped = communityIds.filter((id) => !toMute.includes(id));

    if (toMute.length > 0) {
      const mutedUntil =
        durationMinutes == null
          ? null
          : new Date(Date.now() + durationMinutes * 60_000);
      await communityRepository.bulkCreateMute(callerId, toMute, mutedUntil);
    }

    return { muted: toMute, skipped };
  },

  async bulkUnmute(
    callerId: string,
    communityIds: string[]
  ): Promise<{ unmuted: string[]; skipped: string[] }> {
    const existingMutes =
      await communityRepository.findMutesByUserAndCommunityIds(
        callerId,
        communityIds
      );

    const mutedSet = new Set(existingMutes.map((m) => m.communityId));
    const toUnmute = communityIds.filter((id) => mutedSet.has(id));
    const skipped = communityIds.filter((id) => !mutedSet.has(id));

    if (toUnmute.length > 0) {
      await communityRepository.bulkClearMute(callerId, toUnmute);
    }

    return { unmuted: toUnmute, skipped };
  },

  async bulkMarkRead(
    callerId: string,
    communityIds: string[]
  ): Promise<{ updatedCount: number }> {
    const updatedCount = await getChatClient().bulkMarkCommunityRead({
      userId: callerId,
      communityIds,
    });
    return { updatedCount };
  },

  // ---------------------------------------------------------------------------
  // Per-community notification preferences (toggles on the mute-setting row)
  // ---------------------------------------------------------------------------
  async getNotificationPreferences(
    communityId: string,
    callerId: string
  ): Promise<CommunityNotificationPreferenceData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    if (!membership || membership.status !== CommunityMemberStatus.ACTIVE) {
      throw new ForbiddenError("COMMUNITY_FORBIDDEN");
    }

    const row = await communityRepository.findMuteByUserAndCommunity(
      callerId,
      communityId
    );

    // A member always has implicit defaults — no row → all enabled, not muted.
    if (!row) {
      return {
        communityId,
        mutedUntil: null,
        streamEnabled: true,
        chatEnabled: true,
        announcementEnabled: true,
        isMuted: false,
        createdAt: null,
        updatedAt: null,
      };
    }

    return {
      communityId,
      mutedUntil: row.mutedUntil ? row.mutedUntil.toISOString() : null,
      streamEnabled: row.streamEnabled,
      chatEnabled: row.chatEnabled,
      announcementEnabled: row.announcementEnabled,
      isMuted:
        !row.streamEnabled && !row.chatEnabled && !row.announcementEnabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  },

  async setNotificationPreferences(
    communityId: string,
    callerId: string,
    prefs: {
      streamEnabled?: boolean;
      chatEnabled?: boolean;
      announcementEnabled?: boolean;
    }
  ): Promise<CommunityNotificationPreferenceData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    if (!membership || membership.status !== CommunityMemberStatus.ACTIVE) {
      throw new ForbiddenError("COMMUNITY_FORBIDDEN");
    }

    const row = await communityRepository.upsertNotificationPrefs(
      callerId,
      communityId,
      prefs
    );

    return {
      communityId,
      mutedUntil: row.mutedUntil ? row.mutedUntil.toISOString() : null,
      streamEnabled: row.streamEnabled,
      chatEnabled: row.chatEnabled,
      announcementEnabled: row.announcementEnabled,
      isMuted:
        !row.streamEnabled && !row.chatEnabled && !row.announcementEnabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  },

  // ---------------------------------------------------------------------------
  // Admin moderation: close / reopen a community
  // ---------------------------------------------------------------------------
  /**
   * Called from the gRPC handler (adminSetModerationStatus RPC). Persists the
   * new moderation status via the repository and — on success — publishes a
   * `community.status.changed` event so chat-service can suspend or unsuspend
   * the community's chat room asynchronously.
   */
  async adminSetModerationStatus(
    communityId: string,
    target: CommunityModerationStatus,
    reasonCode: string | null,
    actorAdminId: string | null
  ): Promise<{
    ok: boolean;
    status: string;
    closedAt: number;
    errorCode: string;
  }> {
    const result = await communityRepository.adminSetModerationStatus(
      communityId,
      target,
      reasonCode,
      actorAdminId
    );

    if (result.ok) {
      publishCommunityStatusChangedForChatSafe({
        communityId,
        communityStatus:
          target === CommunityModerationStatus.SUSPENDED
            ? "SUSPENDED"
            : "ACTIVE",
      });
      logger.info(
        `Community moderation status changed: community=${communityId} status=${String(target)} actor=${actorAdminId ?? "unknown"}`
      );
    }

    return result;
  },

  // ---------------------------------------------------------------------------
  // Invite links (shareable join links — distinct from 1:1 invites)
  // ---------------------------------------------------------------------------
  async createInviteLink(
    communityId: string,
    callerId: string,
    input: {
      maxUses?: number;
      expiresInMinutes?: number;
      autoApprove?: boolean;
    }
  ): Promise<CommunityInviteLinkData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);
    assertCommunityNotSuspended(community);

    const expiresAt = input.expiresInMinutes
      ? new Date(Date.now() + input.expiresInMinutes * 60_000)
      : null;
    const maxUses = input.maxUses ?? null;
    const autoApprove =
      input.autoApprove !== undefined
        ? input.autoApprove
        : community.type === CommunityType.PRIVATE
          ? true
          : false;

    // Retry up to 3 times on code collision (P2002 unique violation on `code`).
    let row: Awaited<
      ReturnType<typeof communityRepository.createInviteLink>
    > | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        row = await communityRepository.createInviteLink({
          code: generateInviteCode(),
          communityId,
          createdBy: callerId,
          maxUses,
          autoApprove,
          expiresAt,
        });
        break;
      } catch (err) {
        if (!isUniqueConstraintError(err) || attempt === 2) throw err;
      }
    }
    if (!row) throw new Error("Failed to allocate invite-link code");

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "INVITE_LINK_CREATED",
      metadata: {
        linkId: row.id,
        maxUses,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    });

    return toInviteLinkData(row);
  },

  async listInviteLinks(
    communityId: string,
    callerId: string,
    params: {
      page: number;
      limit: number;
      status?: "active" | "expired" | "revoked";
    }
  ): Promise<PaginatedResponse<CommunityInviteLinkData>> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const { rows, total } = await communityRepository.listInviteLinks({
      communityId,
      status: params.status,
      page: params.page,
      limit: params.limit,
    });
    return buildPaginatedResponse(
      rows.map(toInviteLinkData),
      total,
      params.page,
      params.limit
    );
  },

  async revokeInviteLink(
    communityId: string,
    callerId: string,
    linkId: string
  ): Promise<CommunityInviteLinkData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const link = await communityRepository.findInviteLinkById(linkId);
    if (!link || link.communityId !== communityId) {
      throw new NotFoundError("COMMUNITY_INVITE_LINK_NOT_FOUND");
    }
    if (link.revokedAt) {
      return toInviteLinkData(link); // idempotent
    }
    const updated = await communityRepository.updateInviteLink(linkId, {
      revokedAt: new Date(),
    });

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "INVITE_LINK_REVOKED",
      metadata: { linkId },
    });

    return toInviteLinkData(updated);
  },

  /**
   * Bulk-share a community invite link via system DMs.
   *
   * 1. Validates the caller holds MODERATOR or ADMIN role.
   * 2. Resolves or creates one active invite link to share.
   * 3. Fires one `community.invite_link_shared` RabbitMQ event per userId (→
   *    chat-service consumes and delivers a system DM).
   *
   * Returns the resolved link data plus counts of queued/skipped recipients.
   */
  async bulkSendInviteLink(
    communityId: string,
    callerId: string,
    input: {
      userIds: string[];
      /** Optional: prefer this specific link. Falls back to first active link or
       *  auto-creates one if none exists. */
      linkId?: string;
    }
  ): Promise<{
    link: CommunityInviteLinkData;
    queued: number;
    skipped: number;
  }> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);
    assertCommunityNotSuspended(community);

    // --- Resolve or create the invite link -----------------------------------

    let linkRow: CommunityInviteLink | null;

    if (input.linkId) {
      // Caller specified a particular link — validate it.
      linkRow = await communityRepository.findInviteLinkById(input.linkId);
      if (!linkRow || linkRow.communityId !== communityId) {
        throw new NotFoundError("COMMUNITY_INVITE_LINK_NOT_FOUND");
      }
      const now = Date.now();
      const isActive =
        !linkRow.revokedAt &&
        (!linkRow.expiresAt || linkRow.expiresAt.getTime() > now) &&
        (linkRow.maxUses === null || linkRow.usedCount < linkRow.maxUses);
      if (!isActive) {
        throw new ForbiddenError("COMMUNITY_INVITE_LINK_INACTIVE");
      }
    } else {
      // Auto-pick the first active link, or create one.
      const { rows } = await communityRepository.listInviteLinks({
        communityId,
        status: "active",
        page: 1,
        limit: 1,
      });
      if (rows.length > 0) {
        linkRow = rows[0]!;
      } else {
        // No active link exists — create a permanent, unlimited one.
        let created: CommunityInviteLink | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            created = await communityRepository.createInviteLink({
              code: generateInviteCode(),
              communityId,
              createdBy: callerId,
              maxUses: null,
              autoApprove: false,
              expiresAt: null,
            });
            break;
          } catch (err) {
            if (!isUniqueConstraintError(err) || attempt === 2) throw err;
          }
        }
        if (!created) throw new Error("Failed to allocate invite-link code");
        linkRow = created;
      }
    }

    // --- Fan-out events: one per unique non-self userId ----------------------

    const uniqueIds = [...new Set(input.userIds)];
    let queued = 0;
    let skipped = 0;

    const eventAt = new Date().toISOString();
    for (const recipientId of uniqueIds) {
      if (recipientId === callerId) {
        skipped++;
        continue;
      }
      publishCommunityInviteLinkSharedForChatSafe({
        communityId,
        communityName: community.name,
        linkCode: linkRow.code,
        inviterId: callerId,
        recipientId,
        eventAt,
      });
      queued++;
    }

    return { link: toInviteLinkData(linkRow), queued, skipped };
  },

  async redeemInviteLink(
    code: string,
    callerId: string
  ): Promise<{
    link: CommunityInviteLinkData;
    request?: CommunityJoinRequestData;
    member?: CommunityMemberData;
  }> {
    const link = await communityRepository.findInviteLinkByCode(code);
    if (!link) throw new NotFoundError("COMMUNITY_INVITE_LINK_NOT_FOUND");
    assertInviteLinkActive(link);

    const community = await communityRepository.findById(link.communityId);
    if (!community) throw new NotFoundError("COMMUNITY_NOT_FOUND");
    assertCommunityNotSuspended(community);

    const existing = await communityRepository.findMemberByUserId(
      community.id,
      callerId
    );
    if (existing?.status === CommunityMemberStatus.BANNED) {
      throw new ForbiddenError("COMMUNITY_JOIN_BANNED");
    }
    if (existing?.status === CommunityMemberStatus.ACTIVE) {
      // Idempotent: do NOT increment usedCount or re-emit MEMBER_ADDED.
      return {
        link: toInviteLinkData(link),
        member: await toMemberData(existing),
      };
    }

    // Atomic capacity-guarded increment — if count === 0, another redeemer
    // beat us across the line and the link is now exhausted.
    const incRes = await communityRepository.incrementInviteLinkUsageIfUnder(
      link.id
    );
    if (incRes.count === 0) {
      throw new GoneError("COMMUNITY_INVITE_LINK_EXHAUSTED");
    }

    // Record audit that the link was used.
    await this.recordAudit({
      communityId: community.id,
      actorId: callerId,
      action: "INVITE_LINK_REDEEMED",
      targetUserId: callerId,
      metadata: { linkId: link.id, code: link.code },
    });

    const updatedLink = await communityRepository.findInviteLinkById(link.id);

    if (link.autoApprove) {
      // autoApprove=true: directly add the member without a join request.
      const snapshotMap = await fetchUserSnapshots([callerId]);
      const snap = snapshotMap.get(callerId)!;
      let member;
      if (existing?.status === CommunityMemberStatus.LEFT) {
        member = await communityRepository.reactivateMemberWithSnapshot(
          community.id,
          callerId,
          {
            snapshotUsername: snap.username,
            snapshotDisplayName: snap.displayName,
            snapshotAvatarKey: snap.avatarObjectKey,
          }
        );
      } else {
        member = await communityRepository.createMember({
          communityId: community.id,
          userId: callerId,
          role: CommunityMemberRole.MEMBER,
          status: CommunityMemberStatus.ACTIVE,
          snapshotUsername: snap.username,
          snapshotDisplayName: snap.displayName,
          snapshotAvatarKey: snap.avatarObjectKey,
        });
      }
      const count = await communityRepository.countActiveMembers(community.id);
      await communityRepository.setMemberCount(community.id, count);

      void communityRepository
        .updateLastActivity(
          community.id,
          new Date(),
          "join",
          `${snap.username} joined the community`,
          snap.username,
          callerId,
          SELF_JOIN_ACTIVITY_PREVIEW
        )
        .catch((err) =>
          logger.warn(
            `updateLastActivity failed for community=${community.id}: ${String(err)}`
          )
        );

      // Self-join via invite link: enriched member_added (moderator awareness) +
      // roster broadcast. actor === target, so the notifications consumer still
      // welcomes the joiner (the welcome is skipped only for join_request_approved).
      await this.notifyMemberJoined({
        community,
        member,
        memberCount: count,
        actorId: member.userId,
        via: "invite_link_redeem",
        requestId: undefined,
      });

      // PERSONAL "You joined the community" to the joiner only.
      // No community-wide join announcement — only the joiner sees it.
      publishCommunitySystemMessageForChatSafe({
        communityId: community.id,
        systemMessageType: "COMMUNITY_JOINED",
        metadata: {},
        triggeredByUserId: callerId,
        eventAt: new Date().toISOString(),
        visibleToUserId: callerId,
      });

      return {
        link: toInviteLinkData(updatedLink!),
        member: await toMemberData(member),
      };
    }

    // autoApprove=false (default): create a join request through approval flow.
    const joinResult = await this.createJoinRequest(
      community.id,
      callerId,
      null
    );

    return {
      link: toInviteLinkData(updatedLink!),
      request: joinResult,
    };
  },

  /**
   * Public (optional-auth) lookup: returns a community preview for the invite
   * link landing screen. Validates link validity, resolves avatar/banner URLs,
   * and (when a caller is identified) reports whether they are already a member
   * and rejects banned callers with 403.
   */
  async lookupInviteLink(
    code: string,
    callerId: string
  ): Promise<InviteLinkPreviewData> {
    const link = await communityRepository.findInviteLinkByCode(code);
    if (!link) throw new NotFoundError("COMMUNITY_INVITE_LINK_NOT_FOUND");
    assertInviteLinkActive(link);

    const community = await communityRepository.findById(link.communityId);
    if (!community) throw new NotFoundError("COMMUNITY_NOT_FOUND");
    // Preview is intentionally read-only: assertCommunityNotSuspended is NOT called here.
    // Suspended communities remain previewable; they cannot be joined (redeem guards it).

    const membership = await communityRepository.findMemberByUserId(
      community.id,
      callerId
    );
    if (membership?.status === CommunityMemberStatus.BANNED) {
      throw new ForbiddenError("COMMUNITY_JOIN_BANNED");
    }
    const isJoined = membership?.status === CommunityMemberStatus.ACTIVE;

    const avatarView = await communityImageService.resolveViewUrlForClient(
      community.avatarUrl
    );
    const coverView = await communityImageService.resolveViewUrlForClient(
      community.coverUrl
    );

    return {
      communityId: community.id,
      communityName: community.name,
      description: community.description ?? null,
      avatarUrl: avatarView?.url ?? null,
      bannerUrl: coverView?.url ?? null,
      memberCount: community.memberCount,
      communityType: community.type,
      isJoined,
      invitationCode: code,
      inviteUrl: buildInviteUrl(code),
      appDeepLink: `aimess://invite/${code}`,
      expiresAt: link.expiresAt ? link.expiresAt.getTime() : null,
      creatorId: link.createdBy,
    };
  },
};
