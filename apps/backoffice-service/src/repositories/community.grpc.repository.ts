import { ConflictError, NotFoundError } from "@aimess/errors";

import {
  communityClient,
  type AdminListCommunitiesReq,
  type AdminCommunityDetailRes,
  type RawAdminCommunityRow,
} from "../grpc/community.client.js";
import type {
  AccountStatus,
  BulkResult,
  CloseInput,
  CommunityDetail,
  CommunityListItem,
  CommunityModerationHistoryItem,
  CommunityModerationStatus,
  CommunityType,
  ListCommunitiesQuery,
  Paginated,
  PaginationMeta,
  ReopenInput,
} from "../types/community.types.js";
import {
  runBulk,
  type ActorRef,
  type CommunityRepository,
  type RepoCloseResult,
  type RepoMemberModerationResult,
  type RepoReopenResult,
} from "./community.repository.js";
import { moderationActionRepository } from "./moderation-action.repository.js";
import { msToEpoch, orNull } from "../lib/grpc-view.js";
import {
  resolveAvatarOrNull,
  resolveCommunityImageOrNull,
  resolveCommunityImageUrl,
} from "../lib/avatar-media.js";
import { streamClient } from "../grpc/stream.client.js";

/**
 * Total stream count for a community — every stream ever conducted (ended)
 * plus any currently live, via stream-service's AdminListStreams with no
 * status filter (only `total` is needed, so limit:1). Fail-open to 0 on a
 * stream-service outage — this is enrichment on the community detail page,
 * not core data, and must not break the page.
 */
async function fetchLiveStreamCount(communityId: string): Promise<number> {
  try {
    const { total } = await streamClient.adminListStreams({
      communityId,
      // LIVE only. Without this the detail counted every stream the community
      // had ever hosted, so a community whose broadcasts had all ended still
      // reported them as livestreams — and disagreed with the list column,
      // which is explicitly "active livestreams / max".
      status: "LIVE",
      page: 1,
      limit: 1,
    });
    return total;
  } catch {
    return 0;
  }
}

// Community admin/owner snapshot avatars live in the SHARED avatars bucket
// (`avatars/<userId>/…`). community-service now resolves these on its admin
// RPCs; backoffice resolves AGAIN at its own OUTPUT boundary as
// defense-in-depth (via @link resolveAvatarMediaObject / @link
// resolveCommunityImageMediaObject in lib/avatar-media.ts), so the admin API
// can never leak a raw key even if an upstream path regresses. Presigned URLs
// expire — never persist them.

/** Map an AdminCommunityRow → the list-table view model. */
async function rowToListItem(
  r: RawAdminCommunityRow,
  /** LIVE stream count from stream-service; the gRPC row's own field is a stub. */
  liveStreamCount: number
): Promise<CommunityListItem> {
  const status = r.status as CommunityModerationStatus;
  const [adminAvatar, avatar] = await Promise.all([
    resolveAvatarOrNull(r.adminAvatarUrl),
    resolveCommunityImageOrNull(r.communityAvatarUrl),
  ]);
  return {
    communityId: r.communityId,
    communityName: r.name,
    // Community's own avatar/profile image (community bucket) —
    // project-standard MediaObject, same shape as admin.avatar. Resolve-on-read
    // defense-in-depth.
    avatar,
    admin: {
      userId: r.adminId,
      name: r.adminName,
      avatar: adminAvatar,
    },
    type: r.type as CommunityType,
    category: { id: r.categoryId, name: r.categoryName, slug: r.categorySlug },
    status,
    closedReasonCode: r.statusClosedReasonCode || null,
    memberCount: r.memberCount,
    livestreamCount: {
      value: liveStreamCount,
      max: 5,
      stale: false,
    },
    createdAt: msToEpoch(r.createdAt),
    actions: {
      canView: true,
      canClose: status === "ACTIVE",
      canReopen: status === "CLOSED",
    },
  };
}

/**
 * gRPC-backed Community repository (Phase 2). Pulls the entity + aggregates
 * from community-service over gRPC and composes moderationHistory from
 * backoffice's own admin_db. Implements the SAME contract as
 * MockCommunityRepository so the singleton swap is the entire migration.
 */
