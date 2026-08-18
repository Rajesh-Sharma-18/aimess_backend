import { ConflictError, NotFoundError } from "@aimess/errors";

import { communityFixtures } from "./__fixtures__/communities.fixture.js";
// Phase 2 live repository. Type-only + a single call-time value import — the
// cycle (grpc repo imports the interface/ActorRef/runBulk from here) resolves
// in ESM because the class is only instantiated at module-eval time, after
// this file's exports are bound.
import { GrpcCommunityRepository } from "./community.grpc.repository.js";
import type {
  BulkResult,
  BulkResultItem,
  CloseInput,
  CloseResult,
  CommunityDetail,
  CommunityListItem,
  CommunityModerationStatus,
  ListCommunitiesQuery,
  ModerationActor,
  Paginated,
  PaginationMeta,
  ReopenInput,
  ReopenResult,
} from "../types/community.types.js";

/**
 * Repository contract for the Community Management read+moderation model.
 *
 * Phase 1 ships {@link MockCommunityRepository} (in-memory fixtures). Phase 2
 * will add a gRPC-backed repository (community-service for the entity, user
 * service for the owner, stream-service for live counts) — swapping the
 * singleton below is the ENTIRE migration; controllers/routes/validators and
 * the response shapes stay untouched.
 */
export interface CommunityRepository {
  list(query: ListCommunitiesQuery): Promise<Paginated<CommunityListItem>>;
  getById(id: string): Promise<CommunityDetail | null>;
  close(
    id: string,
    input: CloseInput,
    actor: ActorRef
  ): Promise<RepoCloseResult>;
  reopen(
    id: string,
    input: ReopenInput,
    actor: ActorRef
  ): Promise<RepoReopenResult>;
  bulkClose(
    ids: string[],
    input: CloseInput,
    actor: ActorRef
  ): Promise<BulkResult>;
  bulkReopen(
    ids: string[],
    input: ReopenInput,
    actor: ActorRef
  ): Promise<BulkResult>;
  kickMember(
    communityId: string,
    targetUserId: string,
    reason: string | undefined,
    actor: ActorRef
  ): Promise<RepoMemberModerationResult>;
  banMember(
    communityId: string,
    targetUserId: string,
    reason: string | undefined,
    actor: ActorRef
  ): Promise<RepoMemberModerationResult>;
  unbanMember(
    communityId: string,
    targetUserId: string,
    actor: ActorRef
  ): Promise<RepoMemberModerationResult>;
}

export interface RepoMemberModerationResult {
  communityId: string;
  targetUserId: string;
  status: string;
}

/** The acting admin (subset of req.admin) + a precomputed timestamp. */
export type ActorRef = {
  moderator: ModerationActor;
  /** epoch-ms timestamp the service captured for this mutation. */
  at: number;
};

/**
 * Domain result of close/reopen. The moderationActionId + auditLogId are filled
 * by the SERVICE (it owns the Prisma writes) — the repo returns the entity state
 * only. The service spreads these into the API-facing CloseResult/ReopenResult.
 */
export type RepoCloseResult = Omit<
  CloseResult,
  "moderationActionId" | "auditLogId"
>;
export type RepoReopenResult = Omit<
  ReopenResult,
  "moderationActionId" | "auditLogId"
>;

// ---------------------------------------------------------------------------
// Helpers (pure).
// ---------------------------------------------------------------------------

/**
 * Conflict codes this module intentionally raises for single-item moderation.
 * Used to gate which ConflictError messages may surface as client-facing bulk
 * error codes (see {@link MockCommunityRepository.runBulk}).
 */
const KNOWN_CONFLICT_CODES = new Set([
  "COMMUNITY_ALREADY_CLOSED",
  "COMMUNITY_NOT_CLOSED",
]);

/**
 * Shared per-item bulk runner used by BOTH repositories (Mock + gRPC) so the
 * close/reopen error→code mapping stays in one place (DRY). Loops the ids,
 * invokes `op` per id, and maps thrown ConflictError/NotFoundError to
 * client-facing result codes.
 */
