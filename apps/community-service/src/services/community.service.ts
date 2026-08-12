import { randomBytes, randomUUID } from "node:crypto";

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from "@aimess/errors";
import { logger } from "@aimess/logger";
import { isHiddenSystemMessage } from "@aimess/constants";
import { publishChatUserEvent, publishCommunityRoomEvent } from "@aimess/redis";
import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import type {
  CommunityAddedPayload,
  CommunityClosedPayload,
  CommunityJoinRequestUpdatedSocketPayload,
  CommunityMemberAddedPayload,
  CommunityMemberJoinedSocketPayload,
  CommunityMemberMutedSocketPayload,
  CommunityMemberRemovedPayload,
  CommunityMemberUnbannedPayload,
  CommunityMemberUnmutedSocketPayload,
  CommunityMemberUpdatedPayload,
  CommunityMetaDto,
  CommunityMetaUpdatedPayload,
  CommunityNotificationSettingUpdatedSocketPayload,
  CommunityReopenedPayload,
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
  deriveMembershipState,
  COMMUNITY_ROLE_RANK,
} from "../lib/community-authz.js";
import { communityAccessPolicy } from "../lib/community-access-policy.js";
import {
  assertInviteCreateRateLimit,
  assertInviteBulkSendRateLimit,
} from "../lib/invite-rate-limit.js";
import {
  buildPaginatedResponse,
  type PaginatedResponse,
} from "../lib/pagination.js";
import {
  isValidHandleFormat,
  normalizeHandle,
  normalizeName,
  slugifyCategoryName,
} from "../lib/community-slug.util.js";
import { COMMUNITY_MEMBER_LIMIT } from "../constants/index.js";
import { isMuteRowActive } from "../lib/community-notification-pref.js";
import { env } from "../config/env.js";
import {
  CommunityInviteStatus,
  CommunityJoinReqStatus,
  CommunityMemberRole,
  CommunityMemberStatus,
  CommunityModerationStatus,
  CommunityReportStatus,
  CommunityStatus,
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
  BulkInviteResult,
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
  PermanentInvitationLinkData,
  MyInviteData,
  MyJoinRequestData,
  MyReportData,
  PublicCommunityCard,
  PublicCommunityResponse,
} from "../types/community.types.js";
import { communityImageService } from "./community-image.service.js";
import { memberAvatarService } from "./member-avatar.service.js";
import { getChatClient } from "../grpc/chat.client.js";
import { getStreamClient } from "../grpc/stream.client.js";
import type { LiveStreamSummary } from "../types/community.types.js";
import {
  fetchAcceptedFriendIds,
  fetchExistingUserIds,
  fetchUserSnapshots,
  fetchUserSnapshotHits,
} from "../lib/user-client.js";
import type {
  CreateCommunityInput,
  UpdateCommunityInput,
} from "../api/validators/community.validator.js";
import {
  publishCommunityAdminTransferredSafe,
  publishCommunityClosedSafe,
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
  publishCommunityReopenedSafe,
  publishCommunityReportActionedSafe,
  publishCommunityReportCreatedSafe,
  publishCommunityReportResolvedSafe,
} from "../messaging/publish-community.js";
import {
  publishCommunityCreatedForChatSafe,
  publishCommunityDeletedForChatSafe,
  publishCommunityInviteLinkSharedForChatSafe,
  publishCommunityMemberMuteSyncedForChatSafe,
  publishCommunityMemberMuteRetractedForChatSafe,
  publishCommunityStatusChangedForChatSafe,
  publishCommunitySystemMessageForChatSafe,
  publishCommunitySystemMessageForChatAwaited,
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
const PREFIXED_ACTIVITY_TYPES = new Set(["message", "edited", "deleted"]);

/**
 * SYSTEM / lifecycle activity types: the stored preview is a complete,
 * self-describing sentence (e.g. "Community photo updated", "John Doe became
 * admin", "John Doe joined the community"). These MUST be shown standalone in the
 * community list — NEVER prefixed with a sender name. This single set is the
 * source of truth for the no-prefix rule; `buildLastActivity` forces
 * `username: null` for every member of it so the Mine/List/Search/Summary DTOs
 * can never leak a "Someone: <system text>" prefix.
 *
 * "reaction" is a valid {@link CommunityLastActivityType} value but is NEVER
 * written to the canonical `lastActivityType` column — it lives entirely in
 * the separate reaction OVERLAY (`lastActivityReaction*` columns), rendered by
 * {@link applyReactionOverlay} below, never by `buildLastActivity`/
 * `selectListPreview`. Listed here only so the DTO union stays complete.
 */
const SENDERLESS_ACTIVITY_TYPES = new Set([
  "system",
  "created",
  "join",
  "removal",
  "pinned",
  "unpinned",
  "reaction",
]);

/**
 * Denormalized `lastActivityType` values that must NEVER surface as the community
 * list preview (membership/moderation churn). Mirror of the chat-layer
 * `isEligibleForLastActivity` rule at the community-service denormalization layer:
 * going forward these are never WRITTEN (kick/ban no longer call updateLastActivity
 * and the churn SYSTEM types don't bump), so this set only neutralizes LEGACY rows
 * persisted before the rule. "join" has its own per-viewer handling in
 * selectListPreview, so it is not included here.
 */
const LAST_ACTIVITY_INELIGIBLE_TYPES = new Set(["removal"]);

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
 * the subject sees that "You …" line; everyone else must NOT see a join line
 * (returns null). Returns null only when there is no stored preview.
 *
 * The `lastActivityTargetUserId`/`lastActivityTargetPreview` pair exists for a
 * future second self-referential viewer in the role-change/join family; no
 * current caller sets it (reactions used to, but no longer do — see
 * {@link applyReactionOverlay} for the fully separate reaction mechanism).
 *
 * Exported for unit coverage (community-self-preview.test.ts).
 */
export function selectListPreview(
  row: {
    lastActivityType?: string | null;
    lastActivityPreview?: string | null;
    lastActivitySelfPreview?: string | null;
    lastActivityUserId?: string | null;
    lastActivityTargetUserId?: string | null;
    lastActivityTargetPreview?: string | null;
  },
  viewerId: string
): string | null {
  if (
    row.lastActivitySelfPreview !== null &&
    row.lastActivitySelfPreview !== undefined &&
    row.lastActivityUserId === viewerId
  ) {
    return row.lastActivitySelfPreview;
  }
  if (
    row.lastActivityTargetPreview &&
    row.lastActivityTargetUserId === viewerId
  ) {
    return row.lastActivityTargetPreview;
  }
  if (row.lastActivityType === "join" && row.lastActivityUserId === viewerId) {
    return SELF_JOIN_ACTIVITY_PREVIEW;
  }
  // Join is private to the joiner — admins and other members must not see
  // "<name> joined the community" in GET /communities/mine (legacy rows too).
  if (row.lastActivityType === "join" && row.lastActivityUserId !== viewerId) {
    return null;
  }
  return row.lastActivityPreview ?? null;
}

/** The "no message behind this activity" identity block — see CommunityLastActivity. */
const EMPTY_ACTIVITY_IDENTITY = {
  messageId: "",
  clientMessageId: null,
  seq: 0,
  senderId: null,
  contentType: "",
} as const;

export function buildLastActivity(community: {
  lastActivityAt: Date;
  lastActivityType?: string | null;
  lastActivityPreview?: string | null;
  lastActivityUsername?: string | null;
  lastActivityUserId?: string | null;
  lastActivityMessageId?: string | null;
  lastActivityClientMessageId?: string | null;
  lastActivitySeq?: number | null;
  lastActivityContentType?: string | null;
  createdAt: Date;
}): CommunityLastActivity {
  const rawType = community.lastActivityType ?? "created";
  // Identity of the message behind the activity, carried on BOTH branches
  // below: a SYSTEM/lifecycle row forces `userId` to null (so the client never
  // prefixes the preview with a name) but still has a real message behind it,
  // and an offline client needs that identity to merge deterministically.
  const identity = {
    messageId: community.lastActivityMessageId ?? "",
    clientMessageId: community.lastActivityClientMessageId ?? null,
    seq: community.lastActivitySeq ?? 0,
    senderId: community.lastActivityUserId ?? null,
    contentType: community.lastActivityContentType ?? "",
  };

  // Legacy ineligible activity (e.g. a "X was removed" line written by an old
  // kick/ban build before the eligibility rule): never surface it as the preview.
  // We can't recover the prior eligible message from the single denormalized
  // column, so fall back to the senderless "created" baseline (Case 4); the next
  // eligible message replaces it. Going forward such lines are never written.
  if (LAST_ACTIVITY_INELIGIBLE_TYPES.has(rawType)) {
    return {
      type: "created",
      userId: null,
      username: null,
      // MUST match buildCommunitySystemFallbackText("COMMUNITY_CREATED") — single source of truth.
      preview: "Community created",
      dateTime: community.createdAt.getTime(),
      ...EMPTY_ACTIVITY_IDENTITY,
    };
  }

  // USER MESSAGE → carry the sender so the client renders "<sender>: <preview>".
  if (PREFIXED_ACTIVITY_TYPES.has(rawType)) {
    return {
      type: rawType as "message" | "edited" | "deleted",
      userId: community.lastActivityUserId ?? null,
      username: community.lastActivityUsername ?? "",
      preview: community.lastActivityPreview ?? "",
      dateTime: community.lastActivityAt.getTime(),
      ...identity,
    };
  }

  // SYSTEM / lifecycle (and any unknown/legacy type → safe "created" default):
  // standalone sentence, NEVER prefixed → username is forced to null.
  const systemType = (
    SENDERLESS_ACTIVITY_TYPES.has(rawType) ? rawType : "created"
  ) as
    | "system"
    | "created"
    | "join"
    | "removal"
    | "pinned"
    | "unpinned"
    | "reaction";
  const dateTime =
    systemType === "created"
      ? community.createdAt.getTime()
      : community.lastActivityAt.getTime();
  return {
    type: systemType,
    userId: null,
    username: null,
    // Null-preview fallback MUST match the canonical builder — see buildCommunitySystemFallbackText.
    // This branch is only reached when lastActivityPreview has not yet been written
    // (race: community was just created and the async community.activity event hasn't
    // landed yet). Using the canonical text here means Chat Room / Mine / List / Socket
    // all show the same string while the async write catches up.
    preview:
      community.lastActivityPreview ??
      (systemType === "created" ? "Community created" : ""),
    dateTime,
    ...(systemType === "created" ? EMPTY_ACTIVITY_IDENTITY : identity),
  };
}

/**
 * Per-viewer PERSONAL overlay for the community-list lastActivity. The caller's
 * own private line ("You joined the community") replaces the community-wide
 * lastActivity when it is strictly newer. Because `personal` is ALWAYS the
 * caller's own line (chat-service scopes it by `visibleToUserId === userId`),
 * this can never surface one member's join to another: admins / moderators /
 * other members receive no `personal` line and keep the community-wide activity.
 *
 * Returns the community-wide base unchanged when there is no newer personal line.
 * Exported for unit coverage (community-self-preview.test.ts).
 */
export function applyPersonalLastActivityOverlay(
  base: { lastActivity: CommunityLastActivity; lastActivityAt: number },
  personal: { message: string; dateTime: number } | null | undefined
): { lastActivity: CommunityLastActivity; lastActivityAt: number } {
  if (personal && personal.message && personal.dateTime > base.lastActivityAt) {
    return {
      lastActivity: {
        type: "system",
        userId: null,
        username: null,
        preview: personal.message,
        dateTime: personal.dateTime,
        ...EMPTY_ACTIVITY_IDENTITY,
      },
      lastActivityAt: personal.dateTime,
    };
  }
  return base;
}

/** chat-service's per-viewer last message → the rendered CommunityLastActivity:
 *  sender-less SYSTEM shape, else the "username: preview" member-message shape. */
export function chatLastMessageToActivity(chat: {
  username: string;
  message: string;
  dateTime: number;
  isSystem?: boolean;
  userId?: string;
}): CommunityLastActivity {
  return chat.isSystem
    ? {
        type: "system",
        userId: null,
        username: null,
        preview: chat.message,
        dateTime: chat.dateTime,
        ...EMPTY_ACTIVITY_IDENTITY,
      }
    : {
        type: "message",
        userId: chat.userId || null,
        username: chat.username,
        preview: chat.message,
        dateTime: chat.dateTime,
        ...EMPTY_ACTIVITY_IDENTITY,
        senderId: chat.userId || null,
      };
}

/** The empty per-viewer state: the viewer has hidden every visible message. A
 *  sender-less, timestamp-zero system line so any real personal line (e.g. "You
 *  joined the community") still wins the subsequent personal overlay. */
export function emptyLastActivity(): {
  lastActivity: CommunityLastActivity;
  lastActivityAt: number;
} {
  return {
    lastActivity: {
      type: "system",
      userId: null,
      username: null,
      preview: "",
      dateTime: 0,
      ...EMPTY_ACTIVITY_IDENTITY,
    },
    lastActivityAt: 0,
  };
}

/**
 * NEWEST-WINS reconciliation for the `perUserResolved=false` case (the viewer did
 * NOT hide the shared last): the denormalized `Community.lastActivity*` column is
 * the rich base, but a STRICTLY-NEWER chat message overrides it — which repairs a
 * dropped `community.activity` event that left the column behind (missed-ADD).
 *
 * NOTE: this only repairs missed-ADD (chat newer than column). A dropped
 * delete-for-EVERYONE event (column stale-NEWER than the rolled-back shared last)
 * is NOT repaired here and remains a residual until the next activity event — the
 * overlay is structurally incapable of moving the pointer backward (true fix =
 * a community.activity DLQ, out of scope). The authoritative per-viewer
 * delete-for-me case is handled separately via `perUserResolved`, NOT this fn.
 *
 * `lastActivityAt` shifts to the chat dateTime for DISPLAY only; pagination keeps
 * using the stored `row.lastActivityAt`. Exported for unit coverage.
 */
export function applyChatLastMessageOverlay(
  base: { lastActivity: CommunityLastActivity; lastActivityAt: number },
  chat:
    | {
        username: string;
        message: string;
        dateTime: number;
        isSystem?: boolean;
        userId?: string;
      }
    | null
    | undefined
): { lastActivity: CommunityLastActivity; lastActivityAt: number } {
  if (!chat || !chat.message || chat.dateTime <= base.lastActivityAt) {
    return base;
  }
  return {
    lastActivity: chatLastMessageToActivity(chat),
    lastActivityAt: chat.dateTime,
  };
}

/**
 * The reaction OVERLAY: a reaction is fully independent of every other
 * lastActivity source (canonical column, chat-message overlay, personal-join
 * overlay) — it never touches any of them. It is visible ONLY to its own
 * actor and (if different) the reacted-to message's owner, and ONLY while it
 * is genuinely the newest thing (`lastActivityReactionAt > base.lastActivityAt`
 * — the same NEWEST-WINS pattern as {@link applyChatLastMessageOverlay}). A
 * real message/system event sent after the reaction silently supersedes it
 * with no explicit clearing needed; removing the reaction explicitly clears
 * `lastActivityReactionAt` (see community.repository.ts's
 * clearReactionActivityIfCurrent), which also makes this a no-op.
 *
 * Every other viewer (not the actor, not the target) ALWAYS falls through to
 * `base` unchanged — this is what makes a reaction invisible to the rest of
 * the community regardless of recency.
 *
 * Exported for unit coverage (community-reaction-activity.test.ts).
 */
export function applyReactionOverlay(
  base: { lastActivity: CommunityLastActivity; lastActivityAt: number },
  row: {
    lastActivityReactionAt?: Date | null;
    lastActivityReactionActorId?: string | null;
    lastActivityReactionActorPreview?: string | null;
    lastActivityReactionTargetId?: string | null;
    lastActivityReactionTargetPreview?: string | null;
  },
  viewerId: string
): { lastActivity: CommunityLastActivity; lastActivityAt: number } {
  if (!row.lastActivityReactionAt) return base;
  const reactionAt = row.lastActivityReactionAt.getTime();
  if (reactionAt <= base.lastActivityAt) return base;

  const preview =
    row.lastActivityReactionActorId === viewerId
      ? row.lastActivityReactionActorPreview
      : row.lastActivityReactionTargetId === viewerId
        ? row.lastActivityReactionTargetPreview
        : null;
  if (!preview) return base;

  return {
    lastActivity: {
      type: "reaction",
      userId: null,
      username: null,
      preview,
      dateTime: reactionAt,
      ...EMPTY_ACTIVITY_IDENTITY,
    },
    lastActivityAt: reactionAt,
  };
}

/**
 * Telegram-style mapping from the set of community fields that actually changed
 * in one `update()` call to the ONE system-message subtype to post:
 *   - 0 fields            → null (nothing changed worth a line)
 *   - exactly 1 field     → its dedicated specific subtype where one exists
 *                           (name / description / avatar / banner / handle),
 *                           else the generic COMMUNITY_UPDATED ("Community
 *                           settings updated")
 *   - 2+ fields           → one collapsed COMMUNITY_UPDATED ("Community settings
 *                           updated") — see the LIMITATION note on `update()`
 *                           for why this stays a single line instead of one per
 *                           changed field.
 *
 * `banner` has no producer in {@link detectCommunityChangedFields} today (no
 * cover/banner upload field exists on `UpdateCommunityInput` yet) — the mapping
 * is kept here as forward-compatible scaffolding but is currently unreachable.
 *
 * Single source of truth for the "specific-or-collapsed" rule; exported for unit
 * coverage (community-update-system-message.test.ts).
 */
const COMMUNITY_UPDATE_SINGLE_FIELD_SUBTYPE: Record<string, string> = {
  name: "COMMUNITY_NAME_UPDATED",
  description: "COMMUNITY_DESCRIPTION_UPDATED",
  avatar: "COMMUNITY_AVATAR_UPDATED",
  banner: "COMMUNITY_BANNER_UPDATED",
  handle: "COMMUNITY_HANDLE_UPDATED",
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

/**
 * Map the changed-field strings from {@link detectCommunityChangedFields}
 * ("name" | "description" | "avatar" | "visibility" | "category" | "handle") to
 * the boolean `changes` shape of `community:meta:updated`. Single source of
 * truth — the same array that picks the system-message subtype drives the socket
 * event, so the two can never disagree. Exported for unit coverage.
 */
export function changedFieldsToMetaChanges(
  changedFields: string[]
): CommunityMetaUpdatedPayload["changes"] {
  const changes: CommunityMetaUpdatedPayload["changes"] = {};
  for (const field of changedFields) {
    switch (field) {
      case "name":
        changes.name = true;
        break;
      case "description":
        changes.description = true;
        break;
      case "avatar":
        changes.avatar = true;
        break;
      case "visibility":
        changes.visibility = true;
        break;
      case "category":
        changes.category = true;
        break;
      case "handle":
        changes.handle = true;
        break;
      default:
        break;
    }
  }
  return changes;
}

/**
 * Build the canonical post-update metadata snapshot carried by
 * `community:meta:updated`. Resolves the avatar through the same
 * key→presigned-URL resolver the REST detail response uses — never hand-roll a
 * URL and never emit a raw object key.
 */
async function toCommunityMetaDto(
  community: CommunityWithCategory
): Promise<CommunityMetaDto> {
  const avatarView = await communityImageService.resolveViewUrlForClient(
    community.avatarUrl
  );
  return {
    communityId: community.id,
    name: community.name,
    handle: community.handle,
    description: community.description,
    avatar: avatarView?.url ?? null,
    type: community.type as "PUBLIC" | "PRIVATE",
    categoryId: community.category.id,
    categoryName: community.category.name,
    memberCount: community.memberCount,
    updatedAt:
      community.updatedAt instanceof Date
        ? community.updatedAt.getTime()
        : Date.now(),
  };
}

/**
 * Fan out `community:meta:updated` after a metadata change. Delivered to:
 *   1. the `community:<id>` room — detail/header/chat viewers update live;
 *   2. every ACTIVE member's `user:<id>` channel — list rows update name/avatar
 *      even when the member isn't currently viewing the community.
 * Fire-and-forget: a socket-publish failure must never fail the write itself
 * (the REST response + recovery reads remain the source of truth).
 */
async function broadcastCommunityMetaUpdated(
  community: CommunityWithCategory,
  changedFields: string[]
): Promise<void> {
  if (changedFields.length === 0) return;
  try {
    const dto = await toCommunityMetaDto(community);
    const payload: CommunityMetaUpdatedPayload = {
      communityId: community.id,
      changes: changedFieldsToMetaChanges(changedFields),
      community: dto,
      // Idempotency key = the persisted row mtime (stable + monotonic per write),
      // not wall-clock now() — so a redelivery/duplicate dedupes on the client.
      updatedAt: dto.updatedAt,
    };
    await publishCommunityRoomEvent(
      redis,
      community.id,
      "community:meta:updated",
      payload
    );
    const memberIds = await communityRepository.findActiveMemberIds(
      community.id
    );
    await Promise.allSettled(
      memberIds.map((memberId) =>
        publishChatUserEvent(redis, memberId, "community:meta:updated", payload)
      )
    );
  } catch (error) {
    logger.warn(
      `community:meta:updated broadcast failed for community=${community.id}: ${String(error)}`
    );
  }
}

async function toCommunityData(
  community: CommunityWithCategory,
  myRole: CommunityMemberRole | null,
  muteRow: MuteRowFragment,
  joinRequest: { id: string; status: CommunityJoinReqStatus } | null = null,
  liveStreams: LiveStreamSummary[] = [],
  callerModerationMute: { mutedUntil: Date | null } | null = null,
  currentUserIsStreaming = false,
  isBanned = false
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
    // Kicked members are plain non-members now (no restricted-access read
    // view) — the field survives on the wire for backward compat only.
    isKicked: false,
    // Same shared derivation as the list API and the personal socket events —
    // see deriveMembershipState. `myRole` is non-null only for ACTIVE, so
    // this reproduces the previous inline expressions exactly.
    ...deriveMembershipState(
      isBanned
        ? { status: CommunityMemberStatus.BANNED }
        : myRole !== null
          ? { status: CommunityMemberStatus.ACTIVE }
          : null
    ),
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
    ...livestreamFields(liveStreams.length),
    liveStreams,
    currentUserIsStreaming,
    status: communityAccessPolicy.deriveStatus(community),
    createdAt: community.createdAt.toISOString(),
    updatedAt: community.updatedAt.toISOString(),
    lastActivity: buildLastActivity(community),
    isMemberMuted: callerModerationMute !== null,
    memberMutedUntil: callerModerationMute?.mutedUntil?.toISOString() ?? null,
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
  muteUntilMs: number | null;
  streamEnabled: boolean;
  chatEnabled: boolean;
  announcementEnabled: boolean;
} {
  const muted = isMuteRowActive(muteRow);
  return {
    isMuted: muted,
    muteUntil: muteRow?.mutedUntil ? muteRow.mutedUntil.toISOString() : null,
    // Epoch-ms mirror (§6). ISO string above kept for existing clients.
    muteUntilMs: muteRow?.mutedUntil ? muteRow.mutedUntil.getTime() : null,
    streamEnabled: muteRow?.streamEnabled ?? true,
    chatEnabled: muteRow?.chatEnabled ?? true,
    announcementEnabled: muteRow?.announcementEnabled ?? true,
  };
}

/**
 * Notify the caller's OTHER devices/tabs that their own notification-mute
 * toggle changed for a community — self-service setting, so only the acting
 * user's `user:<id>` channel gets it (never the community room).
 */
function publishNotificationMuteChanged(
  communityId: string,
  callerId: string,
  notificationsMuted: boolean
): void {
  const payload: CommunityNotificationSettingUpdatedSocketPayload = {
    communityId,
    notificationsMuted,
    updatedAt: Date.now(),
  };
  publishChatUserEvent(
    redis,
    callerId,
    "community:notification-setting-updated",
    payload
  ).catch((error) => {
    logger.warn(
      `community:notification-setting-updated publish failed for community=${communityId} user=${callerId}: ${String(error)}`
    );
  });
}

/** Platform cap on concurrent LIVE streams per community (see stream-service). */
const MAX_ACTIVE_LIVESTREAMS = 5;

/**
 * Derive the list/detail livestream fields from a community's LIVE stream count.
 * `isLive` is retained for backward compatibility (=== hasActiveLivestream); the
 * count is clamped to the platform cap so the wire never reports more than 5.
 */
function livestreamFields(liveCount: number): {
  isLive: boolean;
  hasActiveLivestream: boolean;
  activeLivestreamCount: number;
  liveStreamCount: number;
} {
  const count = Math.min(Math.max(0, liveCount), MAX_ACTIVE_LIVESTREAMS);
  return {
    isLive: count > 0,
    hasActiveLivestream: count > 0,
    activeLivestreamCount: count,
    liveStreamCount: count,
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
    status?: CommunityStatus | null;
    category: { id: string; name: string };
  },
  muteRow: MuteRowFragment,
  isJoined: boolean,
  hasRequested: boolean,
  liveCount = 0,
  viewerId?: string,
  currentUserIsStreaming = false,
  isBanned = false
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
    isBanned,
    // Backward-compat only — kicked members are plain non-members now.
    isKicked: false,
    membershipStatus: isBanned ? "BANNED" : isJoined ? "ACTIVE" : "NONE",
    hasRequested,
    ...muteFields(muteRow),
    ...livestreamFields(liveCount),
    currentUserIsStreaming,
    moderationStatus: community.moderationStatus,
    status: communityAccessPolicy.deriveStatus(community),
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
  profileUnavailable?: boolean;
  bannedAt?: Date | null;
  bannedBy?: string | null;
  banReason?: string | null;
  mutedAt?: Date | null;
  mutedBy?: string | null;
  mutedUntil?: Date | null;
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
    profileUnavailable: member.profileUnavailable ?? false,
    bannedAt: member.bannedAt ? member.bannedAt.toISOString() : null,
    bannedBy: member.bannedBy ?? null,
    banReason: member.banReason ?? null,
    mutedAt: member.mutedAt ? member.mutedAt.toISOString() : null,
    mutedBy: member.mutedBy ?? null,
    mutedUntil: member.mutedUntil ? member.mutedUntil.toISOString() : null,
    // Single-field convenience flag (Phase 8): true while a moderation mute is
    // effective. Callers that don't populate the mute fields (most mutation
    // responses) get `false` — the authoritative mute view is the member roster
    // (`GET /:id/members`), the muted-members list, and the mute socket events.
    isMuted:
      member.mutedAt != null &&
      (member.mutedUntil == null || member.mutedUntil.getTime() > Date.now()),
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

/**
 * Short, human-friendly display id derived deterministically from the report's
 * Mongo ObjectId (clients render it as e.g. "#99421"). Stable per report — no
 * counter collection or migration required.
 */
function deriveReportDisplayId(reportId: string): string {
  const hex = reportId.replace(/[^0-9a-f]/gi, "").slice(-6) || "0";
  const n = parseInt(hex, 16) % 100000;
  return String(n).padStart(5, "0");
}

/**
 * Resolve the snapshotted reported-content media (RAW object keys persisted at
 * report time) into presigned {@link MediaObject}s. Community chat attachments
 * share `MINIO_BUCKET_COMMUNITY`. Never persists a resolved URL.
 */
function buildReportedContentMedia(media: unknown): Promise<MediaObject[]> {
  if (!Array.isArray(media)) return Promise.resolve([]);
  return Promise.all(
    media.map((raw) => {
      const m = (raw ?? {}) as {
        objectKey?: string | null;
        contentType?: string | null;
        fileName?: string | null;
        size?: number | null;
      };
      return toMediaObject({
        bucket: env.MINIO_BUCKET_COMMUNITY,
        stored: m.objectKey ?? null,
        prefixes: [],
        strategy: mediaUrlStrategy,
        contentType: m.contentType ?? null,
        fileName: m.fileName ?? null,
        size: m.size ?? null,
      });
    })
  );
}

async function toReportData(
  row: CommunityReport
): Promise<CommunityReportData> {
  return {
    reportId: row.id,
    displayId: deriveReportDisplayId(row.id),
    communityId: row.communityId,
    reporterId: row.reporterId,
    targetUserId: row.targetUserId,
    reason: row.reason,
    otherReason: row.otherReason ?? null,
    status: row.status,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    resolution: row.resolution,
    reportedMessageId: row.reportedMessageId ?? null,
    reportedContentType: row.reportedContentType ?? null,
    reportedContentText: row.reportedContentText ?? null,
    reportedContentPostedAt: row.reportedContentPostedAt
      ? row.reportedContentPostedAt.toISOString()
      : null,
    reportedContentMedia: await buildReportedContentMedia(
      row.reportedContentMedia
    ),
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
  status?: CommunityStatus | null;
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
    status: communityAccessPolicy.deriveStatus(community),
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

/**
 * Build the shareable HTTPS invite URL. Invite links are code-based (the PRIVATE
 * mechanism), so the path carries the Telegram-style `+` marker:
 * `https://aimess.me/+<code>` (Sharing & Deep-Linking spec §9.5). base64url codes
 * never contain `+`, so the prefix is an unambiguous private-link marker that
 * `detectLink()` strips on the client. Falls back to the bare code when no base
 * URL is configured (local/dev).
 */
function buildInviteUrl(code: string): string {
  return env.INVITE_LINK_BASE_URL
    ? `${env.INVITE_LINK_BASE_URL}/+${code}`
    : code;
}

/** App deep-link for an invite code: `aimess://join?code=<code>` (spec §4.1/§9.5). */
function buildInviteDeepLink(code: string): string {
  return `aimess://join?code=${encodeURIComponent(code)}`;
}

/**
 * Build the canonical HTTPS share URL for a PUBLIC community handle:
 * `https://aimess.me/<handle>` (Sharing & Deep-Linking spec §9.5). Unlike the
 * code-based PRIVATE invite URL there is NO `+` marker — a bare first segment is
 * the public-handle case that `detectLink()` resolves to PUBLIC. Falls back to
 * the bare handle when no base URL is configured (local/dev), mirroring
 * `buildInviteUrl`.
 */
function buildPublicShareUrl(handle: string): string {
  return env.INVITE_LINK_BASE_URL
    ? `${env.INVITE_LINK_BASE_URL}/${handle}`
    : handle;
}

/** App deep-link for a public handle: `aimess://resolve?handle=<handle>` (spec §4.1/§9.5). */
function buildPublicDeepLink(handle: string): string {
  return `aimess://resolve?handle=${encodeURIComponent(handle)}`;
}

/**
 * Single source of truth for a community's PRIMARY shareable link. The link
 * mechanism is driven by the community's privacy, NOT by which endpoint produced
 * it — so create / list / revoke / bulk-send / redeem all return a consistent URL:
 *
 *  • PUBLIC  → handle-based, deterministic, and independent of the invite row's
 *              `code`/`linkId`/expiry/usage. Anyone resolves it and joins directly.
 *  • PRIVATE → the existing invite-code-based link (non-guessable, revocable,
 *              usage/expiry-tracked). Unchanged from prior behavior.
 *
 * A PUBLIC community ALWAYS has a `handle` (non-null unique column set at
 * creation), so the missing-handle branch is a defensive guard that surfaces a
 * clear domain error rather than silently emitting a broken `<base>/` URL.
 */
function resolveCommunityShareLink(
  community: { type: CommunityType; handle: string },
  code: string
): {
  url: string;
  appDeepLink: string;
  linkType: CommunityInviteLinkData["linkType"];
} {
  if (community.type === CommunityType.PUBLIC) {
    const handle = community.handle?.trim();
    if (!handle) {
      throw new BadRequestError("COMMUNITY_HANDLE_REQUIRED");
    }
    return {
      url: buildPublicShareUrl(handle),
      appDeepLink: buildPublicDeepLink(handle),
      linkType: "PUBLIC_HANDLE",
    };
  }
  return {
    url: buildInviteUrl(code),
    appDeepLink: buildInviteDeepLink(code),
    linkType: "PRIVATE_INVITE",
  };
}

function toInviteLinkData(
  row: CommunityInviteLink,
  community: { type: CommunityType; handle: string }
): CommunityInviteLinkData {
  const now = Date.now();
  const isActive =
    !row.revokedAt &&
    (!row.expiresAt || row.expiresAt.getTime() > now) &&
    (row.maxUses === null || row.usedCount < row.maxUses);
  const share = resolveCommunityShareLink(community, row.code);
  return {
    linkId: row.id,
    code: row.code,
    url: share.url,
    appDeepLink: share.appDeepLink,
    linkType: share.linkType,
    communityId: row.communityId,
    createdBy: row.createdBy,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    autoApprove: row.autoApprove,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    isActive,
    isPermanent: false,
  };
}

/**
 * Build a `PermanentInvitationLinkData` DTO from a community that already has
 * its `invitationCode` set. Throws if called before the code is allocated
 * (guards against logic bugs — callers in this file always check first).
 */
function toPermanentInvitationLinkData(community: {
  id: string;
  name: string;
  invitationCode: string | null;
  invitationCodeCreatedAt: Date | null;
  createdAt: Date;
}): PermanentInvitationLinkData {
  if (!community.invitationCode) {
    throw new Error(
      `toPermanentInvitationLinkData called on community ${community.id} with no invitationCode`
    );
  }
  return {
    communityId: community.id,
    communityName: community.name,
    invitationCode: community.invitationCode,
    invitationLink: buildInviteUrl(community.invitationCode),
    appDeepLink: buildInviteDeepLink(community.invitationCode),
    createdAt: (
      community.invitationCodeCreatedAt ?? community.createdAt
    ).getTime(),
  };
}

/**
 * Synthesize a `CommunityInviteLinkData`-shaped object from a community's
 * permanent invitation code so that `redeemInviteLink` and `lookupInviteLink`
 * can return a consistent response shape for both regular links AND the
 * permanent community link without duplicating the rest of the join logic.
 *
 * Key invariants for permanent links:
 *  - `linkId` equals `communityId` (no real DB row exists for the permanent link)
 *  - `isPermanent: true` → clients should use this flag to detect permanent links, not parse linkId
 *  - `maxUses: null` → unlimited
 *  - `expiresAt: null` → never expires
 *  - `revokedAt: null` → never revoked
 *  - `autoApprove: false` → request-to-join (PRIVATE default)
 *  - `isActive: true` → always active (lifecycle managed on the Community row)
 */
function toPermanentLinkAsInviteLinkData(community: {
  id: string;
  type: CommunityType;
  handle: string;
  adminId: string;
  invitationCode: string;
  invitationCodeCreatedAt: Date | null;
  createdAt: Date;
}): CommunityInviteLinkData {
  const share = resolveCommunityShareLink(community, community.invitationCode);
  return {
    linkId: community.id,
    code: community.invitationCode,
    url: share.url,
    appDeepLink: share.appDeepLink,
    linkType: share.linkType,
    communityId: community.id,
    createdBy: community.adminId,
    maxUses: null,
    usedCount: 0,
    autoApprove: false,
    expiresAt: null,
    revokedAt: null,
    createdAt: (
      community.invitationCodeCreatedAt ?? community.createdAt
    ).toISOString(),
    isActive: true,
    isPermanent: true,
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

/** Resolved chat enrichment for one community: unread count + the viewer's
 *  own personal line (e.g. "You joined the community"), if any. */
type ChatEnrichment = {
  unreadMessageCount: number;
  /** Oldest unread message id, so the client can jump to it. Null iff unreadMessageCount === 0. */
  firstUnreadMessageId: string | null;
  /**
   * True => the viewer HID the community-wide shared last; `lastMessage` (or its
   * absence) is AUTHORITATIVE for this viewer — use it directly and CLEAR the
   * stale column preview when there is no lastMessage. False => `lastMessage` is
   * the plain shared snapshot, overlaid onto the column only-when-newer (repairs
   * lost-`community.activity`-event missed-ADD staleness).
   */
  perUserResolved: boolean;
  /**
   * chat-service's latest message visible to this viewer (community-wide last, or
   * their previous-visible when perUserResolved). Carries its REAL timestamp.
   * Absent when no visible message remains for the viewer.
   */
  lastMessage?: {
    username: string;
    message: string;
    dateTime: number;
    isSystem: boolean;
    userId: string;
  };
  /** The caller's latest personal SYSTEM line — overlaid onto lastActivity for
   *  the joiner only. Absent when the caller has no personal line. */
  personalLastMessage?: { message: string; dateTime: number };
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
      firstUnreadMessageId: s.firstUnreadMessageId ?? null,
      perUserResolved: Boolean(s.perUserResolved),
      lastMessage:
        s.hasLastMessage && s.lastMessage
          ? {
              username: s.lastMessage.username,
              message: s.lastMessage.message,
              dateTime: s.lastMessage.dateTime,
              isSystem: Boolean(s.lastMessage.isSystem),
              userId: s.lastMessage.userId ?? "",
            }
          : undefined,
      personalLastMessage: s.personalLastMessage
        ? {
            message: s.personalLastMessage.message,
            dateTime: s.personalLastMessage.dateTime,
          }
        : undefined,
    });
  }
  return map;
}

const EMPTY_CHAT_ENRICHMENT: ChatEnrichment = {
  unreadMessageCount: 0,
  firstUnreadMessageId: null,
  perUserResolved: false,
};

/**
 * Bulk LIVE-only stream count per community for the mine + discover lists. One
 * batched gRPC call backs both `isLive` (count > 0) and `liveStreamCount`.
 * Degrades to an empty map (→ count 0, isLive false) on stream-service failure.
 */
async function fetchLiveStreamCounts(
  communityIds: string[]
): Promise<Map<string, number>> {
  if (!communityIds.length) return new Map();
  return getStreamClient().getActiveStreamCounts(communityIds);
}

/**
 * Fetch the currently-LIVE streams for a single community.
 * Used by the community detail endpoint to populate liveStreams[].
 * Degrades to [] on stream-service failure.
 */
async function fetchCommunityLiveStreams(
  communityId: string
): Promise<LiveStreamSummary[]> {
  return getStreamClient().getLiveStreamsByCommunity(communityId);
}

/** A fully-loaded Community row as returned by the repository (never null). */
type CommunityRow = NonNullable<
  Awaited<ReturnType<typeof communityRepository.findById>>
>;

/** One `/mine` page row — the shared `mineActivitySelect` shape. */
type MineActivityRow = Awaited<
  ReturnType<typeof communityRepository.listMineByActivity>
>["rows"][number];

/**
 * Serialize a `/mine` page of raw community rows into `CommunityListItem`s —
 * the FULL enrichment shared verbatim by both pagination paths: `listMine`
 * (legacy inclusive timestamp bound) and `listMineKeyset` (compound exclusive
 * keyset cursor). Only the DB boundary + the emitted
 * `nextCursor` differ between the two; everything a client actually sees (chat
 * enrichment, mute/moderation state, live sender names, per-viewer lastActivity
 * reconciliation, livestream + streaming flags) is produced identically here.
 */
async function enrichMineCommunities(
  userId: string,
  pageRows: MineActivityRow[]
): Promise<CommunityListItem[]> {
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

  // Bulk-fetch chat enrichment, notification mute settings, moderation mutes,
  // live sender names, live status, and whether the caller is already streaming.
  const [
    chatMap,
    muteMap,
    modMuteMap,
    senderNameMap,
    liveCountMap,
    currentUserIsStreaming,
  ] = await Promise.all([
    fetchChatEnrichment(userId, communityIds),
    loadMuteMap(userId, communityIds),
    communityRepository.findCallerMutesByCommunityIds(userId, communityIds),
    communityRepository.getDisplayNamesByUserIds(senderIds),
    fetchLiveStreamCounts(communityIds),
    getStreamClient().checkCreatorHasActiveStream(userId),
  ]);

  return Promise.all(
    pageRows.map(async (row) => {
      const avatarView = await communityImageService.resolveViewUrlForClient(
        row.avatarUrl
      );
      const avatar = await buildCommunityImageMedia(row.avatarUrl);
      const chat = chatMap.get(row.id) ?? EMPTY_CHAT_ENRICHMENT;
      // A BANNED viewer's mine-list activity is capped at their ban — chat-service
      // already enforces this for lastActivity/lastMessage/unread (perUserResolved
      // forces the reconciledBase below to use its cutoff-clamped chat.lastMessage
      // instead of the unfiltered denormalized column). The reaction overlay and
      // livestream fields are sourced OUTSIDE chat-service though, so they need
      // their own cutoff guard here. A just-unbanned (LEFT, unbannedAt set)
      // viewer gets the same treatment capped at `unbannedAt`: the ban itself
      // is lifted, but they still have zero access until they rejoin, so they
      // must not see anything that happened after the unban either.
      const bannedAt =
        row.members[0]?.status === CommunityMemberStatus.BANNED
          ? (row.members[0].bannedAt ?? new Date(0))
          : row.members[0]?.status === CommunityMemberStatus.LEFT &&
              row.members[0]?.unbannedAt
            ? row.members[0].unbannedAt
            : null;

      // Per-viewer lastActivity (display-only; the pagination cursor still uses
      // the stored row.lastActivityAt so community-wide ordering is unchanged).
      // Two signals reconcile into a base, then the viewer's own "You joined"
      // personal line overlays when it is genuinely newest:
      //   - the denormalized community-wide column (rich lifecycle semantics), and
      //   - chat-service's per-viewer latest-visible message — AUTHORITATIVE when
      //     the viewer hid the shared last (perUserResolved), else a strictly-
      //     newer override that repairs missed-ADD lost-event staleness.
      const columnBase = {
        lastActivityAt: row.lastActivityAt.getTime(),
        lastActivity: buildLastActivity({
          ...row,
          // Prefer the live member-snapshot name; fall back to the stored
          // value when the sender has since left every community.
          lastActivityUsername:
            (row.lastActivityUserId
              ? senderNameMap.get(row.lastActivityUserId)
              : null) ?? row.lastActivityUsername,
          // Self-referential SYSTEM line (role change / join): the viewer who
          // IS the subject sees the first-person "You …" preview; everyone
          // else keeps the third-person text.
          lastActivityPreview: selectListPreview(row, userId),
        }),
      };
      // Per-viewer base preview:
      //  - perUserResolved => the viewer HID the community-wide last, so
      //    chat-service's resolution is AUTHORITATIVE: use their previous-visible
      //    (real timestamp), or CLEAR to empty when they have hidden everything.
      //    This never trusts the (now stale-for-them) column.
      //  - else => the rich column is the base; a strictly-newer chat message
      //    overrides it (repairs missed-ADD lost-event staleness).
      const reconciledBase = chat.perUserResolved
        ? chat.lastMessage
          ? {
              lastActivity: chatLastMessageToActivity(chat.lastMessage),
              lastActivityAt: chat.lastMessage.dateTime,
            }
          : emptyLastActivity()
        : applyChatLastMessageOverlay(columnBase, chat.lastMessage);
      // Reaction overlay: visible ONLY to the reaction's own actor/target,
      // and ONLY while it is genuinely newer than everything else above —
      // see applyReactionOverlay's doc for why this fully replaces the old
      // "reaction via selectListPreview" mechanism. A reaction recorded AFTER
      // the viewer's ban is never shown to them (read cutoff applies here too).
      const reactionAfterBan =
        bannedAt != null &&
        row.lastActivityReactionAt != null &&
        row.lastActivityReactionAt.getTime() > bannedAt.getTime();
      const reactionOverlaid = reactionAfterBan
        ? reconciledBase
        : applyReactionOverlay(reconciledBase, row, userId);
      // The viewer's own "You joined the community" personal line still wins
      // when it is genuinely the newest visible thing (compared against the
      // base's REAL timestamp — no +1ms inflation can wrongly suppress it).
      const { lastActivity, lastActivityAt } = applyPersonalLastActivityOverlay(
        reactionOverlaid,
        chat.personalLastMessage
      );

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
        lastActivityAt,
        unreadMessageCount: chat.unreadMessageCount,
        firstUnreadMessageId: chat.firstUnreadMessageId,
        lastActivity,
        ...muteFields(muteMap.get(row.id) ?? null),
        // A banned member no longer has realtime standing in the community —
        // livestream state (inherently "right now", not historical) is hidden
        // outright rather than reconstructed as of the ban.
        ...livestreamFields(bannedAt ? 0 : (liveCountMap.get(row.id) ?? 0)),
        currentUserIsStreaming,
        moderationStatus: row.moderationStatus,
        status: communityAccessPolicy.deriveStatus(row),
        isMemberMuted: modMuteMap.has(row.id),
        memberMutedUntil:
          modMuteMap.get(row.id)?.mutedUntil?.toISOString() ?? null,
        // Backward-compat only — kicked members no longer appear in this list.
        isKicked: false,
        // isJoined / isBanned / membershipStatus all come from the ONE shared
        // derivation the detail API and the personal socket events also use,
        // so a listed row can never disagree with a fresh GET or with the
        // realtime event that announced the transition.
        ...deriveMembershipState(row.members[0]),
      };
    })
  );
}

export const communityService = {
  async listCategories(): Promise<CommunityCategoryData[]> {
    return communityRepository.listActiveCategories();
  },

  async listCategoriesAdmin(query: {
    search?: string;
    status?: "visible" | "hidden" | "all";
    page: number;
    limit: number;
    sortField?: "name" | "order" | "createdAt" | "communityCount";
    sortDir?: "asc" | "desc";
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
      sortField: query.sortField,
      sortDir: query.sortDir,
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
        communityCount: c.communityCount,
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
      communityCount: 0, // brand new — no community can reference it yet
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

    const [updated, communityCount] = await Promise.all([
      communityRepository.updateCategoryById(id, updates),
      communityRepository.countActiveCommunitiesWithCategory(id),
    ]);
    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      visible: updated.active,
      order: updated.order,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      communityCount,
    };
  },

  /**
   * Soft-delete (mirrors `Community.deletedAt`) when the category is still
   * referenced by (non-active) communities — the FK would otherwise dangle;
   * hard-delete otherwise. Returns which branch was taken so callers can
   * report it. Blocked entirely (409) while any ACTIVE, non-deleted
   * community still points at this category.
   */
  async deleteCategory(id: string): Promise<{ softDeleted: boolean }> {
    const category = await communityRepository.findCategoryByIdAdmin(id);
    if (!category) throw new NotFoundError("CATEGORY_NOT_FOUND");

    const activeCount =
      await communityRepository.countActiveCommunitiesWithCategory(id);
    if (activeCount > 0) {
      throw new ConflictError("CATEGORY_HAS_ACTIVE_COMMUNITIES");
    }

    const inUse = await communityRepository.countCommunitiesWithCategory(id);
    if (inUse > 0) {
      await communityRepository.softDeleteCategoryById(id);
      return { softDeleted: true };
    }

    await communityRepository.deleteCategoryById(id);
    return { softDeleted: false };
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
    // A BANNED member can still fetch the details view — the community stays
    // visible in their list (visibility axis) and the FE renders the banned
    // state from `membershipStatus`/`isBanned`. Every OTHER surface (messages,
    // media, send, react, socket room) rejects BANNED with USER_BANNED
    // (permission axis — see chat-service access-guard). A kicked member
    // (LEFT + removedAt audit marker) is a plain non-member here: normal
    // public preview + join flow.
    const isBanned = membership?.status === CommunityMemberStatus.BANNED;
    // Only an ACTIVE membership confers a role; LEFT/BANNED are treated as
    // non-members for role purposes (myRole = null).
    const myRole =
      membership && membership.status === CommunityMemberStatus.ACTIVE
        ? membership.role
        : null;

    // Fetch notification mute row, join request, live streams, caller's
    // moderation mute, and whether the caller is already streaming somewhere.
    const [
      muteRow,
      joinRequest,
      liveStreams,
      callerModerationMute,
      currentUserIsStreaming,
    ] = await Promise.all([
      communityRepository.findMuteByUserAndCommunity(callerId, id),
      // A BANNED user can't have a live join request (the ban supersedes it);
      // skip the lookup rather than surface a stale pre-ban request row. A
      // kicked/left caller CAN have one — they rejoin via the normal flow.
      myRole === null && !isBanned
        ? communityRepository.findJoinRequestByCommunityAndUser(id, callerId)
        : Promise.resolve(null),
      fetchCommunityLiveStreams(id),
      myRole !== null
        ? communityRepository.findActiveMemberMute(id, callerId)
        : Promise.resolve(null),
      getStreamClient().checkCreatorHasActiveStream(callerId),
    ]);

    return toCommunityData(
      community,
      myRole,
      muteRow,
      joinRequest,
      liveStreams,
      callerModerationMute,
      currentUserIsStreaming,
      isBanned
    );
  },

  /**
   * Public deep-link resolver — `GET /communities/by-handle/:handle`.
   *
   * PUBLIC-only by design (Sharing & Deep-Linking spec §9.1): a private
   * community's handle resolves to 404 so this surface NEVER reveals a private
   * community's existence or metadata. A suspended or soft-deleted community is
   * likewise 404 ("not available"). A banned caller gets 403.
   */
  async getByHandle(
    handle: string,
    callerId: string
  ): Promise<PublicCommunityResponse> {
    const canonical = normalizeHandle(handle);
    if (!isValidHandleFormat(canonical)) {
      throw new BadRequestError("INVALID_HANDLE");
    }

    const community = await communityRepository.findByHandleFull(canonical);
    // Collapse "missing", "private", and "not-available" (owner-CLOSED or
    // platform-SUSPENDED) into a single 404 so the response is identical whether
    // the community doesn't exist or is simply not publicly resolvable — no
    // oracle for private-community discovery, and no "join" CTA for a community
    // that can't be joined.
    if (
      !community ||
      community.type !== CommunityType.PUBLIC ||
      communityAccessPolicy.isEffectivelyClosed(community)
    ) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      community.id,
      callerId
    );
    // Banned ⇒ 403 (no body), matching getById and the spec's BANNED state.
    assertNotBanned(membership);
    const isActive = membership?.status === CommunityMemberStatus.ACTIVE;

    const [avatarView, coverView] = await Promise.all([
      communityImageService.resolveViewUrlForClient(community.avatarUrl),
      communityImageService.resolveViewUrlForClient(community.coverUrl),
    ]);

    return {
      communityId: community.id,
      handle: community.handle,
      name: community.name,
      description: community.description ?? null,
      avatarUrl: avatarView?.url ?? null,
      bannerUrl: coverView?.url ?? null,
      memberCount: community.memberCount,
      type: "PUBLIC",
      shareUrl: buildPublicShareUrl(community.handle),
      appDeepLink: buildPublicDeepLink(community.handle),
      isJoined: isActive,
      role: isActive ? membership.role : null,
      isBanned: false,
    };
  },

  /**
   * Unauthenticated PUBLIC-only metadata card for the gateway's server-rendered
   * link preview (OG unfurl). No caller, no membership, no ban logic — it must
   * never reveal a private/suspended community (→ 404). Consumed internally over
   * a shared-secret-guarded route, never exposed to clients.
   */
  async getPublicCard(handle: string): Promise<PublicCommunityCard> {
    const canonical = normalizeHandle(handle);
    if (!isValidHandleFormat(canonical)) {
      throw new BadRequestError("INVALID_HANDLE");
    }
    const community = await communityRepository.findByHandleFull(canonical);
    if (
      !community ||
      community.type !== CommunityType.PUBLIC ||
      communityAccessPolicy.isEffectivelyClosed(community)
    ) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const [avatarView, coverView] = await Promise.all([
      communityImageService.resolveViewUrlForClient(community.avatarUrl),
      communityImageService.resolveViewUrlForClient(community.coverUrl),
    ]);

    return {
      communityId: community.id,
      name: community.name,
      description: community.description ?? null,
      avatarUrl: avatarView?.url ?? null,
      bannerUrl: coverView?.url ?? null,
      memberCount: community.memberCount,
    };
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
    // immediately without a page reload or extra API call. Uses community:added
    // (same event as join/add flows) so the FE has one unified insert path —
    // branch on `via: "created"` if the creation flow needs different UI.
    const createdAt = Date.now();
    const createdAddedPayload: CommunityAddedPayload = {
      eventId: randomUUID(),
      occurredAt: createdAt,
      communityId: community.id,
      name: community.name,
      handle: community.handle,
      description: community.description ?? null,
      avatarUrl: communityData.avatarUrl,
      type: community.type as "PUBLIC" | "PRIVATE",
      categoryId: communityData.category.id,
      categoryName: communityData.category.name,
      memberCount: community.memberCount,
      role: "ADMIN",
      status: communityAccessPolicy.deriveStatus(community),
      via: "created",
      joinedAt: community.createdAt.getTime(),
      addedAt: createdAt,
      lastActivity: {
        type: "created",
        userId: null,
        username: null,
        preview: "Community created",
        dateTime: community.createdAt.getTime(),
      },
    };
    void publishChatUserEvent(
      redis,
      creatorId,
      "community:added",
      createdAddedPayload
    ).catch((err: unknown) => {
      logger.warn(
        `community:added (created) socket publish failed for ${community.id}: ${String(err)}`
      );
    });

    // Onboard every member added DURING creation (User B, User C, …) with the
    // SAME realtime treatment members added later via POST /:id/members already
    // get: a personal `community:added` (full list-row → sidebar insert on ALL
    // their devices), the cross-service `community.member_added` notification, and
    // their private "You joined the community" system message. Historically
    // create() emitted ONLY the creator's `community:added`, so a member chosen at
    // creation time never saw the community until a hard reload — the root cause
    // of "User B/C don't see the new community without refresh". This closes that
    // gap for EVERY client (web, iOS, Android) that passes memberIds to create.
    //
    // Post-commit + fire-and-forget: the membership rows are already persisted and
    // GET /communities/mine returns them immediately, so a socket/publish failure
    // must NEVER fail the create (REST + Mine API remain the source of truth).
    if (memberIds.length > 0) {
      try {
        const createdMemberRows =
          await communityRepository.findMembersByUserIds(
            community.id,
            memberIds
          );
        // The only ADMIN/MODERATOR at creation time is the creator — pass the
        // roster explicitly so notifyMemberJoined skips a per-member roster read
        // (avoids an N+1 of identical lookups, one per added member).
        const moderatorRecipientIds = [creatorId];
        const joinedEventAt = new Date().toISOString();
        await Promise.allSettled(
          createdMemberRows.map((row) =>
            this.notifyMemberJoined({
              community,
              member: row,
              memberCount: community.memberCount,
              actorId: creatorId,
              via: "add_members",
              eventAt: joinedEventAt,
              moderatorRecipientIds,
            })
          )
        );
        // Observability: one structured line per create fan-out (no PII) so the
        // recipient count is greppable in prod when diagnosing a "didn't appear"
        // report. intendedRecipients = creator + every added member.
        logger.info(
          `community create realtime fan-out: community=${community.id} ` +
            `eventId=${createdAddedPayload.eventId} actor=${creatorId} ` +
            `intendedRecipients=${1 + createdMemberRows.length} ` +
            `onboardedMembers=${createdMemberRows.length}`
        );
      } catch (err) {
        // A failure here only loses the realtime convenience for the added
        // members this call; they remain ACTIVE members and GET /communities/mine
        // returns the community on their next list read / reload.
        logger.warn(
          `community create member onboarding fan-out failed for community=${community.id}: ${String(err)}`
        );
      }
    }

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
    communityAccessPolicy.assertWritable(community);

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
    // line instead of the generic "Community settings updated". See
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
    //    (name / description / avatar / banner / handle), else the generic
    //    COMMUNITY_UPDATED;
    //  - MULTIPLE simultaneous fields → one collapsed COMMUNITY_UPDATED
    //    ("Community settings updated").
    // This replaces the previous "emit one line per name/avatar/other group"
    // behaviour, which could post up to three separate lines for one save and
    // rendered description/banner edits as the generic "Community info" line.
    //
    // LIMITATION (by design, not an oversight): a save that touches 2+ fields
    // at once (e.g. name + description in the same request) still collapses to
    // ONE generic COMMUNITY_UPDATED line rather than one specific line per
    // field — see selectCommunityUpdateSystemMessageType's doc comment. Emitting
    // N lines for N changed fields was tried and reverted (see the "up to three
    // separate lines" note above); this stays intentionally single-message per
    // update() call.
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

    // Real-time metadata sync: push the new name/avatar/description/category/
    // visibility to the detail/header (community:<id> room) AND to every member's
    // list row (user:<id>) so no client needs to refetch or reload. Distinct from
    // the system-message-driven `community:updated` list bump above, which only
    // reorders + previews. Fire-and-forget — never blocks the response.
    //
    // Emitted AFTER the membership add/remove block so the snapshot's memberCount
    // is post-mutation. When memberIds was touched, re-read the row for an
    // accurate count (cheap, admin-only path); otherwise the in-hand row is current.
    const snapshotForBroadcast =
      input.memberIds !== undefined
        ? ((await communityRepository.findById(communityId)) ?? updated)
        : updated;
    void broadcastCommunityMetaUpdated(snapshotForBroadcast, changedFields);

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

    logger.info(
      `[LIVE-SIDEBAR:COMMUNITY] listMine rawPage userId=${userId} direction=${params.direction} ts=${params.ts.toISOString()} limit=${params.limit} rowCount=${pageRows.length} rows=${pageRows
        .map(
          (row) =>
            `${row.id}@${row.lastActivityAt.getTime()}:${row.lastActivityType ?? "unknown"}`
        )
        .join(",")}`
    );

    const communities = await enrichMineCommunities(userId, pageRows);

    // Inclusive boundary (as specified) → consecutive pages can share the
    // boundary community; clients de-duplicate by id. nextCursor is epoch-ms to
    // feed straight back as before_ts/after_ts.
    logger.info(
      `[LIVE-SIDEBAR:COMMUNITY] listMine userId=${userId} direction=${params.direction} ts=${params.ts.toISOString()} limit=${params.limit} returned=${communities.length} total=${total} ids=${communities
        .map((community) => community.id)
        .join(",")} liveIds=${communities
        .filter((community) => community.isLive)
        .map((community) => community.id)
        .join(",")} top=${communities
        .slice(0, 5)
        .map(
          (community) =>
            `${community.id}@${community.lastActivityAt}:${community.isLive ? "live" : "not-live"}`
        )
        .join(",")}`
    );

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
   * The `cursor=` path of `GET /api/v1/communities/mine`: same enriched page as
   * {@link listMine} ({@link enrichMineCommunities}), but paged by a gap-safe
   * COMPOUND `(lastActivityAt, id)` keyset instead of the legacy bare-millisecond
   * bound — so same-ms communities can no longer skip/duplicate at a page edge.
   * `cursor` null → newest page; `nextCursor` is the opaque compound `"<ms>_<id>"`
   * the client feeds straight back as the next `cursor`.
   */
  async listMineKeyset(
    userId: string,
    params: { cursor: { ts: Date; id: string } | null; limit: number }
  ): Promise<PaginatedResponse<CommunityListItem>> {
    // Over-fetch one extra row so hasMore is exact.
    const { rows, total } = await communityRepository.listMineByActivityKeyset({
      userId,
      cursor: params.cursor,
      limit: params.limit + 1,
    });

    const hasMore = rows.length > params.limit;
    const pageRows = rows.slice(0, params.limit);

    const communities = await enrichMineCommunities(userId, pageRows);

    // Compound exclusive cursor: the id tiebreaker keeps same-ms communities
    // reachable exactly once (the V1 bare-ms leak this endpoint fixes).
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? `${lastRow.lastActivityAt.getTime()}_${lastRow.id}`
        : null;

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
    // to PUBLIC + the caller's ACTIVE and (non-dismissed) BANNED memberships —
    // a banned community stays visible in the caller's OWN "mine" view, same as
    // `listMine`; the discover/browse alias narrows to PUBLIC and excludes every
    // community the caller already relates to (ACTIVE + PENDING + BANNED) — a
    // banned caller shouldn't re-discover/re-request-join a community they're
    // banned from via public browse. A kicked member (LEFT + removedAt audit
    // marker) is a plain non-member everywhere: hidden from "mine", free to
    // re-discover and rejoin via the normal flow.
    let includeMemberCommunityIds: string[] | undefined;
    let excludeCommunityIds: string[] | undefined;
    let activeMemberIds: string[] = [];
    let bannedIds: string[] = [];

    if (params.includeJoined) {
      const [memberIds, banned] = await Promise.all([
        communityRepository.listActiveMemberCommunityIds(userId),
        communityRepository.findBannedCommunityIds(userId, {
          excludeDismissed: true,
        }),
      ]);
      activeMemberIds = memberIds;
      bannedIds = banned;
      // Union with banned ids so a banned PRIVATE community still passes the
      // repo's visibility OR (PUBLIC OR id-in-includeMemberCommunityIds) —
      // `isJoined`/`isBanned` below are derived from the separate, non-merged
      // sets so they aren't conflated.
      includeMemberCommunityIds = [...memberIds, ...bannedIds];
    } else {
      // listExcludedCommunityIds already covers ACTIVE + PENDING + BANNED.
      excludeCommunityIds =
        await communityRepository.listExcludedCommunityIds(userId);
    }

    const { rows, total } = await communityRepository.listDiscoverable({
      q: params.q,
      categoryId: params.categoryId,
      includeMemberCommunityIds,
      excludeCommunityIds,
      page: params.page,
      limit: params.limit,
    });

    const communityIds = rows.map((row) => row.id);

    // Batch-load mute rows, pending join requests, live counts, and whether
    // the caller is already streaming elsewhere — all in parallel.
    const [
      muteByCommunityId,
      pendingRequestSet,
      liveCountMap,
      currentUserIsStreaming,
    ] = await Promise.all([
      loadMuteMap(userId, communityIds),
      communityRepository.findPendingRequestedCommunityIds(
        userId,
        communityIds
      ),
      fetchLiveStreamCounts(communityIds),
      getStreamClient().checkCreatorHasActiveStream(userId),
    ]);

    // Build fast lookups for membership: used by the mine-search alias
    // (includeJoined=true). Public discover always has isJoined/isBanned=false.
    const memberSet = new Set(activeMemberIds);
    const bannedSet = new Set(bannedIds);

    const communities: CommunityDiscoverItem[] = await Promise.all(
      rows.map((row) =>
        toDiscoverItem(
          row,
          muteByCommunityId.get(row.id) ?? null,
          memberSet.has(row.id),
          pendingRequestSet.has(row.id),
          liveCountMap.get(row.id) ?? 0,
          userId,
          currentUserIsStreaming,
          bannedSet.has(row.id)
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
        item.firstUnreadMessageId = chat.firstUnreadMessageId;
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
      callerId,
      status,
      page: params.page,
      limit: params.limit,
    });

    const userIds = rows.map((r) => r.userId);
    // Use the HITS-ONLY snapshot fetch (no "Unknown" placeholder back-fill).
    // Each membership doc already carries a denormalized last-known-good
    // snapshot (snapshotUsername/DisplayName/AvatarKey), so we prefer the fresh
    // live profile when user-service resolves it and otherwise keep the stored
    // snapshot. This makes the list resilient: a user-service outage (or a
    // single unresolved id) never clobbers valid members' names with "Unknown".
    const [liveSnapshots, muteMap] = await Promise.all([
      fetchUserSnapshotHits(userIds),
      communityRepository.findActiveMemberMutesByUserIds(communityId, userIds),
    ]);

    const enrichedRows = rows.map((r) => {
      const live = liveSnapshots.get(r.userId);
      const mute = muteMap.get(r.userId);
      // Profile is unavailable only when BOTH the live lookup misses AND the
      // stored snapshot has no usable name (a genuinely deleted/unknown user).
      const profileUnavailable =
        !live && !r.snapshotDisplayName.trim() && !r.snapshotUsername.trim();
      return {
        ...r,
        snapshotUsername: live ? live.username : r.snapshotUsername,
        snapshotDisplayName: live ? live.displayName : r.snapshotDisplayName,
        snapshotAvatarKey: live ? live.avatarObjectKey : r.snapshotAvatarKey,
        profileUnavailable,
        mutedAt: mute?.createdAt ?? null,
        mutedBy: mute?.mutedBy ?? null,
        mutedUntil: mute?.mutedUntil ?? null,
      };
    });

    const members: CommunityMemberData[] = await Promise.all(
      enrichedRows.map(toMemberData)
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
    // ONE community-wide line, personalized PER VIEWER by the fallback-text
    // builder / client: the target sees "You are now a moderator" (viewer ===
    // targetUserId) while everyone else sees "<name> is now a moderator".
    // Do NOT also emit a personal ROLE_CHANGED_SELF — the target is already in
    // the community room and receives this line, so a second personal line
    // duplicated the message for them ("You are now a moderator" shown twice).
    publishCommunitySystemMessageForChatSafe({
      communityId,
      systemMessageType: "ROLE_CHANGED",
      metadata: {
        actorUserId: callerId,
        actorName: "",
        targetUserId,
        targetName: target.snapshotDisplayName || target.snapshotUsername || "",
        oldRole: target.role as string,
        newRole: role as string,
      },
      triggeredByUserId: callerId,
      eventAt: new Date().toISOString(),
    });

    // Real-time roster sync: flip the member's role badge on the Members page +
    // chat header for everyone in the room, without a refetch. Fire-and-forget.
    void publishCommunityRoomEvent(
      redis,
      communityId,
      "community:member:updated",
      {
        communityId,
        userId: targetUserId,
        role,
        updatedAt: Date.now(),
      } satisfies CommunityMemberUpdatedPayload
    ).catch((err: unknown) => {
      logger.warn(
        `community:member:updated broadcast failed (role change) community=${communityId} user=${targetUserId}: ${String(err)}`
      );
    });

    // A demotion to plain MEMBER drops livestream permission — force-end any
    // stream they're currently hosting, same pipeline as ban/kick.
    if (role === CommunityMemberRole.MEMBER) {
      void getStreamClient().forceEndStreamsByCreator(
        communityId,
        targetUserId,
        "ROLE_UPDATED"
      );
    }

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
    const { target: _target } = await this._assertCanModerateMember(
      communityId,
      callerId,
      targetUserId
    );

    // Single-document update + recompute of memberCount — no $transaction
    // (standalone Mongo). Recounting ACTIVE members is robust against drift.
    // Status stays LEFT (identical to a voluntary leave — every existing
    // rejoin-flow "reactivate a LEFT row" check keeps working unmodified);
    // removedAt/removedBy are AUDIT metadata distinguishing an admin kick from
    // a voluntary leave. Behaviorally a kicked member is a plain non-member:
    // the community disappears from their list and they rejoin via the normal
    // flow (which clears the marker).
    const updated = await communityRepository.updateMemberStatus(
      communityId,
      targetUserId,
      CommunityMemberStatus.LEFT,
      undefined,
      undefined,
      {
        removedAt: new Date(),
        removedBy: callerId,
        removedReason: reason ?? null,
      }
    );

    const count = await communityRepository.countActiveMembers(communityId);
    await communityRepository.setMemberCount(communityId, count);

    // NOTE: removal is intentionally NOT written to lastActivity — "X was removed
    // from the community" must never become the community-list preview (Telegram
    // parity; see isEligibleForLastActivity). The previous eligible activity
    // stays. The chat SYSTEM line (MEMBER_REMOVED) is handled separately.

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
        // Room broadcast: roster update for remaining members + gateway eviction
        // (the evict-on-removal handler in community.ns.ts forces the removed
        // user's sockets out of the community room on all their devices that are
        // currently in the room).
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
        // Personal channel — reaches ALL of the kicked user's devices. A kick
        // removes the community from the target's own list (unlike a ban,
        // which keeps it visible via community:membership:restricted) — the
        // documented FE contract for this event is "remove from local store".
        publishChatUserEvent(
          redis,
          targetUserId,
          "community:membership:removed",
          {
            communityId,
            membershipStatus: "REMOVED",
            reason: "kicked",
            removedAt: now,
          }
        ),
      ]);
    } catch (err) {
      logger.warn(
        `community realtime broadcast failed kick community=${communityId}: ${String(err)}`
      );
    }
    // NOTE: emitMemberSystemMessage("MEMBER_REMOVED") is NOT called here.
    // Product rule: removal must be silent from the chat-message perspective.
    // MEMBER_REMOVED is in HIDDEN_SYSTEM_MESSAGE_TYPES (packages/constants) as
    // the authoritative policy. Moderation history lives in the audit log only.

    // Best-effort: a kick removes ACTIVE membership the same as a ban — if the
    // target is currently broadcasting in this community, they no longer
    // satisfy the membership gate that let them go live, so end it. Scoped to
    // this community only. Unlike ban, kick has no existing viewer-kick
    // notify call (kicked members aren't rejected at CheckStreamAccess the way
    // banned ones are), so this is the only stream-service touch point here.
    void getStreamClient().forceEndStreamsByCreator(
      communityId,
      targetUserId,
      "MEMBER_REMOVED"
    );

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

    // Ban is silent COMMUNITY-wide (no "{name} was banned" line for other
    // members — MEMBER_BANNED is PERSONAL visibility), but the banned user
    // themselves gets a private "You were banned from this community." line
    // in their own history (Telegram parity). Enqueued and AWAITED here,
    // BEFORE removeActiveMember below fires the client-facing eviction
    // (community:member:removed) and ban-notice (community:membership:
    // restricted, isBanned:true) events. Those are near-instant Redis
    // publishes; this system message is consumed async by chat-service over
    // RabbitMQ, so publishing it first (and confirming the broker has it)
    // narrows the window where a client could render "you're banned" before
    // the system message / their final personal-channel state arrives.
    // MEMBER_BANNED is never a hidden type, so this always reaches the
    // target via visibleToUserId.
    await publishCommunitySystemMessageForChatAwaited({
      communityId,
      systemMessageType: "MEMBER_BANNED",
      metadata: { targetUserId },
      triggeredByUserId: callerId,
      eventAt: new Date().toISOString(),
      visibleToUserId: targetUserId,
    });

    // Ban = automatic leave: reuse the same removal core as leaveCommunity
    // (status flip, memberCount recompute, audit, socket eviction via
    // community:member:removed, and community-list drop via
    // community:membership:removed) so a banned member is cleaned up
    // identically to one who left voluntarily. Only the target status
    // (BANNED + ban metadata) and event reason ("banned") differ.
    // NOTE: ban is intentionally NOT written to lastActivity — a ban line must
    // never become the community-list preview (Telegram parity; see
    // isEligibleForLastActivity). The previous eligible activity stays.
    const { updated } = await this.removeActiveMember(
      communityId,
      targetUserId,
      {
        actorId: callerId,
        status: CommunityMemberStatus.BANNED,
        banMeta: {
          bannedAt: new Date(),
          bannedBy: callerId,
          banReason: reason ?? null,
        },
        removedReason: "banned",
        auditAction: "MEMBER_BANNED",
        auditMetadata: reason ? { reason } : undefined,
        reason: reason ?? null,
        eventAt: new Date().toISOString(),
        emitLeftDomainEvent: false,
      }
    );

    // `reason` is operator-supplied, not PII.
    logger.info(
      `Community member banned: community=${communityId} by=${callerId} target=${targetUserId} reason=${reason ?? "(none)"}`
    );

    const bannedCommunityAvatar =
      await communityImageService.resolveViewUrlForClient(community.avatarUrl);
    publishCommunityMemberBannedSafe({
      communityId,
      eventAt: new Date().toISOString(),
      actorId: callerId,
      targetUserId,
      reason: reason ?? null,
      communityName: community.name,
      communityAvatarUrl: bannedCommunityAvatar?.url ?? null,
    });

    // Best-effort: kick the target from any of their currently-LIVE stream
    // sessions in this community. Never blocks/fails the ban itself
    // (notifyMemberBanStatus swallows its own errors).
    void getStreamClient().notifyMemberBanStatus(
      communityId,
      targetUserId,
      true
    );
    // Best-effort: also force-end any stream the target is currently
    // BROADCASTING in this community — kicking their viewer/chat socket above
    // doesn't stop their SRS publish, so without this a banned streamer keeps
    // broadcasting to the community they were just banned from. Scoped to
    // this community only — they may still be a legitimate member (and
    // legitimately live) elsewhere.
    void getStreamClient().forceEndStreamsByCreator(
      communityId,
      targetUserId,
      "MEMBER_BANNED"
    );

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
    /** For PERSONAL subtypes (e.g. MEMBER_MUTED): the userId who should see the message. */
    visibleToUserId?: string;
  }): void {
    // Telegram silent-kick parity: never post moderation removal/ban lines to the
    // chat timeline (they pile up across remove→rejoin cycles and the victim sees
    // "You were removed" repeatedly). The domain event, roster socket, and
    // notifications still fire from their own call sites — only the chat SYSTEM
    // message is dropped. chat-service also hides any rows persisted before this.
    if (isHiddenSystemMessage(args.systemMessageType)) return;
    publishCommunitySystemMessageForChatSafe({
      communityId: args.communityId,
      systemMessageType: args.systemMessageType,
      metadata: {
        ...(args.targetUserId ? { targetUserId: args.targetUserId } : {}),
        ...(args.extra ?? {}),
      },
      triggeredByUserId: args.actorId,
      eventAt: new Date().toISOString(),
      ...(args.visibleToUserId
        ? { visibleToUserId: args.visibleToUserId }
        : {}),
    });
  },

  /**
   * Broadcasts a moderation MUTE/UNMUTE state change to every consumer that
   * needs it — the single source of truth for "this member's mute changed":
   *   1. mirrors the new state into chat-service's RoomMember (drives the
   *      write-path gate, no per-message gRPC), and
   *   2. emits the realtime `community:member:muted` / `:unmuted` socket event
   *      to BOTH the community room (every member's roster badge) AND the
   *      affected member's own `user:<id>` channel (multi-device composer
   *      enable/disable with no refetch).
   *
   * Used by manual mute, manual unmute, AND the auto-unmute sweeper, so the wire
   * payload is byte-identical regardless of trigger. Best-effort: a Redis hiccup
   * never fails the originating moderation request (the chat mirror is already
   * fire-and-forget via RabbitMQ).
   *
   * @param actorId The admin/moderator who acted; "" for an automatic/system unmute.
   */
  async _publishMuteStateChange(args: {
    communityId: string;
    targetUserId: string;
    isMuted: boolean;
    mutedUntil: Date | null;
    actorId: string;
  }): Promise<void> {
    const { communityId, targetUserId, isMuted, mutedUntil, actorId } = args;

    // 1. Mirror into chat-service RoomMember (fire-and-forget RabbitMQ).
    publishCommunityMemberMuteSyncedForChatSafe({
      communityId,
      userId: targetUserId,
      isMuted,
      mutedUntil: mutedUntil ? mutedUntil.toISOString() : null,
    });

    // 2. Realtime socket fan-out (epoch ms on the wire).
    const updatedAt = Date.now();
    const event = isMuted
      ? "community:member:muted"
      : "community:member:unmuted";
    const payload = isMuted
      ? ({
          communityId,
          memberId: targetUserId,
          isMuted: true,
          mutedUntil: mutedUntil ? mutedUntil.getTime() : null,
          actorId,
          updatedAt,
        } satisfies CommunityMemberMutedSocketPayload)
      : ({
          communityId,
          memberId: targetUserId,
          isMuted: false,
          mutedUntil: null,
          actorId,
          updatedAt,
        } satisfies CommunityMemberUnmutedSocketPayload);

    try {
      await Promise.all([
        publishCommunityRoomEvent(redis, communityId, event, payload),
        publishChatUserEvent(redis, targetUserId, event, payload),
      ]);
    } catch (err) {
      logger.warn(
        `${event} broadcast failed community=${communityId} target=${targetUserId}: ${String(err)}`
      );
    }
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
    community: CommunityWithCategory;
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
    /** Stable ISO-8601 timestamp captured at membership activation time.
     *  Used as the idempotency seed for the COMMUNITY_JOINED chat system
     *  message — the chat-service dedup key is `sys:COMMUNITY_JOINED:{eventAt}:u:{userId}`.
     *  Must be stable across retries so RabbitMQ redeliveries are no-ops. */
    eventAt: string;
    requestId?: string;
    /** When true, suppresses the cross-service community.member_added event.
     *  Use for invite acceptance, which already fires community.invite_accepted
     *  through its own notification path — emitting member_added too would send
     *  a duplicate "You've been added" push to the joiner. */
    skipCrossServiceNotification?: boolean;
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

    if (!args.skipCrossServiceNotification) {
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
    }

    // Roster broadcast — client-facing socket DTO (joinedAt is epoch ms here,
    // matching the reserved AsyncAPI CommunityMemberDTO). Reuse the avatar
    // key→URL resolver the REST member list uses; never hand-roll presigning.
    try {
      const avatarView = await memberAvatarService.resolveViewUrl(
        member.snapshotAvatarKey
      );
      const memberDto = {
        communityId: community.id,
        userId: member.userId,
        username: member.snapshotUsername,
        displayName: member.snapshotDisplayName,
        avatarUrl: avatarView?.url ?? null,
        role: member.role,
        joinedAt: member.joinedAt.getTime(),
      } satisfies CommunityMemberJoinedSocketPayload;
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

    // Personal onboarding event — the new member is NOT yet in the
    // `community:<id>` room, so the roster broadcast above never reaches them.
    // Emit `community:added` to THEIR `user:<id>` channel with a full list-row
    // snapshot so the client inserts the community into the sidebar / "mine" list
    // INSTANTLY — no GET /communities/mine round-trip, no page refresh. Idempotent
    // (client upserts by communityId). Fire-and-forget: a publish failure must
    // never fail the membership write (REST + /communities/mine stay the truth).
    try {
      const communityAvatar =
        await communityImageService.resolveViewUrlForClient(
          community.avatarUrl
        );
      // Build lastActivity deterministically — the COMMUNITY_JOINED system message
      // (published to chat-service via RabbitMQ below) will persist with this same
      // timestamp as its createdAt. Using args.eventAt (not Date.now()) ensures
      // the socket payload's dateTime matches what the Mine API returns once the
      // async write lands, keeping both values bit-for-bit identical.
      const joinLastActivity = {
        type: "system" as const,
        userId: null,
        username: null,
        preview: SELF_JOIN_ACTIVITY_PREVIEW,
        dateTime: new Date(args.eventAt).getTime(),
      };
      const addedAt = Date.now();
      const addedPayload: CommunityAddedPayload = {
        eventId: randomUUID(),
        occurredAt: addedAt,
        communityId: community.id,
        name: community.name,
        handle: community.handle,
        description: community.description,
        avatarUrl: communityAvatar?.url ?? null,
        type: community.type as "PUBLIC" | "PRIVATE",
        categoryId: community.category.id,
        categoryName: community.category.name,
        memberCount,
        role: member.role,
        status: communityAccessPolicy.deriveStatus(community),
        via,
        joinedAt: member.joinedAt.getTime(),
        addedAt,
        lastActivity: joinLastActivity,
      };
      await publishChatUserEvent(
        redis,
        member.userId,
        "community:added",
        addedPayload
      );
    } catch (error) {
      logger.warn(
        `community:added personal emit failed for community=${community.id} user=${member.userId}`
      );
      logger.warn(error);
    }

    // Single shared activation side-effect: personal "You joined the community"
    // system message, visible only to the joining user. Idempotent — the
    // chat-service dedup key is `sys:COMMUNITY_JOINED:{eventAt}:u:{userId}`;
    // RabbitMQ redeliveries and API retries with the same eventAt are no-ops.
    publishCommunitySystemMessageForChatSafe({
      communityId: community.id,
      systemMessageType: "COMMUNITY_JOINED",
      metadata: {},
      triggeredByUserId: member.userId,
      eventAt: args.eventAt,
      visibleToUserId: member.userId,
    });
  },

  /**
   * Fan out `community:join_request:updated` so every open admin/moderator
   * "Accept Requests" list adds, drops, or flips the affected request in real
   * time — no manual page reload. Reused by:
   *   - createJoinRequest (status "PENDING" — a new request just landed), and
   *   - approve/reject and their bulk variants (status "APPROVED"/"REJECTED"),
   * so the realtime side-effect stays DRY across all five call sites.
   *
   * Dual delivery, mirroring `community:added`'s reasoning above: the
   * `community:<id>` room broadcast reaches admins who have the community
   * open, while the per-moderator `user:<id>` emit reaches admins who only
   * have the standalone requests screen mounted (never joined the room).
   * Best-effort — a publish failure must never fail the calling request.
   */
  async notifyJoinRequestDecided(args: {
    communityId: string;
    requestId: string;
    status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
    targetUserId: string;
    actorId: string;
    decidedAt: Date;
    /** Bulk callers hoist this once to avoid an N+1 of identical role reads. */
    moderatorRecipientIds?: string[];
  }): Promise<void> {
    const { communityId, requestId, status, targetUserId, actorId, decidedAt } =
      args;
    try {
      const moderatorRecipientIds =
        args.moderatorRecipientIds ??
        (await communityRepository.findActiveMemberIdsByRoles(communityId, [
          CommunityMemberRole.ADMIN,
          CommunityMemberRole.MODERATOR,
        ]));

      const payload = {
        communityId,
        requestId,
        status,
        userId: targetUserId,
        actorId,
        updatedAt: decidedAt.getTime(),
      } satisfies CommunityJoinRequestUpdatedSocketPayload;

      await Promise.all([
        publishCommunityRoomEvent(
          redis,
          communityId,
          "community:join_request:updated",
          payload
        ),
        ...moderatorRecipientIds.map((modId) =>
          publishChatUserEvent(
            redis,
            modId,
            "community:join_request:updated",
            payload
          )
        ),
      ]);
    } catch (error) {
      logger.warn(
        `community:join_request:updated broadcast failed for community=${communityId} request=${requestId}`
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
    communityAccessPolicy.assertWritable(community);

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
    // Reactivated members keep their existing row in hand; the fresh joinedAt is
    // taken from the reactivation write below (it advances to now), so the DTO is
    // built without a re-read while still reporting the latest join time.
    const toReactivate: {
      userId: string;
      joinedAt: Date;
      role: CommunityMemberRole;
    }[] = [];
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
        // LEFT (or any other inactive non-banned state) → reactivate,
        // preserving the rank they held before leaving.
        toReactivate.push({
          userId,
          joinedAt: member.joinedAt,
          role: member.role,
        });
      }
    }

    // Sequential single-collection writes — no $transaction (standalone Mongo).
    let added: CommunityMemberData[] = [];

    if (toReactivate.length > 0 || toCreate.length > 0) {
      const snapshotIds = [...toReactivate.map((m) => m.userId), ...toCreate];
      const snapshotMap = await fetchUserSnapshots(snapshotIds);

      // Reactivation advances joinedAt to NOW (fresh membership). Capture the
      // persisted value so the response DTO + roster socket report the LATEST
      // join time, not the stale pre-leave one (they must match the member list).
      const reactivatedJoinedAt = new Map<string, Date>();
      if (toReactivate.length > 0) {
        for (const m of toReactivate) {
          const snap = snapshotMap.get(m.userId)!;
          const row = await communityRepository.reactivateMemberWithSnapshot(
            communityId,
            m.userId,
            {
              snapshotUsername: snap.username,
              snapshotDisplayName: snap.displayName,
              snapshotAvatarKey: snap.avatarObjectKey,
            }
          );
          reactivatedJoinedAt.set(m.userId, row.joinedAt);
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

      const reactivated: CommunityMemberData[] = await Promise.all(
        toReactivate.map((m) => {
          const snap = snapshotMap.get(m.userId)!;
          return toMemberData({
            userId: m.userId,
            role: CommunityMemberRole.MEMBER,
            status: CommunityMemberStatus.ACTIVE,
            // Fresh join time from the reactivation write (fallback to the old
            // value only if the map somehow missed it).
            joinedAt: reactivatedJoinedAt.get(m.userId) ?? m.joinedAt,
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
          eventAt: new Date().toISOString(),
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
          eventAt: new Date().toISOString(),
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

      throw new BadRequestError("COMMUNITY_ADMIN_CANNOT_LEAVE");
    }

    // Non-admin leave: status → LEFT + recompute. Single-document update +
    // recompute of memberCount — no $transaction.
    const { updated } = await this.removeActiveMember(communityId, callerId, {
      auditMetadata: leaveMeta,
      reason: leaveReason,
      eventAt: new Date().toISOString(),
    });

    this.emitMemberSystemMessage({
      communityId,
      systemMessageType: "MEMBER_LEFT",
      actorId: callerId,
      targetUserId: callerId,
    });

    return toMemberData(updated);
  },

  /**
   * Shared core of removing an ACTIVE member from a community: flips status
   * (LEFT by default, or BANNED via opts), recomputes memberCount, records
   * the audit entry, and fans out the RabbitMQ + Redis removal events.
   * Reused by leaveCommunity, bulkDeleteCommunities, AND banMember — keeps
   * the "remove from community" side effects (socket eviction via
   * community:member:removed, community-list drop via
   * community:membership:removed, memberCount recompute) defined in exactly
   * one place regardless of why the member left.
   */
  async removeActiveMember(
    communityId: string,
    targetUserId: string,
    opts: {
      actorId?: string; // defaults to targetUserId (self-leave); pass the admin id for a ban
      auditMetadata?: Prisma.InputJsonValue;
      reason?: string | null;
      eventAt: string;
      status?: CommunityMemberStatus; // defaults LEFT
      banMeta?: {
        bannedAt: Date | null;
        bannedBy: string | null;
        banReason: string | null;
      };
      removedReason?: "left" | "banned"; // realtime payload reason, defaults "left"
      auditAction?: "MEMBER_LEFT" | "MEMBER_BANNED"; // defaults MEMBER_LEFT
      emitLeftDomainEvent?: boolean; // defaults true; ban passes false (publishes its own MEMBER_BANNED event)
    }
  ): Promise<{
    updated: Awaited<ReturnType<typeof communityRepository.updateMemberStatus>>;
    memberCount: number;
  }> {
    const status = opts.status ?? CommunityMemberStatus.LEFT;
    const actorId = opts.actorId ?? targetUserId;
    const removedReason = opts.removedReason ?? "left";
    const auditAction = opts.auditAction ?? "MEMBER_LEFT";

    // Banning resets role to MEMBER in the same write so a banned
    // MODERATOR/ADMIN can never have their rank silently restored when they
    // rejoin later — rejoin flows read priorRole off this row.
    const updated = opts.banMeta
      ? await communityRepository.updateMemberStatus(
          communityId,
          targetUserId,
          status,
          opts.banMeta,
          CommunityMemberRole.MEMBER
        )
      : await communityRepository.updateMemberStatus(
          communityId,
          targetUserId,
          status
        );

    const count = await communityRepository.countActiveMembers(communityId);
    await communityRepository.setMemberCount(communityId, count);

    await this.recordAudit({
      communityId,
      actorId,
      action: auditAction,
      targetUserId,
      metadata: opts.auditMetadata,
    });

    if (opts.emitLeftDomainEvent ?? true) {
      publishCommunityMemberLeftSafe({
        communityId,
        actorId,
        reason: opts.reason ?? null,
        eventAt: opts.eventAt,
      });
    }

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
            reason: removedReason,
            actorId,
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
        // Personal channel — reaches ALL of the removed member's devices,
        // including those NOT inside the community room, so their own
        // list/screen updates live. For a BAN specifically, the community must
        // stay in the caller's list (restricted-access model) — so this fires
        // a distinct `community:membership:restricted` (flip to read-only in
        // place) instead of `community:membership:removed`, whose documented FE
        // contract is "remove the community from the local store." Kick/leave/
        // delete-for-self (status LEFT) keep the original removal signal.
        status === CommunityMemberStatus.BANNED
          ? publishChatUserEvent(
              redis,
              targetUserId,
              "community:membership:restricted",
              {
                communityId,
                // Shared derivation — identical field set to the unban event
                // and to a fresh GET, so the client applies one state model
                // for every membership transition.
                ...deriveMembershipState(updated),
                reason: removedReason,
                restrictedAt: now,
              }
            )
          : publishChatUserEvent(
              redis,
              targetUserId,
              "community:membership:removed",
              {
                communityId,
                membershipStatus: "REMOVED",
                reason: removedReason,
                removedAt: now,
              }
            ),
      ]);
    } catch (err) {
      logger.warn(
        `community realtime broadcast failed ${removedReason} community=${communityId}: ${String(err)}`
      );
    }

    return { updated, memberCount: count };
  },

  /**
   * Shared branch logic for "remove this community from MY account", used by
   * both the singular deleteCommunityForSelf and the per-item loop inside
   * bulkDeleteCommunities. Takes already-fetched community/membership rows so
   * callers keep control of batching (bulk fetches both in two queries up
   * front; the singular caller fetches once). Mutates via removeActiveMember
   * — the same shared core leaveCommunity and banMember use — so the ACTIVE
   * non-admin path is byte-for-byte the existing leave workflow.
   */
  async resolveSelfRemoval(
    callerId: string,
    community: { id: string } | null | undefined,
    membership:
      | {
          status: CommunityMemberStatus;
          role: CommunityMemberRole;
          dismissedAt?: Date | null;
          unbannedAt?: Date | null;
        }
      | null
      | undefined,
    eventAt: string
  ): Promise<
    | "NOT_FOUND"
    | "MEMBER_NOT_FOUND"
    | "ALREADY_REMOVED"
    | "OWNER_CANNOT_DELETE"
    | "REMOVED"
  > {
    if (!community) {
      return "NOT_FOUND";
    }

    if (!membership || membership.status === CommunityMemberStatus.PENDING) {
      return "MEMBER_NOT_FOUND";
    }

    if (membership.status === CommunityMemberStatus.LEFT) {
      // A just-unbanned member (unbannedAt set) is still visible in the
      // caller's list — same restricted-access-until-dismissed model as a
      // ban — so dismiss it the same way: hide the entry, nothing else to
      // touch (status/ban metadata already cleared by unbanMember).
      if (membership.unbannedAt && !membership.dismissedAt) {
        await communityRepository.setMemberDismissed(community.id, callerId);
        void publishChatUserEvent(
          redis,
          callerId,
          "community:membership:removed",
          {
            communityId: community.id,
            membershipStatus: "REMOVED",
            reason: "dismissed",
            removedAt: Date.now(),
          }
        );
        return "REMOVED";
      }
      // An ordinary voluntary leave, admin kick, or an already-dismissed
      // unbanned membership is already gone from the caller's list:
      // idempotent success, nothing to do.
      return "ALREADY_REMOVED";
    }

    if (membership.status === CommunityMemberStatus.BANNED) {
      // A banned community stays in the caller's list until THEY dismiss it.
      // Dismissing only HIDES the entry (dismissedAt) — status stays BANNED
      // and the ban metadata survives; only an admin unban lifts the ban.
      if (membership.dismissedAt) {
        return "ALREADY_REMOVED";
      }
      await communityRepository.setMemberDismissed(community.id, callerId);
      void publishChatUserEvent(
        redis,
        callerId,
        "community:membership:removed",
        {
          communityId: community.id,
          membershipStatus: "REMOVED",
          reason: "dismissed",
          removedAt: Date.now(),
        }
      );
      return "REMOVED";
    }

    if (membership.role === CommunityMemberRole.ADMIN) {
      return "OWNER_CANNOT_DELETE";
    }

    await this.removeActiveMember(community.id, callerId, { eventAt });
    this.emitMemberSystemMessage({
      communityId: community.id,
      systemMessageType: "MEMBER_LEFT",
      actorId: callerId,
      targetUserId: callerId,
    });

    return "REMOVED";
  },

  /**
   * Delete a single community from the CALLER's own account/list only — never
   * touches other members. Active member → same removal as leaveCommunity.
   * Banned member → the community was still visible in their list, so this
   * HIDES it (dismissedAt) while the ban itself survives — only an admin
   * unban lifts it. Left/kicked member → already gone, idempotent success.
   * Admin/owner → rejected; they must transfer ownership or use the admin
   * delete flow.
   */
  async deleteCommunityForSelf(
    communityId: string,
    callerId: string
  ): Promise<void> {
    const [community, membership] = await Promise.all([
      communityRepository.findById(communityId),
      communityRepository.findMemberByUserId(communityId, callerId),
    ]);

    const outcome = await this.resolveSelfRemoval(
      callerId,
      community,
      membership,
      new Date().toISOString()
    );

    if (outcome === "NOT_FOUND") {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }
    if (outcome === "MEMBER_NOT_FOUND") {
      throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
    }
    if (outcome === "OWNER_CANNOT_DELETE") {
      throw new BadRequestError("COMMUNITY_OWNER_CANNOT_DELETE");
    }
    // ALREADY_REMOVED and REMOVED are both idempotent success from the
    // caller's perspective — the community is (now) gone from their list.
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
          // Personal channel — drop the community from the leaver's OTHER devices
          // live (parity with single leaveCommunity + kick/ban).
          publishChatUserEvent(
            redis,
            callerId,
            "community:membership:removed",
            {
              communityId,
              membershipStatus: "REMOVED",
              reason: "left",
              removedAt: now,
            }
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

  /**
   * Bulk "remove community from my list" for the logged-in user. Each id is
   * processed independently — one failure never blocks the rest.
   *
   * Rules:
   *  - Community not found          → FAILED / NOT_FOUND
   *  - Caller is the community admin → FAILED / OWNER_CANNOT_DELETE (never
   *    auto-deletes, unlike leaveCommunity — admins must transfer ownership
   *    or delete the community from the admin panel)
   *  - No membership / prior LEFT (incl. kicked) → SKIPPED (already gone)
   *  - BANNED membership             → REMOVED — banned communities are still
   *    visible in "My Communities", so this call is what hides them
   *    (dismissedAt); the ban itself survives until an admin unban
   *  - BANNED already dismissed      → SKIPPED (idempotent)
   *  - PENDING (or any other status) → SKIPPED — never surfaced in the list
   *  - ACTIVE non-admin membership   → REMOVED via the shared leave path
   *    (removeActiveMember) — same cleanup, socket events, and notification
   *    fan-out as a voluntary leave
   */
  async bulkDeleteCommunities(
    callerId: string,
    communityIds: string[]
  ): Promise<{
    results: Array<{
      communityId: string;
      status: "REMOVED" | "SKIPPED" | "FAILED";
      errorCode?: "OWNER_CANNOT_DELETE" | "NOT_FOUND";
    }>;
    summary: { requested: number; removed: number; failed: number };
  }> {
    const [communities, membershipEntries] = await Promise.all([
      communityRepository.findCommunitiesByIds(communityIds),
      Promise.all(
        communityIds.map((communityId) =>
          communityRepository
            .findMemberByUserId(communityId, callerId)
            .then((membership) => [communityId, membership] as const)
        )
      ),
    ]);

    const communityIdSet = new Set(communities.map((c) => c.id));
    const membershipMap = new Map(membershipEntries);

    const results: Array<{
      communityId: string;
      status: "REMOVED" | "SKIPPED" | "FAILED";
      errorCode?: "OWNER_CANNOT_DELETE" | "NOT_FOUND";
    }> = [];
    let removedCount = 0;
    let failedCount = 0;
    const eventAt = new Date().toISOString();

    for (const communityId of communityIds) {
      const community = communityIdSet.has(communityId)
        ? { id: communityId }
        : undefined;
      const membership = membershipMap.get(communityId);

      // Same branch logic (and same removeActiveMember mutation) as the
      // singular deleteCommunityForSelf — kept in one place.
      const outcome = await this.resolveSelfRemoval(
        callerId,
        community,
        membership,
        eventAt
      );

      switch (outcome) {
        case "NOT_FOUND":
          results.push({
            communityId,
            status: "FAILED",
            errorCode: "NOT_FOUND",
          });
          failedCount++;
          break;
        case "OWNER_CANNOT_DELETE":
          results.push({
            communityId,
            status: "FAILED",
            errorCode: "OWNER_CANNOT_DELETE",
          });
          failedCount++;
          break;
        case "MEMBER_NOT_FOUND":
        case "ALREADY_REMOVED":
          results.push({ communityId, status: "SKIPPED" });
          break;
        case "REMOVED":
          results.push({ communityId, status: "REMOVED" });
          removedCount++;
          break;
      }
    }

    return {
      results,
      summary: {
        requested: communityIds.length,
        removed: removedCount,
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
    // Also clears dismissedAt (it belonged to this ban cycle) so a future
    // re-ban shows up in the target's list again. Sets unbannedAt so THIS
    // specific LEFT stays visible in the target's `/communities/mine` list —
    // an unban must never make the community disappear, only an explicit
    // self-dismiss (or the target simply never seeing it again once they
    // rejoin/get re-added, at which point status moves off LEFT anyway) does.
    // Single-document update + recompute of memberCount — no $transaction.
    const unbannedAt = new Date();
    const updated = await communityRepository.updateMemberStatus(
      communityId,
      targetUserId,
      CommunityMemberStatus.LEFT,
      { bannedAt: null, bannedBy: null, banReason: null },
      undefined,
      undefined,
      true,
      unbannedAt
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

    // NOTE: no system message emitted — mirrors the silent MEMBER_BANNED policy.

    // Personal channel — reaches ALL of the unbanned user's devices. Unban
    // lifts BANNED→LEFT (not auto-re-added) but must NOT evict the community
    // from the target's list — it stays visible (read-only, no access) until
    // THEY explicitly remove it, exactly like the ban-time restricted-access
    // model. So this flips the SAME `community:membership:restricted` event
    // used at ban time to the post-unban state. Must NOT fire
    // `community:membership:removed` — that would wrongly drop the row.
    //
    // The membership block comes from the SHARED deriveMembershipState, so the
    // payload is field-for-field what `GET /communities/:id` would now return
    // (isJoined:false, isBanned:false, membershipStatus:"NONE"). That is what
    // lets a client sitting on the open community screen transition straight to
    // the join state — drop the banned banner, hide the composer, show Join
    // Community — without a refetch, and matches a hard reload exactly.
    void publishChatUserEvent(
      redis,
      targetUserId,
      "community:membership:restricted",
      {
        communityId,
        ...deriveMembershipState(updated),
        reason: null,
        restrictedAt: unbannedAt.getTime(),
      }
    );

    // Best-effort, currently a no-op on the stream-service side: unban does not
    // auto-rejoin the user to any room (same as the local per-stream unban) — the
    // call exists for symmetry with notifyMemberBanStatus(true) and as a hook if
    // a "you can rejoin now" push is ever added.
    void getStreamClient().notifyMemberBanStatus(
      communityId,
      targetUserId,
      false
    );

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

    // Mirror into chat-service (write-path gate) + realtime socket fan-out.
    await this._publishMuteStateChange({
      communityId,
      targetUserId,
      isMuted: true,
      mutedUntil,
      actorId: callerId,
    });

    // Mute is silent COMMUNITY-wide (no "{name} was muted" line for other
    // members — MEMBER_MUTED is PERSONAL visibility), but the muted member
    // themselves gets a private "You were muted in this community." line in
    // their own history (Telegram parity), delivered only to their own
    // `user:<id>` channel — never broadcast to the community room.
    this.emitMemberSystemMessage({
      communityId,
      systemMessageType: "MEMBER_MUTED",
      actorId: callerId,
      targetUserId,
      visibleToUserId: targetUserId,
      extra: {
        mutedUntil: mutedUntil ? mutedUntil.getTime() : null,
        durationMinutes: durationMinutes ?? null,
      },
    });

    // Best-effort: push a real-time notice to any of the target's currently-LIVE
    // stream sessions in this community. Never blocks/fails the mute itself
    // (notifyMemberMuteStatus swallows its own errors).
    void getStreamClient().notifyMemberMuteStatus(
      communityId,
      targetUserId,
      true,
      mutedUntil ? mutedUntil.getTime() : 0
    );

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

    const [existing, _targetMember] = await Promise.all([
      communityRepository.findMemberMute(communityId, targetUserId),
      communityRepository.findMemberByUserId(communityId, targetUserId),
    ]);
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

    // Mirror unmute into chat-service (lifts the write-path gate) + realtime
    // socket fan-out (re-enables the composer on every device, no refetch).
    await this._publishMuteStateChange({
      communityId,
      targetUserId,
      isMuted: false,
      mutedUntil: null,
      actorId: callerId,
    });

    // Best-effort: push a real-time notice to any of the target's currently-LIVE
    // stream sessions in this community (notifyMemberMuteStatus swallows its
    // own errors).
    void getStreamClient().notifyMemberMuteStatus(
      communityId,
      targetUserId,
      false,
      0
    );

    // Telegram parity: this mute session is over, so the previous "You are
    // muted until …" line no longer reflects reality — retract it (soft-delete
    // + a `community:message:deleted` tombstone on the target's own `user:<id>`
    // channel) so it disappears from history/pagination/sync everywhere, rather
    // than leaving both the mute AND unmute lines stacked in their history.
    publishCommunityMemberMuteRetractedForChatSafe({
      communityId,
      userId: targetUserId,
    });

    // Unmute is silent COMMUNITY-wide (no "{name} was unmuted" line for other
    // members — MEMBER_UNMUTED is PERSONAL visibility), but the unmuted member
    // themselves gets a private "You were unmuted" line in their own history
    // (Telegram parity), delivered only to their own `user:<id>` channel —
    // never broadcast to the community room.
    this.emitMemberSystemMessage({
      communityId,
      systemMessageType: "MEMBER_UNMUTED",
      actorId: callerId,
      targetUserId,
      visibleToUserId: targetUserId,
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

  /**
   * Auto-unmute sweep — called every minute by the mute-sweeper job. Finds TIMED
   * mutes whose `mutedUntil` has passed and, for each one it can ATOMICALLY claim
   * (so the side-effects fire exactly once even across multiple service instances
   * or RabbitMQ redeliveries), runs the same unmute side-effects as a manual
   * unmute EXCEPT the push notification — a timer lapsing must not ping the user
   * at an arbitrary hour (Telegram parity, product decision):
   *   - audit MEMBER_UNMUTED (metadata.source = "auto")
   *   - mirror the unmute into chat-service + emit `community:member:unmuted`
   *   - post the "X was unmuted" system message
   *
   * Note: enforcement correctness does NOT depend on this sweep — chat-service
   * applies lazy local expiry the instant `mutedUntil` passes. The sweep exists
   * to deliver the realtime signal (composer re-enable, system line) + audit and
   * to garbage-collect the expired row. Idempotent + batched.
   *
   * @returns how many mutes were actually expired this call (drain until short).
   */
  async expireDueMutes(limit: number): Promise<number> {
    const now = new Date();
    const rows = await communityRepository.findExpiredMemberMutes({
      now,
      limit,
    });
    if (rows.length === 0) return 0;

    let expired = 0;
    for (const row of rows) {
      // Exactly-once: only the instance that deletes the row fires side-effects.
      const claimed = await communityRepository.claimExpiredMemberMute(
        row.id,
        now
      );
      if (claimed !== 1) continue;
      expired++;

      try {
        const member = await communityRepository.findMemberByUserId(
          row.communityId,
          row.userId
        );
        const _targetName =
          member?.snapshotDisplayName || member?.snapshotUsername || "";

        await this.recordAudit({
          communityId: row.communityId,
          actorId: "system",
          action: "MEMBER_UNMUTED",
          targetUserId: row.userId,
          metadata: { source: "auto" },
        });

        // Lift the chat write-gate + realtime composer re-enable (NO push).
        await this._publishMuteStateChange({
          communityId: row.communityId,
          targetUserId: row.userId,
          isMuted: false,
          mutedUntil: null,
          actorId: "",
        });
      } catch (err) {
        // The row is already deleted (claim won), so the mute IS lifted and the
        // chat lazy-expiry keeps the member un-gated; only the broadcast failed.
        logger.warn(
          `auto-unmute side-effects failed community=${row.communityId} user=${row.userId}: ${String(err)}`
        );
      }
    }
    return expired;
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
    communityAccessPolicy.assertWritable(community);

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

    const [communities, muteMap, pendingRequestSet] = await Promise.all([
      communityRepository.findManyByIds(communityIds),
      loadMuteMap(callerId, communityIds),
      communityRepository.findPendingRequestedCommunityIds(
        callerId,
        communityIds
      ),
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
            pendingRequestSet.has(community.id),
            // Favorites list does not enrich live status (parity with prior behavior).
            0,
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
    communityAccessPolicy.assertWritable(community);

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

      // STEP 5f: Emit community:member:joined + community:stats:updated socket
      // events + publish community.member_added (for mod notification).
      // Fire-and-forget: the member row is already committed — do not fail the
      // HTTP request if the roster lookup or socket publish fails.
      const memberActivatedAt = new Date().toISOString();
      void this.notifyMemberJoined({
        community,
        member: newRow,
        memberCount: count,
        actorId: callerId,
        via: "self_join",
        eventAt: memberActivatedAt,
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

      // STEP 5h2: COMMUNITY_JOINED system message is now emitted inside
      // notifyMemberJoined() using the eventAt captured above — no separate call.

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

    // Immutable timeline + list sync for the ownership hand-off. The hand-off was
    // previously a "silent" role flip — it updated the DB and the member-roster
    // socket but, unlike updateMemberRole(), posted NO chat SYSTEM message, so the
    // community timeline and the /communities/mine list never recorded that admin
    // changed (no last-activity bump, no live list reorder). Mirror the role-change
    // fan-out via the SAME centralized, idempotent system-message path so the line
    // is snapshot-immutable (each message stores its own oldRole/newRole + names;
    // never re-derived from the member's CURRENT role on read).
    //
    // ONE community-wide ROLE_CHANGED line, personalized PER VIEWER by the fallback-
    // text builder / client (exactly like updateMemberRole): the new admin sees
    // "You are now the community admin" (viewer === targetUserId), while the
    // outgoing admin and every other member see "<name> is now the community admin".
    // Do NOT also emit PERSONAL ROLE_CHANGED_SELF lines — both the new admin and the
    // outgoing admin are in the community room and already receive this single line,
    // so a personal self-line duplicated the message for them (the new admin saw
    // "You are now the community admin" twice; the outgoing admin saw the community
    // line PLUS a separate "You are now a member").
    const newAdminName =
      target.snapshotDisplayName || target.snapshotUsername || "";

    publishCommunitySystemMessageForChatSafe({
      communityId,
      systemMessageType: "ROLE_CHANGED",
      metadata: {
        actorUserId: callerId,
        actorName: "",
        targetUserId,
        targetName: newAdminName,
        oldRole: target.role as string,
        newRole: CommunityMemberRole.ADMIN as string,
      },
      triggeredByUserId: callerId,
      eventAt: new Date().toISOString(),
    });

    // Real-time roster sync: the hand-off flips TWO members — incoming admin and
    // outgoing admin (now a plain member). Emit one community:member:updated per
    // affected member so the Members page + chat header update live, no refetch.
    const adminTransferredAt = Date.now();
    void publishCommunityRoomEvent(
      redis,
      communityId,
      "community:member:updated",
      {
        communityId,
        userId: targetUserId,
        role: CommunityMemberRole.ADMIN,
        updatedAt: adminTransferredAt,
      } satisfies CommunityMemberUpdatedPayload
    ).catch((err: unknown) => {
      logger.warn(
        `community:member:updated broadcast failed (admin transfer, new admin) community=${communityId} user=${targetUserId}: ${String(err)}`
      );
    });
    void publishCommunityRoomEvent(
      redis,
      communityId,
      "community:member:updated",
      {
        communityId,
        userId: callerId,
        role: CommunityMemberRole.MEMBER,
        updatedAt: adminTransferredAt,
      } satisfies CommunityMemberUpdatedPayload
    ).catch((err: unknown) => {
      logger.warn(
        `community:member:updated broadcast failed (admin transfer, prev admin) community=${communityId} user=${callerId}: ${String(err)}`
      );
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

    // Best-effort: force-end every non-terminal stream in the deleted community.
    // Without this, a broadcast running at delete time would keep publishing
    // to SRS on a still-valid access token — the account-ban path is what
    // handles per-user cleanup, but a community delete has no per-user event
    // to hook. Scoped to this community; the streams' creators may still be
    // legitimately live elsewhere. Never awaited — a stream-service outage
    // must not fail (or delay) the delete.
    void getStreamClient().forceEndStreamsByCommunity(
      communityId,
      "COMMUNITY_DELETED"
    );

    // Real-time list eviction: fan out a personal `community:membership:removed`
    // to EVERY ex-member's `user:<id>` channel so the deleted community vanishes
    // from their list live, on every device — without depending on the async
    // `notification:new` delivery path. Same personal event kick/ban/leave use, so
    // a single FE listener (`community:membership:removed` → drop the row) covers
    // every "you are no longer a member" case. Fire-and-forget: the community is
    // already soft-deleted (GET /communities/mine no longer returns it), so a
    // socket failure can never resurrect it — a reload/next read is authoritative.
    try {
      const removedAt = Date.now();
      await Promise.allSettled(
        memberIds.map((memberId) =>
          publishChatUserEvent(
            redis,
            memberId,
            "community:membership:removed",
            {
              communityId,
              membershipStatus: "REMOVED",
              reason: "deleted",
              removedAt,
            }
          )
        )
      );
    } catch (err) {
      logger.warn(
        `community:membership:removed (deleted) fan-out failed for community=${communityId}: ${String(err)}`
      );
    }
  },

  /**
   * CLOSE a community (owner lifecycle, status → CLOSED). Reversible lockdown:
   * members/roles/messages/reports/livestream history are ALL left untouched —
   * only the community's `status` (+ close metadata) flips and the chat room is
   * suspended. `assertWritable`/`assertCommunityRoomWritable` are what actually
   * stop normal-user writes; nothing here deletes or detaches data, so Super
   * Admin (and members, for reads) keep full visibility into everything that
   * existed at close time. Distinct from `deleteCommunity` (permanent) and from
   * platform `moderationStatus=SUSPENDED` (same write-lock, different actor).
   * Broadcasts `community:closed` so connected clients disable actions immediately.
   */
  async closeCommunity(
    communityId: string,
    callerId: string,
    reason: string | null = null
  ): Promise<void> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Only the ACTIVE admin (owner) may close.
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.ADMIN);

    // Idempotent: re-closing an already-CLOSED community is a no-op.
    if (communityAccessPolicy.isOwnerClosed(community)) {
      return;
    }

    // Roster for the CLOSED event + push fan-out. Members are NOT evicted, so
    // this is simply "everyone currently active" — unchanged by this action.
    const memberIds =
      await communityRepository.findActiveMemberIds(communityId);

    const closedAt = new Date();
    // Flip status only. No member/role/message/report/livestream data is
    // touched — closing is a write-lock, not a teardown.
    await communityRepository.updateCommunity(communityId, {
      status: CommunityStatus.CLOSED,
      statusClosedAt: closedAt,
      statusClosedBy: callerId,
      statusClosedReason: reason,
    });

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "COMMUNITY_CLOSED",
      metadata: { reason },
    });

    logger.info(
      `Community closed: community=${communityId} by=${callerId} members=${String(memberIds.length)}`
    );

    // Real-time: broadcast to the community room AND to every ex-member's
    // `user:<id>` room so connected clients disable actions immediately.
    const payload: CommunityClosedPayload = {
      communityId,
      status: "CLOSED",
      closedAt: closedAt.getTime(),
      ...(reason ? { reason } : {}),
    };
    try {
      await publishCommunityRoomEvent(
        redis,
        communityId,
        "community:closed",
        payload
      );
      await Promise.allSettled(
        memberIds.map((memberId) =>
          publishChatUserEvent(redis, memberId, "community:closed", payload)
        )
      );
    } catch (error) {
      logger.warn(
        `community:closed broadcast failed for community=${communityId}: ${String(error)}`
      );
    }

    // Chat-sync: suspend the general room so community chat writes are blocked.
    publishCommunityStatusChangedForChatSafe({
      communityId,
      communityStatus: "SUSPENDED",
    });

    // Push fan-out: notify each ex-member the community was closed.
    publishCommunityClosedSafe({
      communityId,
      eventAt: closedAt.toISOString(),
      actorId: callerId,
      reason,
      memberIds,
    });

    // Best-effort: force-end every non-terminal stream in the closed community.
    // Close is reversible for members/messages/history, but a live broadcast
    // in a suspended community would keep publishing on a still-valid token —
    // same rationale as the delete path. Reopening the community doesn't
    // resurrect a broadcast, matching how the media pipeline works anyway.
    void getStreamClient().forceEndStreamsByCommunity(
      communityId,
      "COMMUNITY_CLOSED"
    );
  },

  /**
   * REOPEN a previously CLOSED community (status → ACTIVE). Authorized by
   * community ownership (`adminId`) — membership was never touched on close, so
   * the owner (and every other member) is still an ACTIVE row throughout.
   * Reopen is now a pure status flip: no member is created/reactivated and
   * `memberCount` is untouched (it was never zeroed). Broadcasts
   * `community:reopened` to the full existing roster and unsuspends the chat room.
   */
  async reopenCommunity(
    communityId: string,
    callerId: string
  ): Promise<CommunityData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Ownership check (adminId) — simpler and unaffected by membership state.
    if (community.adminId !== callerId) {
      throw new ForbiddenError("COMMUNITY_FORBIDDEN");
    }

    // Idempotent: reopening an already-open community returns its current state.
    if (!communityAccessPolicy.isOwnerClosed(community)) {
      const membership = await communityRepository.findMembership(
        communityId,
        callerId
      );
      const myRole =
        membership && membership.status === CommunityMemberStatus.ACTIVE
          ? membership.role
          : null;
      const muteRow = await communityRepository.findMuteByUserAndCommunity(
        callerId,
        communityId
      );
      return toCommunityData(community, myRole, muteRow);
    }

    // Roster for the REOPENED event + push fan-out — unchanged since close,
    // since nobody was evicted.
    const memberIds =
      await communityRepository.findActiveMemberIds(communityId);

    const reopenedAt = new Date();
    const updated = await communityRepository.updateCommunity(communityId, {
      status: CommunityStatus.ACTIVE,
      statusClosedAt: null,
      statusClosedBy: null,
      statusClosedReason: null,
    });

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "COMMUNITY_REOPENED",
      metadata: {},
    });

    logger.info(`Community reopened: community=${communityId} by=${callerId}`);

    // Real-time: announce reopen to the community room AND to every member's
    // `user:<id>` channel — the roster is intact, so this mirrors closeCommunity's
    // fan-out exactly (everyone who was notified of the close gets the reopen too).
    const payload: CommunityReopenedPayload = {
      communityId,
      status: "ACTIVE",
      reopenedAt: reopenedAt.getTime(),
    };
    try {
      await publishCommunityRoomEvent(
        redis,
        communityId,
        "community:reopened",
        payload
      );
      await Promise.allSettled(
        memberIds.map((memberId) =>
          publishChatUserEvent(redis, memberId, "community:reopened", payload)
        )
      );
    } catch (error) {
      logger.warn(
        `community:reopened broadcast failed for community=${communityId}: ${String(error)}`
      );
    }

    // Cross-service event: notifications-service pushes "reopened" to every
    // member, mirroring the CLOSED push (they were never evicted).
    publishCommunityReopenedSafe({
      communityId,
      actorId: callerId,
      communityName: updated.name,
      eventAt: reopenedAt.toISOString(),
      memberIds,
    });

    // Chat-sync: unsuspend the general room so community chat writes resume.
    publishCommunityStatusChangedForChatSafe({
      communityId,
      communityStatus: "ACTIVE",
    });

    return toCommunityData(updated, CommunityMemberRole.ADMIN, null);
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

    communityAccessPolicy.assertWritable(community);

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

      // Admin/moderator "Accept Requests" list realtime refresh — a new
      // request just landed, so every open admin panel should see it appear
      // without a manual reload. Same broadcast used by approve/reject.
      await this.notifyJoinRequestDecided({
        communityId,
        requestId: row.id,
        status: "PENDING",
        targetUserId: callerId,
        actorId: callerId,
        decidedAt: new Date(),
        moderatorRecipientIds,
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
    communityAccessPolicy.assertWritable(community);

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

    // Enriched member_added (moderator awareness) + roster broadcast +
    // COMMUNITY_JOINED personal system message (via notifyMemberJoined).
    await this.notifyMemberJoined({
      community,
      member: row!,
      memberCount: count,
      actorId: callerId,
      via: "join_request_approved",
      requestId: request.id,
      eventAt: new Date().toISOString(),
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

    // Admin/moderator "Accept Requests" list realtime refresh.
    await this.notifyJoinRequestDecided({
      communityId: community.id,
      requestId: request.id,
      status: "APPROVED",
      targetUserId: request.userId,
      actorId: callerId,
      decidedAt: new Date(),
    });

    // COMMUNITY_JOINED personal system message is now emitted inside
    // notifyMemberJoined() above — no separate call needed here.

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

    // Admin/moderator "Accept Requests" list realtime refresh.
    await this.notifyJoinRequestDecided({
      communityId: community.id,
      requestId: request.id,
      status: "REJECTED",
      targetUserId: request.userId,
      actorId: callerId,
      decidedAt: new Date(),
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
    communityAccessPolicy.assertWritable(community);

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
            eventAt: new Date().toISOString(),
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

        // Admin/moderator "Accept Requests" list realtime refresh (per request,
        // so every removed row is individually addressable client-side).
        void this.notifyJoinRequestDecided({
          communityId: community.id,
          requestId,
          status: "APPROVED",
          targetUserId: request.userId,
          actorId: callerId,
          decidedAt,
          moderatorRecipientIds,
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

      const moderatorRecipientIds =
        await communityRepository.findActiveMemberIdsByRoles(communityId, [
          CommunityMemberRole.ADMIN,
          CommunityMemberRole.MODERATOR,
        ]);

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

        // Admin/moderator "Accept Requests" list realtime refresh.
        void this.notifyJoinRequestDecided({
          communityId: community.id,
          requestId,
          status: "REJECTED",
          targetUserId: request.userId,
          actorId: callerId,
          decidedAt,
          moderatorRecipientIds,
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

    // Admin "Accept Requests" list realtime refresh — a pending request just
    // vanished, so every open admin panel should drop the card without a reload.
    await this.notifyJoinRequestDecided({
      communityId: community.id,
      requestId,
      status: "CANCELLED",
      targetUserId: callerId,
      actorId: callerId,
      decidedAt: new Date(),
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

    // Admin "Accept Requests" list realtime refresh — see cancelJoinRequest.
    await this.notifyJoinRequestDecided({
      communityId: community.id,
      requestId: request.id,
      status: "CANCELLED",
      targetUserId: callerId,
      actorId: callerId,
      decidedAt: new Date(),
    });

    return toJoinRequestData(updated);
  },

  // ---------------------------------------------------------------------------
  // Invites
  // ---------------------------------------------------------------------------
  async bulkCreateInvites(
    communityId: string,
    callerId: string,
    userIds: string[]
  ): Promise<BulkInviteResult> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.MODERATOR);
    communityAccessPolicy.assertWritable(community);

    // Batch fetch existing memberships and invite rows in parallel.
    const [existingMembers, existingInvites] = await Promise.all([
      communityRepository.findMembersByUserIds(communityId, userIds),
      communityRepository.findInvitesByUserIds(communityId, userIds),
    ]);

    const membershipByUserId = new Map(
      existingMembers.map((m) => [m.userId, m])
    );
    const inviteByUserId = new Map(
      existingInvites.map((inv) => [inv.inviteeId, inv])
    );

    const results: BulkInviteResult["results"] = [];
    const toCreate: string[] = [];
    const toRecycle: { id: string; inviteeId: string }[] = [];

    for (const userId of userIds) {
      if (userId === callerId) {
        results.push({ userId, outcome: "FAILED", reason: "SELF_INVITE" });
        continue;
      }

      const member = membershipByUserId.get(userId);
      if (member?.status === CommunityMemberStatus.BANNED) {
        results.push({ userId, outcome: "FAILED", reason: "USER_BANNED" });
        continue;
      }
      if (member?.status === CommunityMemberStatus.ACTIVE) {
        results.push({ userId, outcome: "ALREADY_MEMBER" });
        continue;
      }

      const existing = inviteByUserId.get(userId);
      if (!existing) {
        toCreate.push(userId);
      } else if (existing.status === CommunityInviteStatus.PENDING) {
        results.push({
          userId,
          outcome: "ALREADY_INVITED",
          inviteId: existing.id,
        });
      } else {
        // Non-PENDING (ACCEPTED / DECLINED / EXPIRED) — recycle to PENDING.
        toRecycle.push({ id: existing.id, inviteeId: userId });
      }
    }

    // Parallel create new invites (individual creates return the row with id).
    const eventAt = new Date().toISOString();

    const created = await Promise.all(
      toCreate.map((inviteeId) =>
        communityRepository.createInvite({
          communityId,
          inviterId: callerId,
          inviteeId,
        })
      )
    );

    // Batch recycle non-PENDING invites.
    if (toRecycle.length > 0) {
      await communityRepository.recycleManyPendingInvites(
        toRecycle.map((r) => r.id),
        callerId
      );
    }

    // Register results for created invites.
    for (const invite of created) {
      results.push({
        userId: invite.inviteeId,
        outcome: "INVITED",
        inviteId: invite.id,
      });
    }
    // Register results for recycled invites.
    for (const recycled of toRecycle) {
      results.push({
        userId: recycled.inviteeId,
        outcome: "INVITED",
        inviteId: recycled.id,
      });
    }

    // Fire audit logs and publish events for all newly invited (created + recycled).
    const allInvited = [
      ...created.map((inv) => ({ inviteeId: inv.inviteeId, inviteId: inv.id })),
      ...toRecycle.map((r) => ({ inviteeId: r.inviteeId, inviteId: r.id })),
    ];

    await Promise.all(
      allInvited.map(({ inviteeId, inviteId }) =>
        this.recordAudit({
          communityId,
          actorId: callerId,
          action: "MEMBER_INVITED",
          targetUserId: inviteeId,
          metadata: { inviteId },
        })
      )
    );

    for (const { inviteeId, inviteId } of allInvited) {
      publishCommunityInviteSentSafe({
        communityId,
        eventAt,
        inviterId: callerId,
        inviteeId,
        inviteId,
      });
    }

    // The invite record + push notification above are NOT enough on their own:
    // the invitation must also land as a real, persisted message in the
    // inviter↔invitee 1:1 chat. Reuse the invite-link share pipeline
    // (`community.invite_link_shared` → chat-service `deliverInviteLinkDm`)
    // rather than growing a second one — it already provisions the private
    // room, persists a SYSTEM/COMMUNITY_INVITE row, broadcasts `message:new`,
    // bumps `conv:updated` + unread + lastActivity, and is idempotent per
    // action via `eventAt`. History, `/changes` sync and the invitation card
    // renderer then work with no further changes.
    //
    // Best-effort: link resolution talks to the DB, and a failure there must
    // never fail an invite that has already been recorded.
    if (allInvited.length > 0) {
      try {
        const shareLink = await this.resolveOrCreateShareableLink(
          communityId,
          callerId
        );
        const shareLinkData = toInviteLinkData(shareLink, community);
        const inviterSnapshot = (await fetchUserSnapshotHits([callerId])).get(
          callerId
        );
        for (const { inviteeId } of allInvited) {
          publishCommunityInviteLinkSharedForChatSafe({
            communityId,
            communityName: community.name,
            communityHandle: community.handle,
            linkCode: shareLink.code,
            inviterId: callerId,
            recipientId: inviteeId,
            // Same stamp as the invite_sent events above, so a redelivery of
            // either event pair is deduped instead of doubling the card.
            eventAt,
            communityAvatarUrl: community.avatarUrl ?? null,
            memberCount: community.memberCount,
            inviteUrl: shareLinkData.url,
            inviteDeepLink: shareLinkData.appDeepLink,
            isPermanent:
              shareLink.expiresAt === null && shareLink.maxUses === null,
            inviterName: inviterSnapshot?.displayName,
            inviterAvatarUrl: inviterSnapshot?.avatarObjectKey ?? null,
          });
        }
      } catch (err) {
        logger.error(
          `Community invite DM fan-out failed: community=${communityId} inviter=${callerId}`,
          err
        );
      }
    }

    logger.info(
      `Bulk community invite: community=${communityId} inviter=${callerId} ` +
        `created=${created.length} recycled=${toRecycle.length} skipped=${userIds.length - created.length - toRecycle.length}`
    );

    const invited = created.length + toRecycle.length;
    const alreadyInvited = results.filter(
      (r) => r.outcome === "ALREADY_INVITED"
    ).length;
    const alreadyMembers = results.filter(
      (r) => r.outcome === "ALREADY_MEMBER"
    ).length;
    const failed = results.filter((r) => r.outcome === "FAILED").length;

    return {
      totalRequested: userIds.length,
      invited,
      alreadyInvited,
      alreadyMembers,
      failed,
      results,
    };
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
    communityAccessPolicy.assertWritable(community);

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

    // Capture a stable timestamp BEFORE the DB write so the idempotency key
    // `sys:COMMUNITY_JOINED:{activatedAt}:u:{callerId}` is stable across
    // RabbitMQ redeliveries (same publish → same dedup key → chat-service no-ops).
    const activatedAt = new Date().toISOString();

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

    // Per E5 / spec note: INVITE_ACCEPTED notifies the inviter ("X accepted
    // your invite"). Do NOT publish MEMBER_ADDED — that would send a duplicate
    // "You've been added" push to the joiner on top of the invite notification.
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

    // Emit socket roster broadcast + personal community:added onboarding +
    // COMMUNITY_JOINED personal system message. skipCrossServiceNotification
    // suppresses MEMBER_ADDED (handled by INVITE_ACCEPTED above).
    void this.notifyMemberJoined({
      community: community!,
      member: row!,
      memberCount: count,
      actorId: callerId,
      via: "self_join",
      eventAt: activatedAt,
      skipCrossServiceNotification: true,
    }).catch((err) =>
      logger.warn(
        `notifyMemberJoined (invite) failed for community=${invite.communityId}: ${String(err)}`
      )
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
    input: {
      targetUserId?: string;
      reason: string;
      /** Mandatory custom description when `reason` is "OTHER"; ignored otherwise. */
      otherReason?: string;
      reportedMessageId?: string;
      reportedContentType?: string;
      reportedContentText?: string;
      reportedContentPostedAt?: Date;
      reportedContentMedia?: {
        objectKey: string;
        contentType?: string | null;
        fileName?: string | null;
        size?: number | null;
      }[];
    }
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

    // A1.5: "OTHER" requires a non-empty custom description (defense-in-depth —
    // the validator already rejects empty/whitespace-only values). Predefined
    // reasons never persist a description, even if the client sent one.
    const isOtherReason = input.reason.toUpperCase() === "OTHER";
    const otherReason = isOtherReason
      ? (input.otherReason ?? "").trim() || null
      : null;
    if (isOtherReason && !otherReason) {
      throw new BadRequestError("COMMUNITY_REPORT_OTHER_REASON_REQUIRED");
    }

    // Message-level report: resolve the reported content from chat-service so the
    // moderator card shows the actual message (text + media + posted-at). RAW
    // object keys are stored and resolved to presigned URLs on read.
    //
    // This lookup is SCOPED BY communityId, so it doubles as the security check:
    // a messageId belonging to another community (or to no message at all) is
    // simply not found, and the report is rejected instead of being filed
    // against an unrelated conversation. It is no longer best-effort for that
    // reason — a report naming a message we cannot verify is not a report we can
    // act on. A FE-provided snapshot still fills display fields the resolver
    // leaves empty.
    let reportedContentType = input.reportedContentType ?? null;
    let reportedContentText = input.reportedContentText ?? null;
    let reportedContentPostedAt = input.reportedContentPostedAt ?? null;
    let reportedContentMedia:
      | {
          objectKey: string;
          contentType?: string | null;
          fileName?: string | null;
          size?: number | null;
        }[]
      | null = input.reportedContentMedia ?? null;
    // Message sender resolved from the chat snapshot. This is the AUTHORITATIVE
    // reported user for a message report — the client's own `targetUserId` never
    // overrides it, so a tampered payload cannot pin someone else's name to a
    // message they did not send.
    let resolvedMessageSenderId: string | null = null;
    if (input.reportedMessageId) {
      const snap = await getChatClient().getCommunityMessageById({
        communityId,
        messageId: input.reportedMessageId,
      });
      if (!snap?.found) {
        throw new NotFoundError("COMMUNITY_MESSAGE_NOT_FOUND");
      }
      reportedContentText = snap.message || null;
      reportedContentType = snap.contentType || null;
      reportedContentPostedAt = snap.postedAt ? new Date(snap.postedAt) : null;
      reportedContentMedia = snap.media.length
        ? snap.media.map((m) => ({
            objectKey: m.objectKey,
            contentType: m.contentType || null,
            fileName: m.fileName || null,
            size: m.size || null,
          }))
        : null;
      resolvedMessageSenderId = snap.senderId || null;
    }

    // The reported user: for a MESSAGE report it is whoever actually sent the
    // message; for a MEMBER report it is the selected member. Server-resolved
    // wins by construction — the client's targetUserId only survives when there
    // is no message to resolve a sender from.
    const targetUserId = input.reportedMessageId
      ? (resolvedMessageSenderId ?? input.targetUserId ?? null)
      : (input.targetUserId ?? null);

    // A2: cannot self-report — checked against the RESOLVED target, so
    // "report my own message" is caught even when the client sent no
    // targetUserId at all.
    if (targetUserId && targetUserId === callerId) {
      throw new BadRequestError("COMMUNITY_REPORT_CANNOT_TARGET_SELF");
    }

    // A4: a MEMBER report needs an actual member row (any status). A MESSAGE
    // report does not — the verified message is itself the proof of relevance,
    // and its sender may since have left the community.
    if (targetUserId && !input.reportedMessageId) {
      const targetMember = await communityRepository.findMemberByUserId(
        communityId,
        targetUserId
      );
      if (!targetMember) {
        throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
      }
    }

    // A5: dedup, split by report kind. The three kinds NEVER collide — reporting
    // user B and reporting a message B sent are different targets and both must
    // be filable.
    // - MESSAGE reports: once per (reporter, message), any status.
    // - MEMBER reports: a user may report another user only ONCE per community,
    //   ever — checked against ALL statuses (OPEN/REVIEWED/ACTIONED/DISMISSED/
    //   WITHDRAWN all count). A duplicate is a hard error, not a no-op.
    // - Community-level (no target, no message) reports: unchanged idempotent
    //   behavior — an existing OPEN report from the same reporter is returned.
    if (input.reportedMessageId) {
      const existingMessageReport =
        await communityRepository.findReportByReporterAndMessage({
          communityId,
          reporterId: callerId,
          reportedMessageId: input.reportedMessageId,
        });
      if (existingMessageReport) {
        throw new ConflictError("COMMUNITY_REPORT_ALREADY_EXISTS");
      }
    } else if (targetUserId) {
      const existingAnyStatus =
        await communityRepository.findReportByReporterAndTarget({
          communityId,
          reporterId: callerId,
          targetUserId,
        });
      if (existingAnyStatus) {
        throw new ConflictError("COMMUNITY_REPORT_ALREADY_EXISTS");
      }
    } else {
      const existingOpen =
        await communityRepository.findOpenReportByReporterAndTarget({
          communityId,
          reporterId: callerId,
          targetUserId: null,
        });
      if (existingOpen) {
        return toReportData(existingOpen);
      }
    }

    let row;
    try {
      row = await communityRepository.createReport({
        communityId,
        reporterId: callerId,
        targetUserId,
        reason: input.reason,
        otherReason,
        reportedMessageId: input.reportedMessageId ?? null,
        reportedContentType,
        reportedContentText,
        reportedContentPostedAt,
        reportedContentMedia,
      });
    } catch (error) {
      // Race-window guard: two concurrent requests can both pass the A5 dedup
      // read above before either insert commits. The partial unique index on
      // (communityId, reporterId, targetUserId) — see repository comment —
      // turns the loser's insert into a P2002, which we map to the same
      // business error the pre-check throws, instead of a raw 500.
      if (targetUserId && isUniqueConstraintError(error)) {
        throw new ConflictError("COMMUNITY_REPORT_ALREADY_EXISTS");
      }
      throw error;
    }

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

    // Message reports carry the messageId as targetId + the SERVER-RESOLVED
    // sender as reportedUserId; the backoffice's toReportKind maps
    // `type: "message"` → MESSAGE, which unlocks the entity-specific `message`
    // block in the Report Details response.
    const messageSenderId = input.reportedMessageId
      ? (resolvedMessageSenderId ?? targetUserId)
      : null;
    const ingestType: "user" | "community" | "message" = input.reportedMessageId
      ? "message"
      : targetUserId
        ? "user"
        : "community";
    const ingestTargetId =
      input.reportedMessageId ?? targetUserId ?? communityId;
    publishAdminReportIngestSafe({
      type: ingestType,
      targetId: ingestTargetId,
      reporterId: callerId,
      reason: input.reason,
      details: otherReason,
      communityId,
      reportedUserId: messageSenderId,
      roomId: communityId,
      roomType: "COMMUNITY",
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
        items.push({ ...(await toReportData(row)), reporter, target });
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
          ...(await toReportData(row)),
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

    // Terminal resolution (ACTIONED or DISMISSED) — notify the reporter their
    // report was resolved regardless of outcome. REVIEWED is not terminal.
    if (
      nextStatus === CommunityReportStatus.ACTIONED ||
      nextStatus === CommunityReportStatus.DISMISSED
    ) {
      publishCommunityReportResolvedSafe({
        communityId,
        eventAt: new Date().toISOString(),
        reportId,
        actorId: callerId,
        reporterId: report.reporterId,
        targetUserId: report.targetUserId ?? null,
        resolution: nextStatus,
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

    publishNotificationMuteChanged(communityId, callerId, true);

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
    publishNotificationMuteChanged(communityId, callerId, false);
  },

  async bulkMute(
    callerId: string,
    communityIds: string[],
    durationMinutes: number | null | undefined
  ): Promise<{ muted: string[]; skipped: string[] }> {
    const memberships =
      await communityRepository.findActiveMembershipsByCommunityIds(
        callerId,
        communityIds
      );
    const activeMemberSet = new Set(memberships.map((m) => m.communityId));

    // ONE timestamp for the whole batch so N sequential writes can't drift the
    // expiry by the wall-clock cost of the loop.
    const mutedUntil =
      durationMinutes == null
        ? null
        : new Date(Date.now() + durationMinutes * 60_000);

    const muted: string[] = [];
    const skipped: string[] = [];

    // UPSERT every active membership, exactly like the single-community path
    // (`setMute`). The previous "skip anything that already has a
    // CommunityMuteSetting row" shortcut silently no-op'd for two very common
    // states, because a row is NOT the same thing as an active mute
    // (`isMuteRowActive`): a LAPSED temp mute leaves its row behind (nothing
    // garbage-collects it) and touching the per-kind notification toggles
    // creates one too. Both render as un-muted in the list, so bulk Mute
    // appeared to do nothing at all. Upserting is also what makes a re-mute
    // able to change the duration, and makes the whole call idempotent.
    for (const communityId of communityIds) {
      if (!activeMemberSet.has(communityId)) {
        skipped.push(communityId);
        continue;
      }
      await communityRepository.upsertMute(callerId, communityId, mutedUntil);
      publishNotificationMuteChanged(communityId, callerId, true);
      muted.push(communityId);
    }

    return { muted, skipped };
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
      toUnmute.forEach((id) =>
        publishNotificationMuteChanged(id, callerId, false)
      );
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
      // Force-end every live stream in this community on suspension. Same
      // rationale as the owner-triggered close/delete paths — a live broadcast
      // in a suspended community would keep publishing on a still-valid token.
      // Skipped on reopen (target=ACTIVE): reopening doesn't resurrect anything.
      if (target === CommunityModerationStatus.SUSPENDED) {
        void getStreamClient().forceEndStreamsByCommunity(
          communityId,
          "COMMUNITY_SUSPENDED"
        );
      }
    }

    return result;
  },

  // ---------------------------------------------------------------------------
  // Permanent invitation link (PRIVATE communities only)
  // ---------------------------------------------------------------------------

  /**
   * Return — or lazily generate — the community's PERMANENT invitation code.
   *
   * Behaviour contract (Telegram-like):
   *  - Code generated on the **first call** and persisted forever.
   *  - **Every subsequent call returns the identical code** — no new code is ever
   *    generated unless an admin explicitly calls a future "regenerate" endpoint.
   *  - Updating the community name / avatar / description / settings does NOT
   *    affect the code.
   *  - Closing and reopening the community does NOT affect the code.
   *  - 100 concurrent callers on a brand-new community collapse onto one winner
   *    via the `setInvitationCodeOnce` atomic guard and all receive the same code.
   *
   * Authorization: any ACTIVE community member may retrieve the link.
   */
  async getOrCreatePermanentInvitationLink(
    communityId: string,
    callerId: string
  ): Promise<PermanentInvitationLinkData> {
    const community = await communityRepository.findById(communityId);
    if (!community) throw new NotFoundError("COMMUNITY_NOT_FOUND");

    // Permanent invitation links only exist for PRIVATE communities.
    // PUBLIC communities are discoverable via their canonical handle URL.
    if (community.type !== CommunityType.PRIVATE) {
      throw new BadRequestError("COMMUNITY_NOT_PRIVATE");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MEMBER);

    const withCode = await this.ensurePermanentInvitationCode(community);
    return toPermanentInvitationLinkData(withCode);
  },

  /**
   * Internal: ensure a PRIVATE community has its permanent `invitationCode`
   * allocated, returning the community row with a guaranteed non-null code.
   *
   * This is the SINGLE source of the get-or-create logic — both the dedicated
   * `GET /communities/:id/invitation-link` endpoint and the bare
   * `POST /communities/:id/invite-links` SSOT short-circuit funnel through here,
   * so there is exactly one place that can ever mint a permanent code.
   *
   *  - **Fast path:** code already set → returns the row unchanged (zero writes).
   *  - **Slow path (first call only):** generate a 128-bit base64url candidate,
   *    persist it via the atomic `setInvitationCodeOnce` guard
   *    (updateMany WHERE invitationCode IS NULL — no transaction, works on
   *    standalone Mongo), and retry up to 3× on a lost race / unique collision.
   *    A losing concurrent caller re-reads and returns the winner's code, so
   *    100 simultaneous first-callers all converge on ONE code.
   */
  async ensurePermanentInvitationCode(
    community: CommunityRow
  ): Promise<CommunityRow> {
    // Fast path — already allocated. Pure read, no write.
    if (community.invitationCode) {
      return community;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = generateInviteCode();
      const result = await communityRepository.setInvitationCodeOnce(
        community.id,
        candidate
      );

      if (result.count === 1) {
        // We won — re-read to return the fully populated row.
        const updated = await communityRepository.findById(community.id);
        return updated!;
      }

      // Another concurrent request beat us (or a DB-level collision on the
      // sparse unique index). Re-read to pick up the winning code.
      const refreshed = await communityRepository.findById(community.id);
      if (refreshed?.invitationCode) {
        return refreshed;
      }
      // invitationCode still null — extremely unlikely. Loop with a new candidate.
    }

    // Last-resort re-read before giving up (covers the pathological 3-collision case).
    const final = await communityRepository.findById(community.id);
    if (final?.invitationCode) {
      return final;
    }
    throw new Error("Failed to allocate permanent invitation code");
  },

  /**
   * Redeem the community's PERMANENT invitation code.
   *
   * Mirrors `redeemInviteLink` but:
   *  - The community is looked up by its permanent `invitationCode` field (not a
   *    `CommunityInviteLink` row), so there is no `usedCount` to increment.
   *  - The link is always `autoApprove: false` (request-to-join for PRIVATE).
   *  - A synthetic `CommunityInviteLinkData` is returned so the caller's response
   *    shape is identical to a regular redeem.
   *
   * NOT exposed as a standalone service method on purpose — it is only called
   * from `redeemInviteLink` as a fallback when `findInviteLinkByCode` returns null.
   */
  async redeemPermanentInviteCode(
    code: string,
    community: {
      id: string;
      type: CommunityType;
      handle: string;
      adminId: string;
      status: CommunityStatus;
      moderationStatus: CommunityModerationStatus;
      deletedAt: Date | null;
      // invitationCode is `string | null` from Prisma but the caller already
      // verified it equals `code` (non-null) via findCommunityByInvitationCode.
      invitationCode: string | null;
      invitationCodeCreatedAt: Date | null;
      createdAt: Date;
    },
    callerId: string
  ): Promise<{
    link: CommunityInviteLinkData;
    request?: CommunityJoinRequestData;
    member?: CommunityMemberData;
  }> {
    communityAccessPolicy.assertWritable(community);

    const existing = await communityRepository.findMemberByUserId(
      community.id,
      callerId
    );
    if (existing?.status === CommunityMemberStatus.BANNED) {
      throw new ForbiddenError("COMMUNITY_JOIN_BANNED");
    }
    if (existing?.status === CommunityMemberStatus.ACTIVE) {
      // Idempotent: already a member.
      return {
        // Pass `code` explicitly: community.invitationCode is string|null from
        // Prisma, but we know it equals `code` (non-null) from the lookup.
        link: toPermanentLinkAsInviteLinkData({
          ...community,
          invitationCode: code,
        }),
        member: await toMemberData(existing),
      };
    }

    // Permanent links are always autoApprove=false (request-to-join).
    // Only audit when this is a NEW or recycled request, not an idempotent re-tap.
    const existingRequest =
      await communityRepository.findJoinRequestByCommunityAndUser(
        community.id,
        callerId
      );
    const willCreateOrRecycle =
      !existingRequest ||
      existingRequest.status !== CommunityJoinReqStatus.PENDING;

    if (willCreateOrRecycle) {
      await this.recordAudit({
        communityId: community.id,
        actorId: callerId,
        action: "INVITE_LINK_REDEEMED",
        targetUserId: callerId,
        metadata: { code, isPermanentLink: true },
      });
    }

    const joinResult = await this.createJoinRequest(
      community.id,
      callerId,
      null
    );

    return {
      link: toPermanentLinkAsInviteLinkData({
        ...community,
        invitationCode: code,
      }),
      request: joinResult,
    };
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

    // Authorization: ANY ACTIVE member (MEMBER, MODERATOR, or ADMIN) may create
    // an invite link. `assertCommunityRole(..., MEMBER)` enforces exactly the
    // required membership-state rule — it rejects non-members (no row), and any
    // non-ACTIVE status (PENDING / BANNED / LEFT), while admitting every role.
    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MEMBER);
    communityAccessPolicy.assertWritable(community);

    // ── SINGLE SOURCE OF TRUTH short-circuit (bare/default call) ───────────────
    // A "Generate Invitation Link" button posts an EMPTY body. With no maxUses /
    // expiresInMinutes / autoApprove, the caller wants THE community's canonical
    // invite link — not a fresh throwaway link. For PRIVATE communities we return
    // the PERMANENT, never-changing code (lazily minted once via the shared
    // `ensurePermanentInvitationCode` helper) shaped as a `CommunityInviteLinkData`
    // so the response contract is unchanged. This is idempotent: repeated bare
    // calls return the identical code with NO new rows, NO rate-limit consumption,
    // and NO active-link-cap usage.
    //
    // PUBLIC communities fall through to the legacy path: their share URL is
    // handle-based and code-independent (already deterministic), so there is no
    // "code changes every call" problem to fix for them.
    //
    // A PARAMETERIZED call (any of maxUses / expiresInMinutes / autoApprove
    // present) is an explicit request for a custom temporary link and keeps the
    // full legacy multi-link behavior below — preserving Expiring / Limited-use /
    // Auto-approve links untouched.
    const isDefaultCall =
      input.maxUses == null &&
      input.expiresInMinutes == null &&
      input.autoApprove == null;
    if (isDefaultCall && community.type === CommunityType.PRIVATE) {
      const withCode = await this.ensurePermanentInvitationCode(community);
      return toPermanentLinkAsInviteLinkData(
        withCode as CommunityRow & { invitationCode: string }
      );
    }

    // Abuse guards (now that every member can create links):
    //  1. Per-user create rate limit (429 when exceeded).
    //  2. Cap on simultaneously-active links one member owns in this community.
    await assertInviteCreateRateLimit(callerId);
    const activeOwned =
      await communityRepository.countActiveInviteLinksByCreator(
        communityId,
        callerId
      );
    if (activeOwned >= env.COMMUNITY_INVITE_MAX_ACTIVE_LINKS_PER_MEMBER) {
      throw new ForbiddenError("COMMUNITY_INVITE_LINK_LIMIT_REACHED");
    }

    const expiresAt = input.expiresInMinutes
      ? new Date(Date.now() + input.expiresInMinutes * 60_000)
      : null;
    const maxUses = input.maxUses ?? null;
    // Default = request-to-join for BOTH types (Sharing & Deep-Linking spec,
    // flow F5: a private link's primary path is "Request to Join" with moderator
    // approval). Moderators can still opt into instant-join by passing
    // `autoApprove: true` explicitly at create time.
    const autoApprove = input.autoApprove ?? false;

    // `autoApprove: true` is not an ordinary link option on a PRIVATE community
    // — it BYPASSES the join-request queue, which is the only thing that makes
    // the community private. Link creation itself is open to every ACTIVE member
    // (MEMBER included), so without this a rank-and-file member could mint a
    // link that lets anyone holding it walk straight in, with no moderator ever
    // seeing a request. Deciding who gets in is a moderation power, so it takes
    // a moderation role. PUBLIC communities are unaffected: anyone can join them
    // anyway, so auto-approve grants nothing that isn't already available.
    if (autoApprove && community.type === CommunityType.PRIVATE) {
      assertCommunityRole(membership, CommunityMemberRole.MODERATOR);
    }

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

    return toInviteLinkData(row, community);
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
    assertCommunityRole(membership, CommunityMemberRole.MEMBER);

    const { rows, total } = await communityRepository.listInviteLinks({
      communityId,
      status: params.status,
      page: params.page,
      limit: params.limit,
    });
    return buildPaginatedResponse(
      rows.map((row) => toInviteLinkData(row, community)),
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
      return toInviteLinkData(link, community); // idempotent
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

    return toInviteLinkData(updated, community);
  },

  /**
   * The community's shareable invite link: the first ACTIVE link if one exists,
   * otherwise a freshly minted permanent (never-expiring, unlimited-use) one.
   *
   * Shared by every path that needs a code to put on an invitation card — the
   * invite-link Bulk Send and the direct member-invite fan-out — so both hand
   * chat-service a link that resolves identically on the receiving end.
   */
  async resolveOrCreateShareableLink(
    communityId: string,
    callerId: string
  ): Promise<CommunityInviteLink> {
    const { rows } = await communityRepository.listInviteLinks({
      communityId,
      status: "active",
      page: 1,
      limit: 1,
    });
    if (rows.length > 0) return rows[0]!;

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
    return created;
  },

  /**
   * Bulk-share a community invite link via system DMs.
   *
   * 1. Validates the caller is an ACTIVE member (any role — MEMBER/MOD/ADMIN).
   * 2. Resolves or creates one active invite link to share (must belong to THIS
   *    community and be active — a Community A member cannot send a Community B link).
   * 3. Fires one `community.invite_link_shared` RabbitMQ event per ELIGIBLE userId
   *    (→ chat-service consumes and delivers a system DM). Events are emitted ONLY
   *    for successfully-processed recipients (`sentUserIds`), never for failures.
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
    summary: {
      requested: number;
      sent: number;
      failed: number;
      skipped: number;
    };
    sentUserIds: string[];
    failures: { userId: string; code: string; message: string }[];
    /** Back-compat with the original contract (= summary.sent / summary.skipped). */
    queued: number;
    skipped: number;
  }> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Authorization: ANY ACTIVE member may share a link. Same membership-state
    // rule as createInviteLink — non-members and non-ACTIVE statuses (PENDING /
    // BANNED / LEFT) are rejected; every role is admitted.
    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MEMBER);
    communityAccessPolicy.assertWritable(community);

    // Per-user bulk-send rate limit (429 when exceeded) — bounds DM spam now
    // that every member can fan out invites.
    await assertInviteBulkSendRateLimit(callerId);

    // --- Resolve or create the invite link -----------------------------------

    let linkRow: CommunityInviteLink | null;

    if (input.linkId) {
      // Caller specified a particular link — validate it.
      linkRow = await communityRepository.findInviteLinkById(input.linkId);
      if (!linkRow || linkRow.communityId !== communityId) {
        // Permanent invitation links have no CommunityInviteLink DB row — their
        // sentinel linkId equals communityId. Synthesize a compatible row from
        // the community's invitationCode so downstream code can treat both paths
        // uniformly (code, isPermanent flag, audit id, etc. all work correctly).
        if (input.linkId === communityId && community.invitationCode) {
          linkRow = {
            id: communityId,
            code: community.invitationCode,
            communityId,
            createdBy: community.adminId,
            maxUses: null,
            usedCount: 0,
            autoApprove: false,
            expiresAt: null,
            revokedAt: null,
            createdAt: community.invitationCodeCreatedAt ?? community.createdAt,
          } as CommunityInviteLink;
        } else {
          throw new NotFoundError("COMMUNITY_INVITE_LINK_NOT_FOUND");
        }
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
      linkRow = await this.resolveOrCreateShareableLink(communityId, callerId);
    }

    // --- Validate recipients, then fan out one event per ELIGIBLE recipient ---
    //
    // Normalize + dedupe the requested UUIDs, then resolve each recipient's
    // eligibility in two batch lookups (NOT per-user): existence in user-service
    // and membership in THIS community. The DTO already guarantees well-formed
    // UUIDs; this layer separates the remaining per-user outcomes so one bad id
    // never hides the valid ones (non-atomic, partial-success contract).
    const requestedIds = [...new Set(input.userIds)];

    // A user never receives their own invite — counted as skipped, not failed.
    const candidateIds = requestedIds.filter((id) => id !== callerId);
    const selfSkipped = requestedIds.length - candidateIds.length;

    const [existingIds, memberRows] = await Promise.all([
      fetchExistingUserIds(candidateIds),
      candidateIds.length
        ? communityRepository.findMembersByUserIds(communityId, candidateIds)
        : Promise.resolve(
            [] as Awaited<
              ReturnType<typeof communityRepository.findMembersByUserIds>
            >
          ),
    ]);
    const memberByUserId = new Map(memberRows.map((m) => [m.userId, m]));

    const failures: { userId: string; code: string; message: string }[] = [];
    const sentUserIds: string[] = [];
    const eventAt = new Date().toISOString();

    // Build the shareable link DTO ONCE (reused for the response AND each DM
    // event), and resolve the inviter's identity ONCE (single batch gRPC, NOT
    // per-recipient) so the invitation card + push can show "<inviter> invited
    // you…" with no N+1. Both are best-effort: a missing snapshot leaves the
    // name/avatar blank and the DM still delivers.
    const linkData = toInviteLinkData(linkRow, community);
    const inviterSnapshot = (await fetchUserSnapshotHits([callerId])).get(
      callerId
    );
    const isPermanentLink =
      linkRow.expiresAt === null && linkRow.maxUses === null;

    for (const recipientId of candidateIds) {
      // `existingIds === null` means the user-service lookup was UNAVAILABLE
      // (circuit open / transient gRPC error). Fail OPEN there — a verification
      // blip must not block an otherwise-valid bulk send (the recipient still
      // re-validates on redeem). When the lookup succeeded, an absent id is a
      // genuine non-existent user and is reported precisely.
      if (existingIds && !existingIds.has(recipientId)) {
        failures.push({
          userId: recipientId,
          code: "USER_NOT_FOUND",
          message: "User does not exist",
        });
        continue;
      }

      const member = memberByUserId.get(recipientId);
      if (member?.status === CommunityMemberStatus.BANNED) {
        failures.push({
          userId: recipientId,
          code: "USER_BANNED",
          message: "User is banned from this community",
        });
        continue;
      }
      if (member?.status === CommunityMemberStatus.ACTIVE) {
        failures.push({
          userId: recipientId,
          code: "ALREADY_MEMBER",
          message: "User is already a member of this community",
        });
        continue;
      }

      // Eligible (new, or a previously-LEFT member who may rejoin) → fan out.
      // Existing fields are UNCHANGED; the enrichment fields are additive so the
      // chat-service consumer can render a rich card + push with no extra lookup.
      publishCommunityInviteLinkSharedForChatSafe({
        communityId,
        communityName: community.name,
        communityHandle: community.handle,
        linkCode: linkRow.code,
        inviterId: callerId,
        recipientId,
        eventAt,
        communityAvatarUrl: community.avatarUrl ?? null,
        memberCount: community.memberCount,
        inviteUrl: linkData.url,
        inviteDeepLink: linkData.appDeepLink,
        isPermanent: isPermanentLink,
        inviterName: inviterSnapshot?.displayName,
        inviterAvatarUrl: inviterSnapshot?.avatarObjectKey ?? null,
      });
      sentUserIds.push(recipientId);
    }

    // Audit the bulk-send (every member can now do this, so it must be traceable).
    // Recorded once per request with per-recipient outcome counts — never with
    // the full recipient list in the public response, only in the audit trail.
    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "INVITE_LINK_BULK_SENT",
      metadata: {
        linkId: linkRow.id,
        requested: requestedIds.length,
        sent: sentUserIds.length,
        failed: failures.length,
        skipped: selfSkipped,
      },
    });

    return {
      link: linkData,
      summary: {
        requested: requestedIds.length,
        sent: sentUserIds.length,
        failed: failures.length,
        skipped: selfSkipped,
      },
      sentUserIds,
      failures,
      // Back-compat aliases for the original { queued, skipped } shape.
      queued: sentUserIds.length,
      skipped: selfSkipped,
    };
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
    if (!link) {
      // Fallback: check if this is the community's permanent invitation code.
      // Permanent codes are stored on the Community row, not in CommunityInviteLink.
      const communityByCode =
        await communityRepository.findCommunityByInvitationCode(code);
      if (!communityByCode)
        throw new NotFoundError("COMMUNITY_INVITE_LINK_NOT_FOUND");
      return this.redeemPermanentInviteCode(code, communityByCode, callerId);
    }
    assertInviteLinkActive(link);

    const community = await communityRepository.findById(link.communityId);
    if (!community) throw new NotFoundError("COMMUNITY_NOT_FOUND");
    communityAccessPolicy.assertWritable(community);

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
        link: toInviteLinkData(link, community),
        member: await toMemberData(existing),
      };
    }

    // A redeem only consumes a usage slot when it produces a REAL join effect:
    // a new/reactivated membership (autoApprove) or a NEW/recycled join request.
    // An idempotent re-tap (already ACTIVE — handled above; or already PENDING —
    // handled below) must NOT burn a use, otherwise a single user re-tapping a
    // maxUses-limited link would prematurely exhaust it for everyone.
    const burnUsageSlot = async (): Promise<void> => {
      // Atomic capacity-guarded increment — if count === 0, another redeemer
      // beat us across the line and the link is now exhausted.
      const incRes = await communityRepository.incrementInviteLinkUsageIfUnder(
        link.id
      );
      if (incRes.count === 0) {
        throw new GoneError("COMMUNITY_INVITE_LINK_EXHAUSTED");
      }
      // Audit only when a use is actually consumed.
      await this.recordAudit({
        communityId: community.id,
        actorId: callerId,
        action: "INVITE_LINK_REDEEMED",
        targetUserId: callerId,
        metadata: { linkId: link.id, code: link.code },
      });
    };

    if (link.autoApprove) {
      // autoApprove=true always creates/reactivates a membership → consume a use.
      await burnUsageSlot();
      const updatedLink = await communityRepository.findInviteLinkById(link.id);
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

      // Self-join via invite link: enriched member_added (moderator awareness) +
      // roster broadcast + COMMUNITY_JOINED personal system message.
      // actor === target, so the notifications consumer still welcomes the
      // joiner (welcome is skipped only for join_request_approved).
      await this.notifyMemberJoined({
        community,
        member,
        memberCount: count,
        actorId: member.userId,
        via: "invite_link_redeem",
        requestId: undefined,
        eventAt: new Date().toISOString(),
      });
      // COMMUNITY_JOINED personal system message is now emitted inside
      // notifyMemberJoined() above — no separate call needed here.

      return {
        link: toInviteLinkData(updatedLink!, community),
        member: await toMemberData(member),
      };
    }

    // autoApprove=false (default): create a join request through approval flow.
    // Only consume a usage slot for a NEW or recycled request — an existing
    // PENDING request is returned idempotently and must not burn a use.
    const existingRequest =
      await communityRepository.findJoinRequestByCommunityAndUser(
        community.id,
        callerId
      );
    const willCreateOrRecycle =
      !existingRequest ||
      existingRequest.status !== CommunityJoinReqStatus.PENDING;
    if (willCreateOrRecycle) {
      await burnUsageSlot();
    }

    const joinResult = await this.createJoinRequest(
      community.id,
      callerId,
      null
    );
    const updatedLink = await communityRepository.findInviteLinkById(link.id);

    return {
      link: toInviteLinkData(updatedLink!, community),
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

    // Permanent-code fallback: if no CommunityInviteLink row owns this code,
    // check whether it is the community's permanent invitation code instead.
    // Permanent codes are never revoked/expired/exhausted, so assertInviteLinkActive
    // is intentionally skipped.
    if (!link) {
      const communityByCode =
        await communityRepository.findCommunityByInvitationCode(code);
      if (!communityByCode)
        throw new NotFoundError("COMMUNITY_INVITE_LINK_NOT_FOUND");

      const membership = await communityRepository.findMemberByUserId(
        communityByCode.id,
        callerId
      );
      if (membership?.status === CommunityMemberStatus.BANNED) {
        throw new ForbiddenError("COMMUNITY_JOIN_BANNED");
      }
      const isJoinedPerm = membership?.status === CommunityMemberStatus.ACTIVE;

      const pendingRequestPerm =
        !isJoinedPerm && callerId
          ? await communityRepository.findJoinRequestByCommunityAndUser(
              communityByCode.id,
              callerId
            )
          : null;
      const pendingRowPerm =
        pendingRequestPerm?.status === "PENDING" ? pendingRequestPerm : null;

      const avatarViewPerm =
        await communityImageService.resolveViewUrlForClient(
          communityByCode.avatarUrl
        );
      const coverViewPerm = await communityImageService.resolveViewUrlForClient(
        communityByCode.coverUrl
      );

      return {
        communityId: communityByCode.id,
        communityHandle: communityByCode.handle,
        communityName: communityByCode.name,
        description: communityByCode.description ?? null,
        avatarUrl: avatarViewPerm?.url ?? null,
        bannerUrl: coverViewPerm?.url ?? null,
        memberCount: communityByCode.memberCount,
        communityType: communityByCode.type,
        isJoined: isJoinedPerm,
        joinRequestId: pendingRowPerm?.id ?? null,
        joinRequestStatus: pendingRowPerm ? ("PENDING" as const) : null,
        invitationCode: code,
        inviteUrl: buildInviteUrl(code),
        appDeepLink: buildInviteDeepLink(code),
        expiresAt: null, // permanent links never expire
        creatorId: communityByCode.adminId,
      };
    }

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

    const pendingRequest =
      !isJoined && callerId
        ? await communityRepository.findJoinRequestByCommunityAndUser(
            community.id,
            callerId
          )
        : null;
    const pendingRow =
      pendingRequest?.status === "PENDING" ? pendingRequest : null;

    const avatarView = await communityImageService.resolveViewUrlForClient(
      community.avatarUrl
    );
    const coverView = await communityImageService.resolveViewUrlForClient(
      community.coverUrl
    );

    return {
      communityId: community.id,
      communityHandle: community.handle,
      communityName: community.name,
      description: community.description ?? null,
      avatarUrl: avatarView?.url ?? null,
      bannerUrl: coverView?.url ?? null,
      memberCount: community.memberCount,
      communityType: community.type,
      isJoined,
      joinRequestId: pendingRow?.id ?? null,
      joinRequestStatus: pendingRow ? ("PENDING" as const) : null,
      invitationCode: code,
      inviteUrl: buildInviteUrl(code),
      appDeepLink: buildInviteDeepLink(code),
      expiresAt: link.expiresAt ? link.expiresAt.getTime() : null,
      creatorId: link.createdBy,
    };
  },
};