export class GrpcCommunityRepository implements CommunityRepository {
  async list(
    query: ListCommunitiesQuery
  ): Promise<Paginated<CommunityListItem>> {
    const [sortField, sortDir] = (query.sort ?? "createdAt:desc").split(":");
    const req: AdminListCommunitiesReq = {
      search: query.search ?? "",
      type: query.type ?? "",
      category: query.category ?? "",
      status: query.status ?? "",
      createdFrom: query.createdFrom ?? "",
      createdTo: query.createdTo ?? "",
      sortField: sortField ?? "createdAt",
      sortDir: sortDir ?? "desc",
      page: query.page,
      limit: query.limit,
    };

    const res = await communityClient.adminListCommunities(req);
    const total = res.total;
    const { page, limit } = query;
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const hasNext = start + limit < total;

    const pagination: PaginationMeta = {
      mode: "offset",
      page,
      limit,
      total,
      totalApprox: total,
      totalPages,
      hasNext,
      hasPrev: page > 1,
      nextCursor: null,
    };

    // ONE call for the whole page: community-service still reports
    // livestream_count as a hardcoded 0 (the field is documented as a stub), so
    // the column showed 0/5 for every community. stream-service owns the real
    // number and already has a batched RPC for exactly this.
    const rows = res.communities ?? [];
    const liveCounts = await streamClient.getActiveStreamCountsByCommunityIds(
      rows.map((r) => r.communityId)
    );

    return {
      data: await Promise.all(
        rows.map((r) => rowToListItem(r, liveCounts.get(r.communityId) ?? 0))
      ),
      pagination,
    };
  }

  async getById(id: string): Promise<CommunityDetail | null> {
    const res = await communityClient.adminGetCommunity(id);
    if (!res.found || !res.community) return null;

    const moderationHistory = await this.loadHistory(id);
    return this.toDetail(res, res.community, moderationHistory);
  }

  async close(
    id: string,
    input: CloseInput,
    actor: ActorRef
  ): Promise<RepoCloseResult> {
    const res = await communityClient.adminSetModerationStatus({
      communityId: id,
      status: "SUSPENDED",
      reasonCode: input.reasonCode,
      actorAdminId: actor.moderator.adminId,
    });
    if (res.errorCode) throw mapModerationError(res.errorCode);

    return {
      communityId: id,
      status: "CLOSED",
      closedAt: msToEpoch(res.closedAt),
      reasonCode: input.reasonCode,
    };
  }

  async reopen(
    id: string,
    _input: ReopenInput,
    actor: ActorRef
  ): Promise<RepoReopenResult> {
    const res = await communityClient.adminSetModerationStatus({
      communityId: id,
      status: "ACTIVE",
      reasonCode: "",
      actorAdminId: actor.moderator.adminId,
    });
    if (res.errorCode) throw mapModerationError(res.errorCode);

    return {
      communityId: id,
      status: "ACTIVE",
      reopenedAt: Date.now(),
    };
  }

  async bulkClose(
    ids: string[],
    input: CloseInput,
    actor: ActorRef
  ): Promise<BulkResult> {
    return runBulk(ids, (id) => this.close(id, input, actor));
  }

  async bulkReopen(
    ids: string[],
    input: ReopenInput,
    actor: ActorRef
  ): Promise<BulkResult> {
    return runBulk(ids, (id) => this.reopen(id, input, actor));
  }

  async kickMember(
    communityId: string,
    targetUserId: string,
    reason: string | undefined,
    actor: ActorRef
  ): Promise<RepoMemberModerationResult> {
    const res = await communityClient.adminKickCommunityMember({
      communityId,
      targetUserId,
      reason: reason ?? "",
      actorAdminId: actor.moderator.adminId,
    });
    if (res.errorCode) throw mapMemberModerationError(res.errorCode);
    return { communityId, targetUserId, status: res.status };
  }

  async banMember(
    communityId: string,
    targetUserId: string,
    reason: string | undefined,
    actor: ActorRef
  ): Promise<RepoMemberModerationResult> {
    const res = await communityClient.adminBanCommunityMember({
      communityId,
      targetUserId,
      reason: reason ?? "",
      actorAdminId: actor.moderator.adminId,
    });
    if (res.errorCode) throw mapMemberModerationError(res.errorCode);
    return { communityId, targetUserId, status: res.status };
  }