export async function runBulk(
  ids: string[],
  op: (
    id: string
  ) => Promise<{ communityId: string; status: CommunityModerationStatus }>
): Promise<BulkResult> {
  const results: BulkResultItem[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      const r = await op(id);
      results.push({ communityId: id, status: r.status, ok: true });
      succeeded += 1;
    } catch (err) {
      failed += 1;
      // Only pass a ConflictError's message through as a client-facing code
      // when it is one of the conflict codes this module deliberately raises.
      // A stray ConflictError thrown elsewhere must NOT leak its arbitrary
      // message as a code — fall back to a generic BULK_ITEM_FAILED instead.
      const code =
        err instanceof ConflictError && KNOWN_CONFLICT_CODES.has(err.message)
          ? err.message
          : err instanceof NotFoundError
            ? "COMMUNITY_NOT_FOUND"
            : "BULK_ITEM_FAILED";
      const message =
        err instanceof Error ? err.message : "Unexpected bulk item error";
      results.push({ communityId: id, ok: false, error: { code, message } });
    }
  }

  return { requested: ids.length, succeeded, failed, results };
}

type SortField = "createdAt" | "name" | "memberCount" | "livestreamCount";

function parseSort(sort: string): { field: SortField; dir: 1 | -1 } {
  const [field, dir] = sort.split(":") as [SortField, "asc" | "desc"];
  return { field, dir: dir === "asc" ? 1 : -1 };
}

/** Project a full detail row to the list-table shape. */
function toListItem(c: CommunityDetail): CommunityListItem {
  const status = c.community.status;
  return {
    closedReasonCode: c.community.closedReasonCode,
    communityId: c.community.communityId,
    communityName: c.community.name,
    avatar: c.community.avatar,
    admin: {
      userId: c.owner.userId,
      name: c.owner.displayName,
      avatar: c.owner.avatar,
    },
    type: c.community.type,
    category: c.community.category,
    status,
    memberCount: c.settingsSummary.memberCount,
    livestreamCount: {
      value: c.livestreamStats?.live ?? 0,
      max: c.livestreamStats?.maxConcurrent ?? 5,
      stale: true,
    },
    createdAt: c.community.createdAt,
    actions: {
      canView: true,
      canClose: status === "ACTIVE",
      canReopen: status === "CLOSED",
    },
  };
}

/** Sort key for the `livestreamCount` whitelist field. */
function livestreamValueOf(c: CommunityDetail): number {
  return c.livestreamStats?.live ?? 0;
}

// ---------------------------------------------------------------------------
// Mock implementation.
// ---------------------------------------------------------------------------
export class MockCommunityRepository implements CommunityRepository {
  /** Mutable in-memory store — cloned from fixtures so close/reopen persist. */
  private readonly rows: CommunityDetail[];

  constructor(seed: CommunityDetail[] = communityFixtures) {
    // Deep clone so mutations during dev don't corrupt the imported module.
    this.rows = seed.map((c) => structuredClone(c));
  }

  list(query: ListCommunitiesQuery): Promise<Paginated<CommunityListItem>> {
    const filtered = this.applyFilters(query);
    const sorted = this.applySort(filtered, query.sort);
    return Promise.resolve(this.offsetPage(sorted, query));
  }

  getById(id: string): Promise<CommunityDetail | null> {
    const row = this.rows.find((c) => c.community.communityId === id) ?? null;
    return Promise.resolve(row ? structuredClone(row) : null);
  }

  close(
    id: string,
    input: CloseInput,
    actor: ActorRef
  ): Promise<RepoCloseResult> {
    const row = this.requireActive(id);

    row.community.status = "CLOSED";
    row.moderationHistory.push({
      id: `mh_${id}_${row.moderationHistory.length + 1}`,
      type: "suspend_community",
      reason: input.reasonNote ?? input.reasonCode,
      actor: actor.moderator,
      createdAt: actor.at,
      metadata: { reasonCode: input.reasonCode },
    });

    return Promise.resolve({
      communityId: row.community.communityId,
      status: "CLOSED",
      closedAt: actor.at,
      reasonCode: input.reasonCode,
    });
  }

