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
  type RepoReopenResult,
} from "./community.repository.js";
import { moderationActionRepository } from "./moderation-action.repository.js";

/** epoch-ms-as-string (longs:String) → ISO 8601. */
function msToIso(ms: string | number): string {
  return new Date(Number(ms)).toISOString();
}

/** "" → null normaliser for optional string fields the proto sends as "". */
function orNull(s: string | undefined): string | null {
  return s ? s : null;
}

/** Map an AdminCommunityRow → the list-table view model. */
function rowToListItem(r: RawAdminCommunityRow): CommunityListItem {
  const status = r.status as CommunityModerationStatus;
  return {
    communityId: r.communityId,
    communityName: r.name,
    admin: {
      userId: r.adminId,
      name: r.adminName,
      avatarUrl: orNull(r.adminAvatarUrl),
    },
    type: r.type as CommunityType,
    category: { id: r.categoryId, name: r.categoryName, slug: r.categorySlug },
    status,
    memberCount: r.memberCount,
    livestreamCount: {
      value: Number(r.livestreamCount),
      max: 5,
      stale: true,
    },
    createdAt: msToIso(r.createdAt),
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

    return {
      data: (res.communities ?? []).map(rowToListItem),
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
      closedAt: msToIso(res.closedAt),
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
      reopenedAt: new Date().toISOString(),
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
      createdAt: row.createdAt.toISOString(),
      metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    }));
  }

  /** Map the gRPC detail payload → the CommunityDetail view model. */
  private toDetail(
    res: AdminCommunityDetailRes,
    row: RawAdminCommunityRow,
    moderationHistory: CommunityModerationHistoryItem[]
  ): CommunityDetail {
    const status = row.status as CommunityModerationStatus;
    const type = row.type as CommunityType;
    const category = {
      id: row.categoryId,
      name: row.categoryName,
      slug: row.categorySlug,
    };
    const createdAt = msToIso(row.createdAt);
    // STUB livestream stats — stream-service is not wired yet (proto sends 0).
    const liveCount = Number(row.livestreamCount);

    return {
      community: {
        communityId: row.communityId,
        name: row.name,
        handle: row.handle,
        description: orNull(res.description),
        type,
        category,
        status,
        // The proto AdminCommunityRow carries no community avatar; only the
        // cover_url is sent on the detail payload.
        avatarUrl: null,
        coverUrl: orNull(res.coverUrl),
        createdAt,
        // Fall back to createdAt when the community has no recorded activity
        // (proto sends 0 → would otherwise render as the 1970 epoch).
        lastActivityAt:
          Number(res.lastActivityAt) > 0
            ? msToIso(res.lastActivityAt)
            : createdAt,
      },
      owner: {
        userId: row.adminId,
        displayName: row.adminName,
        username: row.adminUsername,
        avatarUrl: orNull(row.adminAvatarUrl),
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