  async unbanMember(
    communityId: string,
    targetUserId: string,
    actor: ActorRef
  ): Promise<RepoMemberModerationResult> {
    const res = await communityClient.adminUnbanCommunityMember({
      communityId,
      targetUserId,
      actorAdminId: actor.moderator.adminId,
    });
    if (res.errorCode) throw mapMemberModerationError(res.errorCode);
    return { communityId, targetUserId, status: res.status };
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  /** Compose moderationHistory from admin_db ModerationAction rows. */
  private async loadHistory(
    id: string
  ): Promise<CommunityModerationHistoryItem[]> {
    const rows = await moderationActionRepository.listByTarget(
      "community",
      id,
      50
    );
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      reason: row.reason,
      // Actor display name isn't on the row yet — use actorId as name, matching
      // community.service's toModerator().
      actor: { adminId: row.actorId, name: row.actorId },
      createdAt: row.createdAt.getTime(),
      metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    }));
  }

  /** Map the gRPC detail payload → the CommunityDetail view model. */
  private async toDetail(
    res: AdminCommunityDetailRes,
    row: RawAdminCommunityRow,
    moderationHistory: CommunityModerationHistoryItem[]
  ): Promise<CommunityDetail> {
    const status = row.status as CommunityModerationStatus;
    const type = row.type as CommunityType;
    const category = {
      id: row.categoryId,
      name: row.categoryName,
      slug: row.categorySlug,
    };
    const createdAt = msToEpoch(row.createdAt);

    // Resolve-on-read: the detail RPC echoes the RAW admin snapshot avatar key
    // (shared avatars bucket), unlike adminListCommunities which presigns it.
    // Community avatar is resolved with the SAME helper as rowToListItem
    // (resolveCommunityImageOrNull) so list and detail return identical shapes.
    const [ownerAvatar, avatar, coverUrl, liveCount] = await Promise.all([
      resolveAvatarOrNull(row.adminAvatarUrl),
      resolveCommunityImageOrNull(row.communityAvatarUrl),
      resolveCommunityImageUrl(res.coverUrl),
      fetchLiveStreamCount(row.communityId),
    ]);

    return {
      community: {
        communityId: row.communityId,
        name: row.name,
        handle: row.handle,
        description: orNull(res.description),
        type,
        category,
        status,
        // Community's own avatar/profile image — same field + same
        // resolveCommunityImageOrNull helper as rowToListItem (list API).
        avatar,
        // Defense-in-depth: community-service resolves the cover on its admin RPC;
        // resolve again here (idempotent passthrough when already a URL) so the
        // admin API can't leak a raw key. Community bucket; never persisted.
        coverUrl,
        createdAt,
        // Fall back to createdAt when the community has no recorded activity
        // (proto sends 0 → would otherwise render as the 1970 epoch).
        lastActivityAt:
          Number(res.lastActivityAt) > 0
            ? msToEpoch(res.lastActivityAt)
            : createdAt,
        closedReasonCode: row.statusClosedReasonCode || null,
      },
      owner: {
        userId: row.adminId,
        displayName: row.adminName,
        username: row.adminUsername,
        avatar: ownerAvatar,
        email: orNull(res.ownerEmail),
        accountStatus: (res.ownerAccountStatus || "ACTIVE") as AccountStatus,
      },
      memberStats: {
        total: res.membersTotal,
        active: res.membersActive,
        pending: res.membersPending,
        banned: res.membersBanned,
        moderators: res.membersModerators,
        joinedLast7d: res.membersJoinedLast7d,
      },
      livestreamStats: {
        total: liveCount,
        live: liveCount,
        scheduled: 0,
        maxConcurrent: 5,
        stale: true,
      },
      moderationHistory,
      settingsSummary: {
        joinPolicy: res.joinPolicy,
        type,
        memberCount: row.memberCount,
        inviteLinksActive: res.activeInviteLinks,
        openReports: res.openReports,
        createdAt,
      },
      partial: false,
    };
  }
}

/**
 * Map a business error_code from AdminSetModerationStatus → the same error
 * types MockCommunityRepository throws, so runBulk maps them to client codes
 * identically. COMMUNITY_NOT_FOUND → NotFoundError; everything else (
 * COMMUNITY_ALREADY_CLOSED | COMMUNITY_NOT_CLOSED) → ConflictError(code).
 */
function mapModerationError(errorCode: string): Error {
  if (errorCode === "COMMUNITY_NOT_FOUND") {
    return new NotFoundError("COMMUNITY_NOT_FOUND");
  }
  return new ConflictError(errorCode);
}

/**
 * Same shape as {@link mapModerationError}, plus the member-not-found case.
 * COMMUNITY_MEMBER_NOT_BANNED (unban of a member who is not banned) falls
 * through to ConflictError, like the already-closed/not-closed cases.
 */
function mapMemberModerationError(errorCode: string): Error {
  if (
    errorCode === "COMMUNITY_NOT_FOUND" ||
    errorCode === "COMMUNITY_MEMBER_NOT_FOUND"
  ) {
    return new NotFoundError(errorCode);
  }
  return new ConflictError(errorCode);
}