  reopen(
    id: string,
    input: ReopenInput,
    actor: ActorRef
  ): Promise<RepoReopenResult> {
    const row = this.requireClosed(id);

    row.community.status = "ACTIVE";
    row.moderationHistory.push({
      id: `mh_${id}_${row.moderationHistory.length + 1}`,
      type: "reopen_community",
      reason: input.reasonNote ?? "Community reopened by admin",
      actor: actor.moderator,
      createdAt: actor.at,
      metadata: {},
    });

    return Promise.resolve({
      communityId: row.community.communityId,
      status: "ACTIVE",
      reopenedAt: actor.at,
    });
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

  // Member moderation has no fixture-backed member list to mutate (the mock
  // seeds communities only), so these just assert the community exists and
  // echo the resulting status — enough for the mock-mode request to succeed.
  kickMember(
    communityId: string,
    targetUserId: string,
    _reason: string | undefined,
    _actor: ActorRef
  ): Promise<RepoMemberModerationResult> {
    this.requireExisting(communityId);
    return Promise.resolve({ communityId, targetUserId, status: "LEFT" });
  }

  banMember(
    communityId: string,
    targetUserId: string,
    _reason: string | undefined,
    _actor: ActorRef
  ): Promise<RepoMemberModerationResult> {
    this.requireExisting(communityId);
    return Promise.resolve({ communityId, targetUserId, status: "BANNED" });
  }

  unbanMember(
    communityId: string,
    targetUserId: string,
    _actor: ActorRef
  ): Promise<RepoMemberModerationResult> {
    this.requireExisting(communityId);
    return Promise.resolve({ communityId, targetUserId, status: "LEFT" });
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------
  private requireExisting(id: string): CommunityDetail {
    const row = this.rows.find((c) => c.community.communityId === id);
    if (!row) throw new NotFoundError("COMMUNITY_NOT_FOUND");
    return row;
  }

  private requireActive(id: string): CommunityDetail {
    const row = this.rows.find((c) => c.community.communityId === id);
    if (!row) throw new NotFoundError("COMMUNITY_NOT_FOUND");
    if (row.community.status !== "ACTIVE") {
      throw new ConflictError("COMMUNITY_ALREADY_CLOSED");
    }
    return row;
  }

  private requireClosed(id: string): CommunityDetail {
    const row = this.rows.find((c) => c.community.communityId === id);
    if (!row) throw new NotFoundError("COMMUNITY_NOT_FOUND");
    if (row.community.status !== "CLOSED") {
      throw new ConflictError("COMMUNITY_NOT_CLOSED");
    }
    return row;
  }

  private applyFilters(query: ListCommunitiesQuery): CommunityDetail[] {
    const search = query.search?.toLowerCase();
    const from = query.createdFrom
      ? Date.parse(`${query.createdFrom}T00:00:00.000Z`)
      : null;
    // createdTo is inclusive on the whole day.
    const to = query.createdTo
      ? Date.parse(`${query.createdTo}T23:59:59.999Z`)
      : null;

    return this.rows.filter((c) => {
      if (query.type && c.community.type !== query.type) return false;
      if (query.status && c.community.status !== query.status) return false;
      if (query.category) {
        // Match by category slug OR id (case-insensitive).
        const cat = c.community.category;
        const needle = query.category.toLowerCase();
        if (
          cat.slug.toLowerCase() !== needle &&
          cat.id.toLowerCase() !== needle
        ) {
          return false;
        }
      }
      const created = c.community.createdAt;
      if (from !== null && created < from) return false;
      if (to !== null && created > to) return false;
      if (search) {
        // Search over community name OR admin (owner) name.
        const haystack = [c.community.name, c.owner.displayName]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }

  private applySort(rows: CommunityDetail[], sort: string): CommunityDetail[] {
    const { field, dir } = parseSort(sort);
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (field === "memberCount") {
        cmp = a.settingsSummary.memberCount - b.settingsSummary.memberCount;
      } else if (field === "livestreamCount") {
        cmp = livestreamValueOf(a) - livestreamValueOf(b);
      } else {
        const av = field === "name" ? a.community.name : a.community.createdAt;
        const bv = field === "name" ? b.community.name : b.community.createdAt;
        if (av < bv) cmp = -1;
        else if (av > bv) cmp = 1;
      }
      if (cmp !== 0) return cmp * dir;
      // Stable tiebreaker on communityId so pagination is deterministic.
      const aid = a.community.communityId;
      const bid = b.community.communityId;
      if (aid < bid) return -1;
      if (aid > bid) return 1;
      return 0;
    });
  }

  private offsetPage(
    sorted: CommunityDetail[],
    query: ListCommunitiesQuery
  ): Paginated<CommunityListItem> {
    const { page, limit } = query;
    const total = sorted.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const slice = sorted.slice(start, start + limit);
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
      // Community list is offset-only (no keyset cursor in Phase 1).
      nextCursor: null,
    };
    return { data: slice.map(toListItem), pagination };
  }
}

// Phase 2 — live gRPC; swap back to MockCommunityRepository for offline/demo.
export const communityRepository: CommunityRepository =
  new GrpcCommunityRepository();
