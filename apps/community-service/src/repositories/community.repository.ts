import { prisma } from "../config/prisma.js";
import {
  CommunityInviteStatus,
  CommunityJoinReqStatus,
  CommunityMemberRole,
  CommunityMemberStatus,
  CommunityModerationStatus,
  CommunityReportStatus,
  CommunityStatus,
  CommunityType,
  type CommunityMember,
  type Prisma,
} from "../generated/prisma/index.js";
import type { CommunityAuditAction } from "../types/community.types.js";
import { publishCommunityMemberSyncedForChatSafe } from "../messaging/publish-community-chat.js";

/**
 * The `select` shared by the V1 timestamp `listMineByActivity` and the V2
 * compound-keyset `listMineByActivityKeyset`. Both MUST return an identical row
 * shape so the single `enrichMineCommunities` serializer works for either
 * pagination axis. The caller's own membership role is pulled via the filtered
 * `members` include (dynamic on `userId`), which is why this is a factory.
 */
function mineActivitySelect(userId: string) {
  return {
    id: true,
    name: true,
    handle: true,
    type: true,
    memberCount: true,
    avatarUrl: true,
    lastActivityAt: true,
    lastActivityType: true,
    lastActivityPreview: true,
    lastActivityUsername: true,
    lastActivityUserId: true,
    lastActivitySelfPreview: true,
    lastActivityTargetUserId: true,
    lastActivityTargetPreview: true,
    lastActivityReactionAt: true,
    lastActivityReactionActorId: true,
    lastActivityReactionActorPreview: true,
    lastActivityReactionTargetId: true,
    lastActivityReactionTargetPreview: true,
    createdAt: true,
    moderationStatus: true,
    status: true,
    members: {
      where: { userId },
      select: { role: true, status: true, dismissedAt: true, bannedAt: true },
    },
  } satisfies Prisma.CommunitySelect;
}

export const communityRepository = {
  // ---------------------------------------------------------------------------
  // Categories
  // ---------------------------------------------------------------------------
  listActiveCategories() {
    return prisma.communityCategory.findMany({
      where: { active: true, deletedAt: { isSet: false } },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { id: true, name: true, slug: true },
    });
  },

  findActiveCategoryById(categoryId: string) {
    return prisma.communityCategory.findFirst({
      where: { id: categoryId, active: true, deletedAt: { isSet: false } },
      select: { id: true, name: true },
    });
  },

  /**
   * Batch fetch of communities by id for backoffice enrichment (the Livestream
   * Management list/detail joins community name + avatar + category onto each
   * stream in a single round-trip). Returns the RAW avatar object key — the
   * caller resolves it to a presigned URL. Soft-deleted communities are still
   * returned (admin context can surface streams from removed communities).
   * Callers must pre-filter to valid ObjectId strings.
   */
  async adminGetCommunitiesByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.community.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        categoryId: true,
        categoryName: true,
        memberCount: true,
        category: { select: { slug: true, name: true } },
      },
    });
  },

  /**
   * Admin Reports search: community ids whose name OR handle matches the search
   * term (case-insensitive, partial). Capped at 500 — the caller only needs an
   * id-set to filter by, not a page of results. Soft-deleted communities are
   * still matched (a report can reference a since-deleted community).
   */
  async adminSearchCommunityIds(search: string): Promise<string[]> {
    const term = search.trim();
    if (!term) return [];
    const rows = await prisma.community.findMany({
      where: {
        OR: [
          { name: { contains: term, mode: "insensitive" } },
          { handle: { contains: term, mode: "insensitive" } },
        ],
      },
      select: { id: true },
      take: 500,
    });
    return rows.map((r) => r.id);
  },

  // ---------------------------------------------------------------------------
  // Admin category CRUD
  // ---------------------------------------------------------------------------
  /**
   * `communityCount` (per category: communities with status=ACTIVE and
   * deletedAt unset) is a cross-collection aggregate, so it's computed via
   * {@link countActiveCommunitiesByCategoryIds} and merged in after the
   * category page/set is resolved rather than joined at the DB level.
   */
  async listCategoriesAdmin(params: {
    search?: string;
    active?: boolean;
    page: number;
    limit: number;
    sortField?: "name" | "order" | "createdAt" | "communityCount";
    sortDir?: "asc" | "desc";
  }) {
    const where: Prisma.CommunityCategoryWhereInput = {
      deletedAt: { isSet: false },
    };
    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: "insensitive" } },
        { description: { contains: params.search, mode: "insensitive" } },
      ];
    }
    if (params.active !== undefined) {
      where.active = params.active;
    }
    const sortDir = params.sortDir ?? "asc";
    const selectFields = {
      id: true,
      name: true,
      slug: true,
      active: true,
      order: true,
      createdAt: true,
      updatedAt: true,
    } satisfies Prisma.CommunityCategorySelect;

    // communityCount can't be sorted at the DB level (no denormalized field,
    // MongoDB can't orderBy an aggregated relation count) — fetch every
    // matching category, merge counts, sort, then paginate in-memory. Category
    // lists are curated/small (tens of rows), so this stays cheap.
    if (params.sortField === "communityCount") {
      const rows = await prisma.communityCategory.findMany({
        where,
        orderBy: [{ name: "asc" }],
        select: selectFields,
      });
      const counts = await this.countActiveCommunitiesByCategoryIds(
        rows.map((r) => r.id)
      );
      const withCount = rows
        .map((r) => ({ ...r, communityCount: counts.get(r.id) ?? 0 }))
        .sort((a, b) =>
          sortDir === "asc"
            ? a.communityCount - b.communityCount
            : b.communityCount - a.communityCount
        );
      const total = withCount.length;
      const skip = (params.page - 1) * params.limit;
      return [withCount.slice(skip, skip + params.limit), total] as const;
    }

    const sortField = params.sortField ?? "order";
    const orderBy: Prisma.CommunityCategoryOrderByWithRelationInput[] =
      sortField === "order"
        ? [{ order: sortDir }, { name: "asc" }]
        : [{ [sortField]: sortDir }];
    const skip = (params.page - 1) * params.limit;
    const [rows, total] = await Promise.all([
      prisma.communityCategory.findMany({
        where,
        orderBy,
        skip,
        take: params.limit,
        select: selectFields,
      }),
      prisma.communityCategory.count({ where }),
    ]);
    const counts = await this.countActiveCommunitiesByCategoryIds(
      rows.map((r) => r.id)
    );
    const withCount = rows.map((r) => ({
      ...r,
      communityCount: counts.get(r.id) ?? 0,
    }));
    return [withCount, total] as const;
  },

  /** Bulk per-category count of active/non-deleted communities — avoids N+1. */
  async countActiveCommunitiesByCategoryIds(
    categoryIds: string[]
  ): Promise<Map<string, number>> {
    if (categoryIds.length === 0) return new Map();
    const groups = await prisma.community.groupBy({
      by: ["categoryId"],
      where: {
        categoryId: { in: categoryIds },
        status: CommunityStatus.ACTIVE,
        deletedAt: { isSet: false },
      },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.categoryId, g._count._all]));
  },

  findCategoryByIdAdmin(id: string) {
    return prisma.communityCategory.findFirst({
      where: { id, deletedAt: { isSet: false } },
      select: {
        id: true,
        name: true,
        slug: true,
        active: true,
        order: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  },

  findCategoryByName(name: string, excludeId?: string) {
    return prisma.communityCategory.findFirst({
      where: {
        name: { equals: name, mode: "insensitive" },
        deletedAt: { isSet: false },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
  },

  createCategory(data: { name: string; slug: string }) {
    return prisma.communityCategory.create({
      data: { name: data.name, slug: data.slug, active: true },
      select: {
        id: true,
        name: true,
        slug: true,
        active: true,
        order: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  },

  updateCategoryById(
    id: string,
    data: { name?: string; slug?: string; active?: boolean }
  ) {
    return prisma.communityCategory.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        slug: true,
        active: true,
        order: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  },

  deleteCategoryById(id: string) {
    return prisma.communityCategory.delete({
      where: { id },
      select: { id: true, name: true, slug: true },
    });
  },

  /**
   * Permanent soft-delete for a category still referenced by communities —
   * same idiom as `Community.deletedAt`. Hides the category from every
   * category query (`deletedAt: { isSet: false }`) without breaking the
   * `categoryId` FK on communities still pointing at it.
   */
  softDeleteCategoryById(id: string) {
    return prisma.communityCategory.update({
      where: { id },
      data: { active: false, deletedAt: new Date() },
      select: { id: true, name: true, slug: true },
    });
  },

  countCommunitiesWithCategory(categoryId: string) {
    return prisma.community.count({
      where: { categoryId, deletedAt: { isSet: false } },
    });
  },

  /**
   * Count of communities in this category that are neither CLOSED nor
   * (soft-)deleted — the gate for the admin category-delete endpoint.
   */
  countActiveCommunitiesWithCategory(categoryId: string) {
    return prisma.community.count({
      where: {
        categoryId,
        status: CommunityStatus.ACTIVE,
        deletedAt: { isSet: false },
      },
    });
  },

  /**
   * Resolve an admin "category" filter token (slug OR ObjectId) to a category id.
   * The admin list filter accepts either form; communities store `categoryId`, so
   * a slug must be resolved before filtering. Returns null when no match.
   */
  async findActiveCategoryBySlugOrId(slugOrId: string) {
    const row = await prisma.communityCategory.findFirst({
      where: { OR: [{ id: slugOrId }, { slug: slugOrId }] },
      select: { id: true },
    });
    return row?.id ?? null;
  },

  // ---------------------------------------------------------------------------
  // Communities
  // ---------------------------------------------------------------------------
  // "Active" = deletedAt NOT set. Prisma omits unset optional fields on Mongo,
  // and `{ deletedAt: null }` does NOT match a missing field — so we filter on
  // `isSet: false`. Soft-delete sets a Date (never an explicit null).
  findById(id: string) {
    return prisma.community.findFirst({
      where: { id, deletedAt: { isSet: false } },
      include: { category: { select: { id: true, name: true } } },
    });
  },

  findManyByIds(ids: string[]) {
    return prisma.community.findMany({
      where: { id: { in: ids } },
      include: { category: { select: { id: true, name: true } } },
    });
  },

  /** Case-insensitive display-name lookup (uniqueness check). */
  findByName(name: string) {
    return prisma.community.findFirst({
      where: {
        deletedAt: { isSet: false },
        name: { equals: name, mode: "insensitive" },
      },
      select: { id: true },
    });
  },

  /** Case-insensitive handle lookup (uniqueness check). */
  findByHandle(handle: string) {
    return prisma.community.findFirst({
      where: {
        deletedAt: { isSet: false },
        handle: { equals: handle, mode: "insensitive" },
      },
      select: { id: true },
    });
  },

  /**
   * Full-row, case-insensitive handle lookup (with category) for the public
   * by-handle resolver. Unlike `findByHandle` (id-only uniqueness probe), this
   * returns the whole community so the service can apply PUBLIC/suspended gates
   * and serialize the preview.
   */
  findByHandleFull(handle: string) {
    return prisma.community.findFirst({
      where: {
        deletedAt: { isSet: false },
        handle: { equals: handle, mode: "insensitive" },
      },
      include: { category: { select: { id: true, name: true } } },
    });
  },

  createCommunity(data: {
    name: string;
    handle: string;
    description: string | null;
    type: CommunityType;
    categoryId: string;
    // Denormalized category name (kept in sync with categoryId) — backs the
    // admin list's DB-level category sort.
    categoryName: string;
    creatorId: string;
    adminId: string;
    avatarUrl: string | null;
    coverUrl: string | null;
  }) {
    return prisma.community.create({
      data: {
        ...data,
        memberCount: 1,
        lastActivityType: "created",
        // Canonical SYSTEM text — MUST match buildCommunitySystemFallbackText(
        // "COMMUNITY_CREATED") and buildLastActivity's "created" fallback so the
        // Mine / List / Sync APIs show the same string as the chat room from the
        // instant of creation (before the async community.activity event lands).
        lastActivityPreview: "Community created",
        lastActivityUsername: null,
      },
      include: { category: { select: { id: true, name: true } } },
    });
  },

  updateCommunity(id: string, data: Prisma.CommunityUpdateInput) {
    return prisma.community.update({
      where: { id },
      data,
      include: { category: { select: { id: true, name: true } } },
    });
  },

  setMemberCount(id: string, memberCount: number) {
    return prisma.community.update({
      where: { id },
      data: { memberCount },
    });
  },

  /** Transfer community ownership by setting a new adminId (auto-handover). */
  setCommunityAdmin(id: string, adminId: string) {
    return prisma.community.update({
      where: { id },
      data: { adminId },
    });
  },

  deleteCommunityHard(id: string) {
    return prisma.$transaction([
      prisma.communityMember.deleteMany({ where: { communityId: id } }),
      prisma.community.delete({ where: { id } }),
    ]);
  },

  /**
   * Count of active (non-soft-deleted) communities — admin dashboard aggregate.
   * Mongo: a soft delete sets `deletedAt` to a Date and the field is unset on
   * active rows, so `{ isSet: false }` matches active (NEVER `{ deletedAt: null }`).
   */
  countActiveCommunities() {
    return prisma.community.count({ where: { deletedAt: { isSet: false } } });
  },

  // ---------------------------------------------------------------------------
  // Members
  // ---------------------------------------------------------------------------
  async createMember(data: {
    communityId: string;
    userId: string;
    role: CommunityMemberRole;
    status: CommunityMemberStatus;
    snapshotUsername: string;
    snapshotDisplayName: string;
    snapshotAvatarKey: string | null;
  }) {
    const row = await prisma.communityMember.create({ data });
    publishCommunityMemberSyncedForChatSafe({
      communityId: data.communityId,
      userId: data.userId,
      status: data.status,
      role: data.role,
    });
    return row;
  },

  /** Bulk insert members (single-collection — safe without a replica set). */
  async createManyMembers(
    communityId: string,
    members: Array<{
      userId: string;
      role: CommunityMemberRole;
      status: CommunityMemberStatus;
      snapshotUsername: string;
      snapshotDisplayName: string;
      snapshotAvatarKey: string | null;
    }>
  ) {
    const result = await prisma.communityMember.createMany({
      data: members.map((m) => ({ communityId, ...m })),
    });
    for (const m of members) {
      publishCommunityMemberSyncedForChatSafe({
        communityId,
        userId: m.userId,
        status: m.status,
        role: m.role,
      });
    }
    return result;
  },

  deleteMembersForCommunity(communityId: string) {
    return prisma.communityMember.deleteMany({ where: { communityId } });
  },

  countActiveMembers(communityId: string) {
    return prisma.communityMember.count({
      where: { communityId, status: CommunityMemberStatus.ACTIVE },
    });
  },

  findMembership(communityId: string, userId: string) {
    return prisma.communityMember.findFirst({
      where: { communityId, userId },
      select: { role: true, status: true, removedAt: true },
    });
  },

  /**
   * The longest-tenured ACTIVE moderator (earliest joinedAt) — used to pick the
   * auto-handover successor when an admin leaves. Returns just the userId.
   */
  findOldestActiveModerator(communityId: string) {
    return prisma.communityMember.findFirst({
      where: {
        communityId,
        role: CommunityMemberRole.MODERATOR,
        status: CommunityMemberStatus.ACTIVE,
      },
      orderBy: { joinedAt: "asc" },
      select: { userId: true },
    });
  },

  /**
   * The longest-tenured ACTIVE plain MEMBER (earliest joinedAt), excluding the
   * given user — fallback auto-handover successor when no MODERATOR exists.
   * Returns just the userId.
   */
  findOldestActiveMember(communityId: string, excludeUserId: string) {
    return prisma.communityMember.findFirst({
      where: {
        communityId,
        role: CommunityMemberRole.MEMBER,
        status: CommunityMemberStatus.ACTIVE,
        userId: { not: excludeUserId },
      },
      orderBy: { joinedAt: "asc" },
      select: { userId: true },
    });
  },

  /**
   * Bulk-mark every ACTIVE member of a community as LEFT — used by community
   * soft-delete to evict the roster in a single write. Returns the Prisma
   * batch payload (count of rows updated).
   */
  markAllActiveMembersLeft(communityId: string) {
    return prisma.communityMember.updateMany({
      where: { communityId, status: CommunityMemberStatus.ACTIVE },
      data: { status: CommunityMemberStatus.LEFT },
    });
  },

  findActiveMembershipsByCommunityIds(userId: string, communityIds: string[]) {
    return prisma.communityMember.findMany({
      where: {
        userId,
        communityId: { in: communityIds },
        status: CommunityMemberStatus.ACTIVE,
      },
      select: { communityId: true },
    });
  },

  /** Like `findActiveMembershipsByCommunityIds` but also includes `role` and
   *  `status` — used by bulk operations that need to branch on the caller's
   *  role per community (e.g. bulk leave admin-block check). */
  findActiveMembershipsWithRoleByCommunityIds(
    userId: string,
    communityIds: string[]
  ) {
    return prisma.communityMember.findMany({
      where: {
        userId,
        communityId: { in: communityIds },
        status: CommunityMemberStatus.ACTIVE,
      },
      select: { communityId: true, role: true, status: true },
    });
  },

  /** Like `findMembership` but also returns the row id, userId, and joinedAt. */
  findMemberByUserId(communityId: string, userId: string) {
    return prisma.communityMember.findFirst({
      where: { communityId, userId },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        snapshotUsername: true,
        snapshotDisplayName: true,
        snapshotAvatarKey: true,
        bannedAt: true,
        bannedBy: true,
        banReason: true,
        removedAt: true,
        removedBy: true,
        removedReason: true,
        dismissedAt: true,
      },
    });
  },

  /**
   * Existing membership rows for a set of userIds — used both to partition an
   * add-members request (skip ACTIVE/BANNED, reactivate LEFT, create missing)
   * and to build the API DTO for reactivated members from the in-hand row.
   * Selects `joinedAt` so reactivated members need no post-write re-read.
   * Index-supported by the (communityId, status) compound index.
   */
  findMembersByUserIds(communityId: string, userIds: string[]) {
    return prisma.communityMember.findMany({
      where: { communityId, userId: { in: userIds } },
      select: {
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        snapshotUsername: true,
        snapshotDisplayName: true,
        snapshotAvatarKey: true,
        bannedAt: true,
        bannedBy: true,
        banReason: true,
      },
    });
  },

  async reactivateMemberWithSnapshot(
    communityId: string,
    userId: string,
    snapshot: {
      snapshotUsername: string;
      snapshotDisplayName: string;
      snapshotAvatarKey: string | null;
    },
    // Role the member held before they LEFT. Callers read this off the
    // existing (pre-reactivation) row and pass it through so rejoining
    // preserves rank instead of silently resetting an ADMIN/MODERATOR to
    // MEMBER. Defaults to MEMBER only for the (should-not-happen) case of no
    // prior row.
    priorRole: CommunityMemberRole = CommunityMemberRole.MEMBER
  ) {
    const row = await prisma.communityMember.update({
      where: { communityId_userId: { communityId, userId } },
      data: {
        status: CommunityMemberStatus.ACTIVE,
        role: priorRole,
        // Rejoin starts a fresh membership: advance joinedAt to now so the member
        // list shows the LATEST join time, not the original (stale) one. joinedAt
        // is @default(now()) which only applies on create, so reactivation must
        // set it explicitly.
        joinedAt: new Date(),
        // Fresh membership also clears any stale kick/dismiss markers from the
        // previous membership cycle (removedAt is audit metadata for the OLD
        // cycle; dismissedAt only applies to a BANNED row).
        removedAt: { unset: true },
        removedBy: { unset: true },
        removedReason: { unset: true },
        dismissedAt: { unset: true },
        ...snapshot,
      },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        snapshotUsername: true,
        snapshotDisplayName: true,
        snapshotAvatarKey: true,
        bannedAt: true,
        bannedBy: true,
        banReason: true,
      },
    });
    // Re-add of a previously-LEFT member: mirror the reactivation into
    // chat-service's RoomMember so they regain send/read in the general room.
    // The other member-mutation methods (create/createMany/updateStatus/
    // updateRole) all publish this; reactivation must too or the row drifts.
    publishCommunityMemberSyncedForChatSafe({
      communityId,
      userId,
      status: CommunityMemberStatus.ACTIVE,
      role: row.role as CommunityMemberRole,
    });
    return row;
  },

  /**
   * Reopen helper: re-establish the community owner as the sole ACTIVE ADMIN
   * after a CLOSE evicted everyone (status → LEFT). Mirrors
   * `reactivateMemberWithSnapshot` but restores the ADMIN role (the owner), and
   * mirrors the reactivation into chat-service's RoomMember so the owner regains
   * send/read in the general room.
   */
  async reactivateAdminMember(
    communityId: string,
    userId: string,
    snapshot: {
      snapshotUsername: string;
      snapshotDisplayName: string;
      snapshotAvatarKey: string | null;
    }
  ) {
    const row = await prisma.communityMember.update({
      where: { communityId_userId: { communityId, userId } },
      data: {
        status: CommunityMemberStatus.ACTIVE,
        role: CommunityMemberRole.ADMIN,
        joinedAt: new Date(),
        removedAt: { unset: true },
        removedBy: { unset: true },
        removedReason: { unset: true },
        dismissedAt: { unset: true },
        ...snapshot,
      },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        snapshotUsername: true,
        snapshotDisplayName: true,
        snapshotAvatarKey: true,
        bannedAt: true,
        bannedBy: true,
        banReason: true,
      },
    });
    publishCommunityMemberSyncedForChatSafe({
      communityId,
      userId,
      status: CommunityMemberStatus.ACTIVE,
      role: CommunityMemberRole.ADMIN,
    });
    return row;
  },

  updateMemberSnapshotsByUserId(
    userId: string,
    snapshot: {
      snapshotUsername: string;
      snapshotDisplayName: string;
      snapshotAvatarKey: string | null;
    }
  ) {
    return prisma.communityMember.updateMany({
      where: { userId },
      data: snapshot,
    });
  },

  /** Find all ACTIVE communities a user is a member of, with their role. */
  async findUserMemberships(userId: string) {
    return prisma.communityMember.findMany({
      where: { userId, status: CommunityMemberStatus.ACTIVE },
      select: {
        communityId: true,
        role: true,
      },
    });
  },

  /** Single-document role update keyed by the (communityId, userId) unique. */
  async updateMemberRole(
    communityId: string,
    userId: string,
    role: CommunityMemberRole
  ) {
    const row = await prisma.communityMember.update({
      where: { communityId_userId: { communityId, userId } },
      data: { role },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        snapshotUsername: true,
        snapshotDisplayName: true,
        snapshotAvatarKey: true,
        bannedAt: true,
        bannedBy: true,
        banReason: true,
      },
    });
    publishCommunityMemberSyncedForChatSafe({ communityId, userId, role });
    return row;
  },

  /**
   * Single-document status update keyed by the (communityId, userId) unique.
   * Optionally also sets/clears the ban metadata (bannedAt/bannedBy/banReason)
   * in the same write — used by banMember (set) and unbanMember (clear to null).
   * `resetRole`, when passed, downgrades the stored role in the same write —
   * used by banMember so a banned MODERATOR/ADMIN can never have their rank
   * silently restored on a later reactivation (reactivateMemberWithSnapshot
   * reads its priorRole off this row).
   */
  async updateMemberStatus(
    communityId: string,
    userId: string,
    status: CommunityMemberStatus,
    banMeta?: {
      bannedAt: Date | null;
      bannedBy: string | null;
      banReason: string | null;
    },
    resetRole?: CommunityMemberRole,
    removedMeta?: {
      removedAt: Date | null;
      removedBy: string | null;
      removedReason: string | null;
    },
    // Unban passes true so a future re-ban shows up in the target's list again
    // (dismissedAt only ever applies to the ban cycle that set it).
    clearDismissed?: boolean
  ) {
    const row = await prisma.communityMember.update({
      where: { communityId_userId: { communityId, userId } },
      data: {
        status,
        ...(banMeta ?? {}),
        ...(resetRole ? { role: resetRole } : {}),
        ...(removedMeta ?? {}),
        ...(clearDismissed ? { dismissedAt: { unset: true } } : {}),
      },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        snapshotUsername: true,
        snapshotDisplayName: true,
        snapshotAvatarKey: true,
        bannedAt: true,
        bannedBy: true,
        banReason: true,
        removedAt: true,
        removedBy: true,
        removedReason: true,
      },
    });
    publishCommunityMemberSyncedForChatSafe({ communityId, userId, status });
    return row;
  },

  // ponytail: markRemovedFromList removed — removedAt not in generated client.
  // Re-add after `prisma generate` includes the field.

  /**
   * Hide a BANNED community from the member's own list (self-dismiss). Writes
   * ONLY `dismissedAt` — status stays BANNED and the ban metadata survives
   * (business rule: dismissing never lifts a ban; only an admin unban does).
   * No chat-sync publish: nothing membership-relevant changed for chat-service.
   */
  setMemberDismissed(communityId: string, userId: string) {
    return prisma.communityMember.update({
      where: { communityId_userId: { communityId, userId } },
      data: { dismissedAt: new Date() },
      select: { id: true },
    });
  },

  /**
   * Members of a community filtered by status — offset/page pagination on id.
   * Returns the page rows plus the total matching count.
   */
  /**
   * Active member userIds split by role — used to build notification recipient
   * rosters (admins/moderators for moderation events) at publish time.
   */
  async findActiveMemberIdsByRoles(
    communityId: string,
    roles: CommunityMemberRole[]
  ): Promise<string[]> {
    const rows = await prisma.communityMember.findMany({
      where: {
        communityId,
        status: CommunityMemberStatus.ACTIVE,
        role: { in: roles },
      },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  },

  /** All ACTIVE member userIds — used to notify everyone on community deletion. */
  async findActiveMemberIds(communityId: string): Promise<string[]> {
    const rows = await prisma.communityMember.findMany({
      where: { communityId, status: CommunityMemberStatus.ACTIVE },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  },

  /**
   * userIds in this community who have DISABLED livestream notifications
   * (CommunityMuteSetting.streamEnabled === false). Used to exclude them from the
   * livestream push fan-out. Default (no setting row) is enabled, so absence ⇒
   * eligible.
   */
  async findStreamMutedMemberIds(communityId: string): Promise<string[]> {
    const rows = await prisma.communityMuteSetting.findMany({
      where: { communityId, streamEnabled: false },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  },

  async listMembers(params: {
    communityId: string;
    callerId: string;
    status: CommunityMemberStatus;
    page: number;
    limit: number;
  }) {
    const where = {
      communityId: params.communityId,
      status: params.status,
    };

    const rawIds = (await prisma.communityMember.aggregateRaw({
      pipeline: [
        {
          $match: {
            communityId: { $oid: params.communityId },
            status: params.status,
          },
        },
        {
          $addFields: {
            _sortPriority: {
              $switch: {
                branches: [
                  { case: { $eq: ["$userId", params.callerId] }, then: 0 },
                  {
                    case: { $eq: ["$role", CommunityMemberRole.ADMIN] },
                    then: 1,
                  },
                  {
                    case: { $eq: ["$role", CommunityMemberRole.MODERATOR] },
                    then: 2,
                  },
                ],
                default: 3,
              },
            },
          },
        },
        { $sort: { _sortPriority: 1, _id: 1 } },
        { $skip: (params.page - 1) * params.limit },
        { $limit: params.limit },
        { $project: { _id: 1 } },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{ _id?: { $oid?: string } | string }>;
    const ids = rawIds
      .map((row) => (typeof row._id === "string" ? row._id : row._id?.$oid))
      .filter((id): id is string => Boolean(id));

    const [rows, total] = await Promise.all([
      ids.length
        ? prisma.communityMember.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              userId: true,
              role: true,
              status: true,
              joinedAt: true,
              snapshotUsername: true,
              snapshotDisplayName: true,
              snapshotAvatarKey: true,
              bannedAt: true,
              bannedBy: true,
              banReason: true,
            },
          })
        : Promise.resolve([]),
      prisma.communityMember.count({ where }),
    ]);

    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      rows: ids
        .map((id) => byId.get(id))
        .filter((row): row is (typeof rows)[number] => Boolean(row)),
      total,
    };
  },

  /**
   * Currently-banned members of a community (status === BANNED only), with
   * optional free-text search and sort. Search matches displayName / username /
   * userId case-insensitively. Index-supported by [communityId, status] (+
   * [communityId, status, bannedAt] / [communityId, status, snapshotDisplayName]
   * for the sort). Returns the page rows plus the total matching count.
   *
   * Lifted bans are not BANNED anymore (unban sets status → LEFT) so they never
   * appear here — the historical record lives in the moderation audit log.
   */
  async listBannedMembers(params: {
    communityId: string;
    search?: string;
    sortBy: "bannedAt" | "displayName" | "username";
    sortOrder: "asc" | "desc";
    page: number;
    limit: number;
  }) {
    const where: Prisma.CommunityMemberWhereInput = {
      communityId: params.communityId,
      status: CommunityMemberStatus.BANNED,
    };

    if (params.search) {
      const term = params.search.trim();
      where.OR = [
        { snapshotDisplayName: { contains: term, mode: "insensitive" } },
        { snapshotUsername: { contains: term, mode: "insensitive" } },
        { userId: { contains: term, mode: "insensitive" } },
      ];
    }

    const orderBy: Prisma.CommunityMemberOrderByWithRelationInput =
      params.sortBy === "displayName"
        ? { snapshotDisplayName: params.sortOrder }
        : params.sortBy === "username"
          ? { snapshotUsername: params.sortOrder }
          : { bannedAt: params.sortOrder };

    const [rows, total] = await Promise.all([
      prisma.communityMember.findMany({
        where,
        orderBy,
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        select: {
          id: true,
          userId: true,
          role: true,
          status: true,
          joinedAt: true,
          snapshotUsername: true,
          snapshotDisplayName: true,
          snapshotAvatarKey: true,
          bannedAt: true,
          bannedBy: true,
          banReason: true,
        },
      }),
      prisma.communityMember.count({ where }),
    ]);

    return { rows, total };
  },

  /**
   * Communities where the caller is an ACTIVE member, timestamp-cursor paginated
   * on `Community.lastActivityAt` (latest message, else createdAt). Queried from
   * the Community side so we can order by the native `lastActivityAt` field and
   * apply the time bound at the DB level; the caller's role is pulled via a
   * filtered include on `members`.
   *
   * - direction "before": lastActivityAt <= ts, newest-first (desc)
   * - direction "after" : lastActivityAt >= ts, oldest-first (asc)
   *
   * Fetches `limit` rows (caller over-fetches by +1 for an exact hasMore).
   * Returns rows + the caller's total active-community count.
   */
  async listMineByActivity(params: {
    userId: string;
    direction: "before" | "after";
    ts: Date;
    limit: number;
  }) {
    const dir = params.direction === "before" ? "desc" : "asc";
    const bound =
      params.direction === "before" ? { lte: params.ts } : { gte: params.ts };

    // Include BANNED alongside ACTIVE: a banned member's communities stay
    // visible in their sidebar list (zero access — every read/write is
    // rejected with USER_BANNED) until the user dismisses the entry themselves
    // (dismissedAt set — see resolveSelfRemoval). LEFT and kicked members
    // (status LEFT, removedAt is audit-only) are excluded — they must rejoin
    // through the normal flow to see the community again.
    const memberVisibilityFilter = {
      OR: [
        { status: CommunityMemberStatus.ACTIVE },
        {
          status: CommunityMemberStatus.BANNED,
          dismissedAt: { isSet: false },
        },
      ],
    };
    const membershipSome = {
      userId: params.userId,
      ...memberVisibilityFilter,
    };
    const where = {
      deletedAt: { isSet: false },
      lastActivityAt: bound,
      members: { some: membershipSome },
    };

    const [rows, total] = await Promise.all([
      prisma.community.findMany({
        where,
        orderBy: [{ lastActivityAt: dir }, { id: dir }],
        take: params.limit,
        select: mineActivitySelect(params.userId),
      }),
      prisma.community.count({
        where: {
          deletedAt: { isSet: false },
          members: { some: membershipSome },
        },
      }),
    ]);

    return { rows, total };
  },

  /**
   * V2 counterpart of {@link listMineByActivity}: the caller's ACTIVE
   * communities, newest-activity first, paged by a gap-safe COMPOUND
   * `(lastActivityAt, id)` keyset instead of the V1 bare-timestamp bound.
   *
   * The V1 method tie-breaks on `id` only in `orderBy`, not in the `where`, so
   * communities sharing one `lastActivityAt` millisecond can skip/duplicate at a
   * page edge. Here the `id` tiebreaker is IN the boundary (`$or`), giving a true
   * total order — every community reachable exactly once. `cursor === null` →
   * newest page. Same `select`/`total` as V1, so `enrichMineCommunities` serves
   * both.
   */
  async listMineByActivityKeyset(params: {
    userId: string;
    /** Compound keyset boundary; null for the newest (first) page. */
    cursor: { ts: Date; id: string } | null;
    limit: number;
  }) {
    // Same visibility rule as {@link listMineByActivity} — ACTIVE plus
    // non-dismissed BANNED (see the doc comment there for why).
    const memberVisibilityFilter = {
      OR: [
        { status: CommunityMemberStatus.ACTIVE },
        {
          status: CommunityMemberStatus.BANNED,
          dismissedAt: { isSet: false },
        },
      ],
    };
    const membershipSome = {
      some: {
        userId: params.userId,
        ...memberVisibilityFilter,
      },
    };

    // Exclusive compound boundary: strictly-older activity, OR same activity ms
    // with a strictly-smaller id. Mirrors the (createdAt,_id) keyset used across
    // the chat/stream services. Newest-first (desc) to match V1's "before" scroll.
    const boundary: Prisma.CommunityWhereInput = params.cursor
      ? {
          OR: [
            { lastActivityAt: { lt: params.cursor.ts } },
            {
              lastActivityAt: params.cursor.ts,
              id: { lt: params.cursor.id },
            },
          ],
        }
      : {};

    const where: Prisma.CommunityWhereInput = {
      deletedAt: { isSet: false },
      members: membershipSome,
      ...boundary,
    };

    const [rows, total] = await Promise.all([
      prisma.community.findMany({
        where,
        orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
        take: params.limit,
        select: mineActivitySelect(params.userId),
      }),
      prisma.community.count({
        where: {
          deletedAt: { isSet: false },
          members: membershipSome,
        },
      }),
    ]);

    return { rows, total };
  },

  async updateLastActivity(
    communityId: string,
    activityAt: Date,
    type: string,
    preview: string,
    username: string | null,
    userId: string | null,
    selfPreview: string | null = null,
    targetUserId: string | null = null,
    targetPreview: string | null = null
  ): Promise<number> {
    const result = await prisma.community.updateMany({
      where: { id: communityId, lastActivityAt: { lt: activityAt } },
      data: {
        lastActivityAt: activityAt,
        lastActivityType: type,
        lastActivityPreview: preview,
        lastActivityUsername: username,
        lastActivityUserId: userId,
        // Always overwrite — a subsequent non-self bump (e.g. a normal message)
        // must clear a stale "You …" preview from an earlier role-change/join.
        lastActivitySelfPreview: selfPreview,
        // Same always-overwrite rule for the target (reaction "…to your message")
        // pair — a later non-reaction bump must clear a stale target preview too.
        lastActivityTargetUserId: targetUserId,
        lastActivityTargetPreview: targetPreview,
      },
    });
    return result.count;
  },

  /**
   * Personal "self-hide" overlay for delete-for-me: writes ONLY
   * `lastActivityUserId`/`lastActivitySelfPreview` — the SAME columns already
   * used to personalize a self-referential join/role-change line — so that
   * ONLY the viewer whose id matches `lastActivityUserId` sees `preview` (via
   * the existing `viewerId === lastActivityUserId` resolution in
   * community.service.ts); every other member keeps resolving the untouched
   * canonical `lastActivityPreview`. Unconditional overwrite (no forward-only
   * guard, mirrors {@link setReactionActivity}) — a delete-for-me is a
   * personal view change, not a community-wide event with its own ordering.
   * Never touches `lastActivityAt`/Type/Preview/Username, so the community's
   * list ordering and every other member's preview are completely unaffected.
   * A subsequent real canonical bump (send/edit/delete-for-everyone) already
   * always overwrites `lastActivityUserId`/`lastActivitySelfPreview` too (see
   * `updateLastActivity` above), so a stale self-hide preview is naturally
   * cleared the next time anything else happens in the room.
   */
  async setSelfLastActivityOverride(
    communityId: string,
    params: { userId: string; preview: string }
  ): Promise<void> {
    await prisma.community.updateMany({
      where: { id: communityId },
      data: {
        lastActivityUserId: params.userId,
        lastActivitySelfPreview: params.preview,
      },
    });
  },

  /**
   * Set the reaction OVERLAY to represent a just-ADDED reaction — always an
   * unconditional overwrite (no forward-only guard): an add is by definition
   * the newest reaction event, and it always displaces whatever reaction was
   * previously shown (even one on a different message). Never touches the
   * canonical lastActivity* columns — a reaction is never what the rest of
   * the community sees. `targetId`/`targetPreview` are null for a
   * self-reaction (actor === message owner — only the actor has a view).
   */
  async setReactionActivity(
    communityId: string,
    params: {
      messageId: string;
      emoji: string;
      actorId: string;
      actorPreview: string;
      targetId: string | null;
      targetPreview: string | null;
      reactedAt: Date;
    }
  ): Promise<void> {
    await prisma.community.updateMany({
      where: { id: communityId },
      data: {
        lastActivityReactionAt: params.reactedAt,
        lastActivityReactionMessageId: params.messageId,
        lastActivityReactionEmoji: params.emoji,
        lastActivityReactionActorId: params.actorId,
        lastActivityReactionActorPreview: params.actorPreview,
        lastActivityReactionTargetId: params.targetId,
        lastActivityReactionTargetPreview: params.targetPreview,
      },
    });
  },

  /**
   * Clear the reaction overlay ONLY if it currently represents the exact
   * (messageId, emoji, actorId) being removed — a `WHERE` match, not a bare
   * unconditional clear. Removing a DIFFERENT reaction (same message but a
   * different emoji/user, or any reaction on another message) must be a
   * no-op: that reaction was never the one being shown, so there is nothing
   * to clear. `updateMany` naturally matches zero rows in that case.
   */
  async clearReactionActivityIfCurrent(
    communityId: string,
    params: { messageId: string; emoji: string; actorId: string }
  ): Promise<void> {
    await prisma.community.updateMany({
      where: {
        id: communityId,
        lastActivityReactionMessageId: params.messageId,
        lastActivityReactionEmoji: params.emoji,
        lastActivityReactionActorId: params.actorId,
      },
      data: {
        lastActivityReactionAt: null,
        lastActivityReactionMessageId: null,
        lastActivityReactionEmoji: null,
        lastActivityReactionActorId: null,
        lastActivityReactionActorPreview: null,
        lastActivityReactionTargetId: null,
        lastActivityReactionTargetPreview: null,
      },
    });
  },

  /**
   * Re-sync the denormalized community-list preview sender name on a profile
   * rename. `lastActivityUsername` is frozen at message-send time (it carries
   * the sender's DISPLAY name, mirroring chat-service's `senderUsername`), so
   * without this a rename leaves the community list showing the OLD name —
   * e.g. "Vasu Himanshu" — even though the chat room renders the live member
   * snapshot ("Himanshu Vasu"). Updates only the communities where this user is
   * the current last-activity sender. Sibling of
   * {@link updateMemberSnapshotsByUserId}, which keeps the member-list snapshot
   * in sync the same way.
   */
  updateLastActivityUsernameByUserId(userId: string, displayName: string) {
    return prisma.community.updateMany({
      where: { lastActivityUserId: userId },
      data: { lastActivityUsername: displayName },
    });
  },

  /**
   * Current display name for a set of users, resolved from ANY of their
   * community memberships. A user's `snapshotDisplayName` is identical across
   * all their member rows (kept in sync by {@link updateMemberSnapshotsByUserId}
   * on every `user.profile_updated`), so the first non-empty hit per user is the
   * live name. Used to resolve the community-list preview sender name at READ
   * time — matching the live name the chat room renders — instead of trusting
   * the denormalized `lastActivityUsername`, which is frozen at message-send
   * time and goes stale after a rename. Returns userId → displayName, omitting
   * users who are no longer a member anywhere (caller falls back to the stored
   * value for those).
   */
  async getDisplayNamesByUserIds(
    userIds: string[]
  ): Promise<Map<string, string>> {
    const ids = [...new Set(userIds.filter(Boolean))];
    const map = new Map<string, string>();
    if (ids.length === 0) return map;

    const rows = await prisma.communityMember.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, snapshotDisplayName: true },
    });
    for (const r of rows) {
      if (!map.has(r.userId) && r.snapshotDisplayName) {
        map.set(r.userId, r.snapshotDisplayName);
      }
    }
    return map;
  },

  /**
   * Cursor-paginated list of communities (+ all their members) for chat-service's
   * boot reconciliation of community chat rooms. Cursor is the community `id`
   * (ObjectId, time-ordered), ascending for stable paging. Includes soft-deleted
   * communities (carries `deletedAt`) so the reconciler can deactivate their rooms.
   * All member statuses/roles are returned so RoomMember rows map correctly.
   */
  async listForReconciliation(params: {
    afterId?: string | null;
    limit: number;
  }) {
    return prisma.community.findMany({
      ...(params.afterId ? { cursor: { id: params.afterId }, skip: 1 } : {}),
      orderBy: { id: "asc" },
      take: params.limit,
      select: {
        id: true,
        name: true,
        adminId: true,
        avatarUrl: true,
        deletedAt: true,
        type: true,
        members: {
          select: {
            userId: true,
            status: true,
            role: true,
            joinedAt: true,
          },
        },
      },
    });
  },

  // ---------------------------------------------------------------------------
  // Discovery / browse
  // ---------------------------------------------------------------------------
  /**
   * Community ids the user already has a relationship with (active, pending, or
   * banned) — excluded from discovery so users only see communities they can
   * still join. A user who LEFT keeps no row here, so left communities reappear.
   * The (userId, status) index backs this.
   */
  async listExcludedCommunityIds(userId: string): Promise<string[]> {
    const rows = await prisma.communityMember.findMany({
      where: {
        userId,
        status: {
          in: [
            CommunityMemberStatus.ACTIVE,
            CommunityMemberStatus.PENDING,
            CommunityMemberStatus.BANNED,
          ],
        },
      },
      select: { communityId: true },
    });
    return rows.map((r) => r.communityId);
  },

  /**
   * Community ids where the user has an active ban. `excludeDismissed` narrows
   * to bans the user hasn't hidden from their own list yet — used by the
   * mine-search widening so a dismissed banned community stays hidden there,
   * matching `listMineByActivity`. Default (all bans) backs the join-request /
   * invite exclusion lists, where dismissedness is irrelevant (still banned).
   */
  async findBannedCommunityIds(
    userId: string,
    opts?: { excludeDismissed?: boolean }
  ): Promise<string[]> {
    const rows = await prisma.communityMember.findMany({
      where: {
        userId,
        status: CommunityMemberStatus.BANNED,
        ...(opts?.excludeDismissed ? { dismissedAt: { isSet: false } } : {}),
      },
      select: { communityId: true },
    });
    return rows.map((r) => r.communityId);
  },

  /**
   * Community ids where the user is an ACTIVE member. Used by the search mode of
   * `GET /communities/mine` to widen visibility to PRIVATE communities the
   * caller already belongs to. The (userId, status) index backs this.
   */
  async listActiveMemberCommunityIds(userId: string): Promise<string[]> {
    const rows = await prisma.communityMember.findMany({
      where: {
        userId,
        status: CommunityMemberStatus.ACTIVE,
      },
      select: { communityId: true },
    });
    return rows.map((r) => r.communityId);
  },

  /**
   * Communities for discovery/browse, optionally filtered by a name/handle
   * search term and/or category. Serves two callers:
   *   - discover alias: PUBLIC communities, excluding ids the caller relates to
   *     (`excludeCommunityIds`).
   *   - /communities/mine search mode: PUBLIC communities PLUS any community in
   *     `includeMemberCommunityIds` (the caller's ACTIVE PRIVATE memberships).
   * Newest-first (ObjectId is time-ordered) with offset/page pagination on `id`.
   * Returns the page rows plus the total matching count.
   */
  async listDiscoverable(params: {
    q?: string;
    categoryId?: string;
    includeMemberCommunityIds?: string[];
    excludeCommunityIds?: string[];
    page: number;
    limit: number;
  }) {
    const and: Prisma.CommunityWhereInput[] = [];

    // Visibility: PUBLIC, plus any community the caller is an ACTIVE member of.
    const visibilityOr: Prisma.CommunityWhereInput[] = [
      { type: CommunityType.PUBLIC },
    ];
    if (params.includeMemberCommunityIds?.length) {
      visibilityOr.push({ id: { in: params.includeMemberCommunityIds } });
    }
    and.push({ OR: visibilityOr });

    if (params.excludeCommunityIds?.length) {
      and.push({ id: { notIn: params.excludeCommunityIds } });
    }
    if (params.categoryId) {
      and.push({ categoryId: params.categoryId });
    }
    if (params.q) {
      and.push({
        OR: [
          { name: { contains: params.q, mode: "insensitive" } },
          { handle: { contains: params.q, mode: "insensitive" } },
        ],
      });
    }

    const where: Prisma.CommunityWhereInput = {
      deletedAt: { isSet: false },
      // Owner-CLOSED communities are not surfaced for discovery/joining. `not`
      // → Mongo `$ne`, which also matches legacy rows where `status` is unset
      // (treated as ACTIVE), so backward-compat is preserved.
      status: { not: CommunityStatus.CLOSED },
      AND: and,
    };

    const [rows, total] = await Promise.all([
      prisma.community.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        select: {
          id: true,
          name: true,
          handle: true,
          description: true,
          type: true,
          memberCount: true,
          avatarUrl: true,
          createdAt: true,
          lastActivityAt: true,
          lastActivityType: true,
          lastActivityPreview: true,
          lastActivityUsername: true,
          moderationStatus: true,
          status: true,
          lastActivityUserId: true,
          lastActivitySelfPreview: true,
          category: { select: { id: true, name: true } },
        },
      }),
      prisma.community.count({ where }),
    ]);

    return { rows, total };
  },

  // ---------------------------------------------------------------------------
  // Favorites (liked communities)
  // ---------------------------------------------------------------------------
  async likeCommunity(userId: string, communityId: string) {
    return prisma.communityFavorite.upsert({
      where: { userId_communityId: { userId, communityId } },
      create: { userId, communityId },
      update: {},
    });
  },

  async unlikeCommunity(userId: string, communityId: string) {
    return prisma.communityFavorite.deleteMany({
      where: { userId, communityId },
    });
  },

  async isFavorite(userId: string, communityId: string): Promise<boolean> {
    const row = await prisma.communityFavorite.findUnique({
      where: { userId_communityId: { userId, communityId } },
      select: { id: true },
    });
    return row !== null;
  },

  /**
   * Cursor-paginated list of communities liked by a user.
   * Cursor is the `CommunityFavorite.id` (ObjectId, time-ordered, desc).
   */
  async listFavorites(params: {
    userId: string;
    cursor?: string | null;
    limit: number;
  }) {
    const rows = await prisma.communityFavorite.findMany({
      where: { userId: params.userId },
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      orderBy: { id: "desc" },
      take: params.limit + 1,
      select: {
        id: true,
        communityId: true,
        createdAt: true,
      },
    });
    const hasMore = rows.length > params.limit;
    if (hasMore) rows.pop();
    const nextCursor = hasMore ? (rows.at(-1)?.id ?? null) : null;
    return { rows, hasMore, nextCursor };
  },

  async isFavoriteMany(
    userId: string,
    communityIds: string[]
  ): Promise<Set<string>> {
    if (communityIds.length === 0) return new Set();
    const rows = await prisma.communityFavorite.findMany({
      where: { userId, communityId: { in: communityIds } },
      select: { communityId: true },
    });
    return new Set(rows.map((r) => r.communityId));
  },

  // ---------------------------------------------------------------------------
  // Backoffice (admin panel) Community Management
  // ---------------------------------------------------------------------------
  /**
   * Admin Community Management list — offset/page pagination with filters over
   * non-soft-deleted communities. `status` is the admin moderation lifecycle:
   * existing rows predate `moderationStatus` so a MISSING value counts as ACTIVE
   * ({ isSet: false }); SUSPENDED == the admin "CLOSED" state. Search matches the
   * community name OR the admin's snapshot display name (resolved via a CommunityMember
   * pre-query, since the admin name lives on a different collection). Admin identity
   * is batch-resolved post-page (no N+1). Returns enriched rows + total.
   */
  async adminListCommunities(params: {
    search?: string;
    type?: CommunityType;
    category?: string;
    status?: "ACTIVE" | "CLOSED";
    createdFrom?: Date;
    createdTo?: Date;
    sortField: string;
    sortDir: "asc" | "desc";
    page: number;
    limit: number;
  }) {
    const dir: Prisma.SortOrder = params.sortDir === "asc" ? "asc" : "desc";

    const where: Prisma.CommunityWhereInput = {
      deletedAt: { isSet: false },
    };

    if (params.type) {
      where.type = params.type;
    }

    // moderationStatus is unset on legacy rows → treat missing as ACTIVE. The
    // generated enum filter has no `isSet` (the field is non-optional with a
    // default), so we match "ACTIVE-or-missing" as `not: SUSPENDED` — Mongo's
    // `$ne` matches absent fields too, so this also covers legacy rows. CLOSED is
    // the exact SUSPENDED match.
    if (params.status === "ACTIVE") {
      where.moderationStatus = { not: CommunityModerationStatus.SUSPENDED };
    } else if (params.status === "CLOSED") {
      where.moderationStatus = CommunityModerationStatus.SUSPENDED;
    }

    // Category filter accepts slug OR id; resolve to the stored categoryId.
    if (params.category) {
      const categoryId = await this.findActiveCategoryBySlugOrId(
        params.category
      );
      // No matching category → no rows can match this filter.
      where.categoryId = categoryId ?? "__no_such_category__";
    }

    if (params.createdFrom || params.createdTo) {
      where.createdAt = {
        ...(params.createdFrom ? { gte: params.createdFrom } : {}),
        ...(params.createdTo ? { lte: params.createdTo } : {}),
      };
    }

    // Search over community name OR admin (snapshot) display name. The admin name
    // is on the CommunityMember collection, so first collect communityIds whose
    // ADMIN member's snapshotDisplayName matches, then OR that into the name match.
    if (params.search) {
      const adminMatches = await prisma.communityMember.findMany({
        where: {
          role: CommunityMemberRole.ADMIN,
          snapshotDisplayName: {
            contains: params.search,
            mode: "insensitive",
          },
        },
        select: { communityId: true },
      });
      const adminMatchedCommunityIds = adminMatches.map((m) => m.communityId);

      const searchOr: Prisma.CommunityWhereInput[] = [
        { name: { contains: params.search, mode: "insensitive" } },
      ];
      if (adminMatchedCommunityIds.length > 0) {
        searchOr.push({ id: { in: adminMatchedCommunityIds } });
      }
      where.OR = searchOr;
    }

    // Sort mapping. `livestreamCount` has no backing column (stubbed) → fall back
    // to createdAt. Always append a stable secondary on id.
    let primaryOrderBy: Prisma.CommunityOrderByWithRelationInput;
    switch (params.sortField) {
      case "name":
        primaryOrderBy = { name: dir };
        break;
      case "memberCount":
        primaryOrderBy = { memberCount: dir };
        break;
      case "categoryName":
        // Denormalized, indexed column — index-backed DB-level sort (Prisma's
        // Mongo connector can't orderBy the related category collection). Legacy
        // rows with a null categoryName sort first (asc) / last (desc) until the
        // backfill runs; the id tiebreak keeps paging deterministic regardless.
        primaryOrderBy = { categoryName: dir };
        break;
      case "createdAt":
        primaryOrderBy = { createdAt: dir };
        break;
      case "livestreamCount":
        // No backing column yet (stream-service not wired) → sort by createdAt.
        primaryOrderBy = { createdAt: dir };
        break;
      default:
        primaryOrderBy = { createdAt: dir };
    }

    const [rows, total] = await Promise.all([
      prisma.community.findMany({
        where,
        orderBy: [primaryOrderBy, { id: dir }],
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        select: {
          id: true,
          name: true,
          handle: true,
          type: true,
          categoryId: true,
          memberCount: true,
          createdAt: true,
          adminId: true,
          moderationStatus: true,
          avatarUrl: true,
          coverUrl: true,
          category: { select: { id: true, name: true, slug: true } },
        },
      }),
      prisma.community.count({ where }),
    ]);

    // Batch-resolve admin identity from the CommunityMember snapshot (no N+1).
    const pageIds = rows.map((r) => r.id);
    const adminIds = rows.map((r) => r.adminId);
    const adminMemberRows =
      pageIds.length > 0
        ? await prisma.communityMember.findMany({
            where: {
              communityId: { in: pageIds },
              userId: { in: adminIds },
            },
            select: {
              communityId: true,
              userId: true,
              snapshotDisplayName: true,
              snapshotUsername: true,
              snapshotAvatarKey: true,
            },
          })
        : [];
    const adminMap = new Map<
      string,
      {
        snapshotDisplayName: string;
        snapshotUsername: string;
        snapshotAvatarKey: string | null;
      }
    >();
    for (const m of adminMemberRows) {
      adminMap.set(`${m.communityId}:${m.userId}`, {
        snapshotDisplayName: m.snapshotDisplayName,
        snapshotUsername: m.snapshotUsername,
        snapshotAvatarKey: m.snapshotAvatarKey,
      });
    }

    const enriched = rows.map((r) => {
      const admin = adminMap.get(`${r.id}:${r.adminId}`);
      return {
        ...r,
        adminName: admin?.snapshotDisplayName ?? "",
        adminUsername: admin?.snapshotUsername ?? "",
        adminAvatar: admin?.snapshotAvatarKey ?? "",
      };
    });

    return { rows: enriched, total };
  },

  /**
   * Admin Community Management detail — the community core + member statistics,
   * open-report count, active invite-link count, and the admin snapshot. Excludes
   * soft-deleted. Returns null when not found. `sevenDaysAgo` is the join cutoff
   * for the "joined last 7d" stat (runtime Date — not a fixture).
   */
  async adminGetCommunityDetail(communityId: string) {
    const community = await prisma.community.findFirst({
      where: { id: communityId, deletedAt: { isSet: false } },
      include: { category: { select: { id: true, name: true, slug: true } } },
    });
    if (!community) return null;

    const now = new Date();
    const sevenDaysAgo = new Date(Date.now() - 7 * 864e5);

    const [
      membersTotal,
      membersActive,
      membersPending,
      membersBanned,
      membersModerators,
      membersJoinedLast7d,
      openReports,
      activeInviteLinks,
      adminMember,
    ] = await Promise.all([
      prisma.communityMember.count({ where: { communityId } }),
      prisma.communityMember.count({
        where: { communityId, status: CommunityMemberStatus.ACTIVE },
      }),
      prisma.communityMember.count({
        where: { communityId, status: CommunityMemberStatus.PENDING },
      }),
      prisma.communityMember.count({
        where: { communityId, status: CommunityMemberStatus.BANNED },
      }),
      prisma.communityMember.count({
        where: {
          communityId,
          status: CommunityMemberStatus.ACTIVE,
          role: {
            in: [CommunityMemberRole.MODERATOR, CommunityMemberRole.ADMIN],
          },
        },
      }),
      prisma.communityMember.count({
        where: { communityId, joinedAt: { gte: sevenDaysAgo } },
      }),
      prisma.communityReport.count({
        where: { communityId, status: CommunityReportStatus.OPEN },
      }),
      prisma.communityInviteLink.count({
        where: {
          communityId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      }),
      prisma.communityMember.findFirst({
        where: { communityId, userId: community.adminId },
        select: {
          snapshotDisplayName: true,
          snapshotUsername: true,
          snapshotAvatarKey: true,
        },
      }),
    ]);

    return {
      community,
      adminName: adminMember?.snapshotDisplayName ?? "",
      adminUsername: adminMember?.snapshotUsername ?? "",
      adminAvatar: adminMember?.snapshotAvatarKey ?? "",
      membersTotal,
      membersActive,
      membersPending,
      membersBanned,
      membersModerators,
      membersJoinedLast7d,
      openReports,
      activeInviteLinks,
    };
  },

  /**
   * Admin Community Member List — offset/page pagination over a community's
   * members, optionally filtered by role and/or a free-text search (snapshot
   * username/display name OR exact userId). Fully denormalized rows (snapshot*),
   * so NO user-service round-trip. Default order is role (ADMIN→MODERATOR→MEMBER
   * via enum asc) then joinedAt asc; `sortField` overrides this. `excludeUserId`
   * removes a userId at the DB level (the excluded user MUST NEVER appear — never
   * filter in memory). `communityId` is an ObjectId — an invalid id would make
   * Prisma throw, so we short-circuit to an empty page instead.
   */
  async adminListCommunityMembers(params: {
    communityId: string;
    search?: string;
    role?: CommunityMemberRole;
    excludeUserId?: string;
    sortField?: "username" | "handle" | "joinedAt" | "role";
    sortDir?: "asc" | "desc";
    page: number;
    limit: number;
  }): Promise<{ rows: CommunityMember[]; total: number }> {
    // Guard a malformed ObjectId (mirrors how adminGetCommunityDetail tolerates a
    // missing/invalid id by returning no result rather than throwing).
    if (!/^[a-fA-F0-9]{24}$/.test(params.communityId)) {
      return { rows: [], total: 0 };
    }

    const where: Prisma.CommunityMemberWhereInput = {
      communityId: params.communityId,
    };
    if (params.role) {
      where.role = params.role;
    }
    // DB-level exclusion — the excluded user must never surface in the page. If it
    // collides with a search userId, the `not` still wins (the user stays hidden).
    if (params.excludeUserId) {
      where.userId = { not: params.excludeUserId };
    }
    if (params.search) {
      where.OR = [
        { snapshotUsername: { contains: params.search, mode: "insensitive" } },
        {
          snapshotDisplayName: { contains: params.search, mode: "insensitive" },
        },
        { userId: params.search },
      ];
    }

    // Dynamic sort. "username" sorts on the display name (with @handle as a
    // tiebreak); "handle" sorts on the snapshot @handle; "joinedAt" sorts on
    // join time then role; "role" sorts on role (honoring dir) then joinedAt;
    // default is role asc → joinedAt asc.
    const dir: Prisma.SortOrder = params.sortDir === "desc" ? "desc" : "asc";
    let orderBy: Prisma.CommunityMemberOrderByWithRelationInput[];
    if (params.sortField === "username") {
      orderBy = [
        { snapshotDisplayName: dir },
        { snapshotUsername: dir },
        { joinedAt: "asc" },
      ];
    } else if (params.sortField === "handle") {
      orderBy = [{ snapshotUsername: dir }, { joinedAt: "asc" }];
    } else if (params.sortField === "joinedAt") {
      orderBy = [{ joinedAt: dir }, { role: "asc" }];
    } else if (params.sortField === "role") {
      orderBy = [{ role: dir }, { joinedAt: "asc" }];
    } else {
      orderBy = [{ role: "asc" }, { joinedAt: "asc" }];
    }

    const [rows, total] = await Promise.all([
      prisma.communityMember.findMany({
        where,
        orderBy,
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityMember.count({ where }),
    ]);

    return { rows, total };
  },

  /**
   * Batch role lookup for a set of userIds within one community — backs the
   * backoffice Livestream Viewer List "type" (Admin|Moderator|Member) column
   * without an N+1 per-viewer query. Users absent from the result (e.g. left
   * the community, or a malformed communityId) simply have no entry; the
   * caller defaults them to MEMBER.
   */
  async getMemberRolesByUserIds(
    communityId: string,
    userIds: string[]
  ): Promise<Array<{ userId: string; role: CommunityMemberRole }>> {
    if (userIds.length === 0 || !/^[a-fA-F0-9]{24}$/.test(communityId)) {
      return [];
    }
    return prisma.communityMember.findMany({
      where: { communityId, userId: { in: userIds } },
      select: { userId: true, role: true },
    });
  },

  /**
   * Admin User Management → Communities grid: the communities the given user is an
   * ACTIVE member of. The driving filter is the user's ACTIVE memberships (uses
   * `@@index([userId, status])`). Name search + sort live on the Community
   * collection (Prisma's Mongo connector can't orderBy/filter the related
   * collection from the member side), so we use a 2-step batch (NO N+1):
   *   1. Fetch the user's ACTIVE memberships → {communityId, role, joinedAt}.
   *   2. Hydrate the matching communities in ONE `findMany` (id IN [...] + optional
   *      name/id search), applying sort + offset pagination at the DB level, then
   *      merge each member's role/joinedAt back by communityId.
   * Soft-deleted communities are excluded (matches `adminListCommunities`, which
   * does NOT exclude SUSPENDED by default — so neither do we). Short-circuits to an
   * empty page when the user has no memberships. Two queries + one count, no N+1.
   */
  async adminListUserCommunities(params: {
    userId: string;
    search?: string;
    sortField?: string;
    sortDir?: "asc" | "desc";
    page: number;
    limit: number;
  }): Promise<{
    rows: Array<{
      id: string;
      name: string;
      avatarUrl: string | null;
      categoryId: string;
      categoryName: string | null;
      description: string | null;
      memberCount: number;
      role: CommunityMemberRole;
      joinedAt: Date;
      createdAt: Date;
    }>;
    total: number;
  }> {
    // 1. The user's ACTIVE memberships (bounded cardinality — userId is the driver).
    const memberships = await prisma.communityMember.findMany({
      where: { userId: params.userId, status: CommunityMemberStatus.ACTIVE },
      select: { communityId: true, role: true, joinedAt: true },
    });
    if (memberships.length === 0) {
      return { rows: [], total: 0 };
    }

    const memberByCommunity = new Map<
      string,
      { role: CommunityMemberRole; joinedAt: Date }
    >();
    for (const m of memberships) {
      memberByCommunity.set(m.communityId, {
        role: m.role,
        joinedAt: m.joinedAt,
      });
    }
    const communityIds = [...memberByCommunity.keys()];

    // Build the community-side where: bounded to the user's communities, exclude
    // soft-deleted. Optional search matches community name (insensitive contains)
    // OR an exact ObjectId match when the search term looks like a 24-hex id.
    const where: Prisma.CommunityWhereInput = {
      id: { in: communityIds },
      deletedAt: { isSet: false },
    };
    if (params.search) {
      const searchOr: Prisma.CommunityWhereInput[] = [
        { name: { contains: params.search, mode: "insensitive" } },
      ];
      if (/^[a-fA-F0-9]{24}$/.test(params.search)) {
        searchOr.push({ id: params.search });
      }
      where.AND = [{ OR: searchOr }];
    }

    // Sort mapping (DB-level on the Community collection). Default createdAt desc.
    const dir: Prisma.SortOrder = params.sortDir === "asc" ? "asc" : "desc";
    let primaryOrderBy: Prisma.CommunityOrderByWithRelationInput;
    switch (params.sortField) {
      case "name":
        primaryOrderBy = { name: dir };
        break;
      case "memberCount":
        primaryOrderBy = { memberCount: dir };
        break;
      case "createdAt":
        primaryOrderBy = { createdAt: dir };
        break;
      default:
        primaryOrderBy = { createdAt: dir };
    }

    // 2. Hydrate communities in ONE query (+ count). Apply sort + offset paging here.
    const [communities, total] = await Promise.all([
      prisma.community.findMany({
        where,
        orderBy: [primaryOrderBy, { id: dir }],
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        select: {
          id: true,
          name: true,
          avatarUrl: true,
          categoryId: true,
          categoryName: true,
          description: true,
          memberCount: true,
          createdAt: true,
        },
      }),
      prisma.community.count({ where }),
    ]);

    const rows = communities.map((c) => {
      const membership = memberByCommunity.get(c.id);
      return {
        id: c.id,
        name: c.name,
        avatarUrl: c.avatarUrl,
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        description: c.description,
        memberCount: c.memberCount,
        // membership is always present (communityIds came from the membership map).
        role: membership?.role ?? CommunityMemberRole.MEMBER,
        joinedAt: membership?.joinedAt ?? c.createdAt,
        createdAt: c.createdAt,
      };
    });

    return { rows, total };
  },

  /**
   * Admin moderation toggle: close (SUSPENDED) or reopen (ACTIVE) a community.
   * Legacy rows have an unset moderationStatus → treated as ACTIVE. No
   * $transaction (standalone Mongo); the audit-log append is a sequential write.
   * Returns a business-result envelope (ok + errorCode) rather than throwing, so
   * the gRPC handler can return 404/409-mappable codes on the wire.
   */
  async adminSetModerationStatus(
    communityId: string,
    status: CommunityModerationStatus,
    reasonCode: string | null,
    actorAdminId: string | null
  ): Promise<{
    ok: boolean;
    status: "ACTIVE" | "CLOSED";
    closedAt: number;
    errorCode: string;
  }> {
    const community = await prisma.community.findFirst({
      where: { id: communityId, deletedAt: { isSet: false } },
      select: { id: true, moderationStatus: true },
    });
    if (!community) {
      return {
        ok: false,
        status: "ACTIVE",
        closedAt: 0,
        errorCode: "COMMUNITY_NOT_FOUND",
      };
    }

    // Missing moderationStatus (legacy rows) counts as ACTIVE.
    const isCurrentlySuspended =
      community.moderationStatus === CommunityModerationStatus.SUSPENDED;

    if (status === CommunityModerationStatus.SUSPENDED) {
      if (isCurrentlySuspended) {
        return {
          ok: false,
          status: "CLOSED",
          closedAt: 0,
          errorCode: "COMMUNITY_ALREADY_CLOSED",
        };
      }
      const closedAt = new Date();
      await prisma.community.update({
        where: { id: communityId },
        data: {
          moderationStatus: CommunityModerationStatus.SUSPENDED,
          closedAt,
          closedReasonCode: reasonCode || null,
          closedByAdminId: actorAdminId || null,
        },
      });
      await this.createAuditLog({
        communityId,
        actorId: actorAdminId || "system",
        action: "ADMIN_SUSPEND_COMMUNITY",
        reason: reasonCode || undefined,
      });
      return {
        ok: true,
        status: "CLOSED",
        closedAt: closedAt.getTime(),
        errorCode: "",
      };
    }

    // Target ACTIVE (reopen).
    if (!isCurrentlySuspended) {
      return {
        ok: false,
        status: "ACTIVE",
        closedAt: 0,
        errorCode: "COMMUNITY_NOT_CLOSED",
      };
    }
    await prisma.community.update({
      where: { id: communityId },
      data: {
        moderationStatus: CommunityModerationStatus.ACTIVE,
        closedAt: null,
        closedReasonCode: null,
        closedByAdminId: null,
      },
    });
    await this.createAuditLog({
      communityId,
      actorId: actorAdminId || "system",
      action: "ADMIN_REOPEN_COMMUNITY",
      reason: reasonCode || undefined,
    });
    return { ok: true, status: "ACTIVE", closedAt: 0, errorCode: "" };
  },

  // ---------------------------------------------------------------------------
  // Audit log (append-only moderation trail)
  // ---------------------------------------------------------------------------
  /** Append a single moderation audit entry. */
  createAuditLog(entry: {
    communityId: string;
    actorId: string;
    action: CommunityAuditAction;
    targetUserId?: string;
    reason?: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    return prisma.communityAuditLog.create({ data: entry });
  },

  /**
   * Audit entries for a community, newest first. ObjectId is time-ordered, so
   * ordering on `id` desc matches createdAt order. Offset/page pagination on id;
   * returns the page rows plus the total matching count.
   */
  async listAuditLogs(params: {
    communityId: string;
    page: number;
    limit: number;
  }) {
    const where = { communityId: params.communityId };

    const [rows, total] = await Promise.all([
      prisma.communityAuditLog.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        select: {
          id: true,
          communityId: true,
          actorId: true,
          action: true,
          targetUserId: true,
          reason: true,
          metadata: true,
          createdAt: true,
        },
      }),
      prisma.communityAuditLog.count({ where }),
    ]);

    return { rows, total };
  },

  // ---------------------------------------------------------------------------
  // Join requests
  // ---------------------------------------------------------------------------
  createJoinRequest(data: {
    communityId: string;
    userId: string;
    message: string | null;
  }) {
    return prisma.communityJoinRequest.create({
      data: {
        communityId: data.communityId,
        userId: data.userId,
        message: data.message,
        status: CommunityJoinReqStatus.PENDING,
      },
    });
  },

  findJoinRequestById(requestId: string) {
    return prisma.communityJoinRequest.findUnique({
      where: { id: requestId },
    });
  },

  findJoinRequestByCommunityAndUser(communityId: string, userId: string) {
    return prisma.communityJoinRequest.findUnique({
      where: { communityId_userId: { communityId, userId } },
    });
  },

  /** Single query returning the set of communityIds that the user has a PENDING join request for. */
  async findPendingRequestedCommunityIds(
    userId: string,
    communityIds: string[]
  ): Promise<Set<string>> {
    if (communityIds.length === 0) return new Set();
    const rows = await prisma.communityJoinRequest.findMany({
      where: {
        userId,
        communityId: { in: communityIds },
        status: CommunityJoinReqStatus.PENDING,
      },
      select: { communityId: true },
    });
    return new Set(rows.map((r) => r.communityId));
  },

  updateJoinRequest(
    requestId: string,
    data: {
      status?: CommunityJoinReqStatus;
      message?: string | null;
      decidedBy?: string | null;
      decidedAt?: Date | null;
    }
  ) {
    return prisma.communityJoinRequest.update({
      where: { id: requestId },
      data,
    });
  },

  findJoinRequestsByIds(requestIds: string[]) {
    return prisma.communityJoinRequest.findMany({
      where: { id: { in: requestIds } },
    });
  },

  bulkUpdateJoinRequestStatus(
    requestIds: string[],
    status: CommunityJoinReqStatus,
    decidedBy: string,
    decidedAt: Date
  ) {
    return prisma.communityJoinRequest.updateMany({
      where: { id: { in: requestIds } },
      data: { status, decidedBy, decidedAt },
    });
  },

  /**
   * Recycle a non-PENDING request row back to PENDING. Clears decidedBy/decidedAt
   * (re-uses the (communityId, userId) unique row instead of inserting a dup).
   */
  recyclePendingJoinRequest(requestId: string, message: string | null) {
    return prisma.communityJoinRequest.update({
      where: { id: requestId },
      data: {
        status: CommunityJoinReqStatus.PENDING,
        decidedBy: null,
        decidedAt: null,
        message,
      },
    });
  },

  async listCommunityJoinRequests(params: {
    communityId: string;
    status?: CommunityJoinReqStatus;
    page: number;
    limit: number;
  }) {
    const where: Prisma.CommunityJoinRequestWhereInput = {
      communityId: params.communityId,
    };
    if (params.status) where.status = params.status;

    const [rows, total] = await Promise.all([
      prisma.communityJoinRequest.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityJoinRequest.count({ where }),
    ]);

    return { rows, total };
  },

  async listMyJoinRequests(params: {
    userId: string;
    status?: CommunityJoinReqStatus;
    page: number;
    limit: number;
  }) {
    const bannedIds = await this.findBannedCommunityIds(params.userId);
    const where: Prisma.CommunityJoinRequestWhereInput = {
      userId: params.userId,
      ...(bannedIds.length > 0 && { communityId: { notIn: bannedIds } }),
    };
    if (params.status) where.status = params.status;

    const [rows, total] = await Promise.all([
      prisma.communityJoinRequest.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityJoinRequest.count({ where }),
    ]);

    return { rows, total };
  },

  // ---------------------------------------------------------------------------
  // Invites
  // ---------------------------------------------------------------------------
  createInvite(data: {
    communityId: string;
    inviterId: string;
    inviteeId: string;
  }) {
    return prisma.communityInvite.create({
      data: {
        communityId: data.communityId,
        inviterId: data.inviterId,
        inviteeId: data.inviteeId,
        status: CommunityInviteStatus.PENDING,
      },
    });
  },

  findInviteById(inviteId: string) {
    return prisma.communityInvite.findUnique({
      where: { id: inviteId },
    });
  },

  findInviteByCommunityAndInvitee(communityId: string, inviteeId: string) {
    return prisma.communityInvite.findUnique({
      where: { communityId_inviteeId: { communityId, inviteeId } },
    });
  },

  /** Batch fetch existing invite rows for multiple invitees in one query. */
  findInvitesByUserIds(communityId: string, userIds: string[]) {
    if (userIds.length === 0) return Promise.resolve([]);
    return prisma.communityInvite.findMany({
      where: { communityId, inviteeId: { in: userIds } },
    });
  },

  /** Bulk-recycle multiple non-PENDING invites back to PENDING with a new inviter. */
  recycleManyPendingInvites(ids: string[], inviterId: string) {
    if (ids.length === 0) return Promise.resolve({ count: 0 });
    return prisma.communityInvite.updateMany({
      where: { id: { in: ids } },
      data: { status: CommunityInviteStatus.PENDING, inviterId },
    });
  },

  updateInvite(
    inviteId: string,
    data: { status?: CommunityInviteStatus; inviterId?: string }
  ) {
    return prisma.communityInvite.update({
      where: { id: inviteId },
      data,
    });
  },

  /** Recycle a non-PENDING invite back to PENDING with a new inviter. */
  recyclePendingInvite(inviteId: string, inviterId: string) {
    return prisma.communityInvite.update({
      where: { id: inviteId },
      data: {
        status: CommunityInviteStatus.PENDING,
        inviterId,
      },
    });
  },

  async listCommunityInvites(params: {
    communityId: string;
    status?: CommunityInviteStatus;
    page: number;
    limit: number;
  }) {
    const where: Prisma.CommunityInviteWhereInput = {
      communityId: params.communityId,
    };
    if (params.status) where.status = params.status;

    const [rows, total] = await Promise.all([
      prisma.communityInvite.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityInvite.count({ where }),
    ]);

    return { rows, total };
  },

  async listMyInvites(params: {
    inviteeId: string;
    status?: CommunityInviteStatus;
    page: number;
    limit: number;
  }) {
    const bannedIds = await this.findBannedCommunityIds(params.inviteeId);
    const where: Prisma.CommunityInviteWhereInput = {
      inviteeId: params.inviteeId,
      ...(bannedIds.length > 0 && { communityId: { notIn: bannedIds } }),
    };
    if (params.status) where.status = params.status;

    const [rows, total] = await Promise.all([
      prisma.communityInvite.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityInvite.count({ where }),
    ]);

    return { rows, total };
  },

  /**
   * Batch fetch community summaries by id — used by list-my-invites and
   * list-my-join-requests to avoid N+1 lookups. Filters out soft-deleted rows.
   * Returned ordering is NOT guaranteed; callers must build a Map by id.
   */
  findCommunitiesByIds(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.community.findMany({
      where: { id: { in: ids }, deletedAt: { isSet: false } },
      select: {
        id: true,
        name: true,
        handle: true,
        type: true,
        memberCount: true,
        avatarUrl: true,
        status: true,
      },
    });
  },

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------
  createReport(data: {
    communityId: string;
    reporterId: string;
    targetUserId: string | null;
    reason: string;
    /** Mandatory custom description when `reason` is "OTHER"; null otherwise. */
    otherReason?: string | null;
    reportedMessageId?: string | null;
    reportedContentType?: string | null;
    reportedContentText?: string | null;
    reportedContentPostedAt?: Date | null;
    reportedContentMedia?:
      | {
          objectKey: string;
          contentType?: string | null;
          fileName?: string | null;
          size?: number | null;
        }[]
      | null;
  }) {
    return prisma.communityReport.create({
      data: {
        communityId: data.communityId,
        reporterId: data.reporterId,
        targetUserId: data.targetUserId,
        reason: data.reason,
        otherReason: data.otherReason ?? null,
        status: CommunityReportStatus.OPEN,
        reportedMessageId: data.reportedMessageId ?? null,
        reportedContentType: data.reportedContentType ?? null,
        reportedContentText: data.reportedContentText ?? null,
        reportedContentPostedAt: data.reportedContentPostedAt ?? null,
        reportedContentMedia: data.reportedContentMedia ?? undefined,
      },
    });
  },

  findReportById(reportId: string) {
    return prisma.communityReport.findUnique({
      where: { id: reportId },
    });
  },

  /**
   * Idempotent-dedup helper for community-level (no target member) reports
   * ONLY: finds an existing OPEN report from the same reporter on the same
   * communityId (targetUserId always null here). `targetUserId` MUST be
   * passed explicitly — Mongo stores the field as null when omitted, so we
   * match on the precise value.
   */
  findOpenReportByReporterAndTarget(params: {
    communityId: string;
    reporterId: string;
    targetUserId: string | null;
  }) {
    return prisma.communityReport.findFirst({
      where: {
        communityId: params.communityId,
        reporterId: params.reporterId,
        targetUserId: params.targetUserId,
        status: CommunityReportStatus.OPEN,
      },
    });
  },

  /**
   * Duplicate-report guard for member-targeted reports: finds ANY existing
   * report (regardless of status — OPEN/REVIEWED/ACTIONED/DISMISSED/WITHDRAWN)
   * from the same reporter against the same target user in the same
   * community. A user may report another user only ONCE per community, ever
   * — unlike the no-target path above, closing/dismissing a report does not
   * free a fresh report slot. Backed by a partial unique index
   * (`community_reports_reporter_target_unique`, created idempotently in
   * server.ts — see the CommunityReport schema comment) as the DB-level guard
   * against the race between this read and the insert.
   */
  findReportByReporterAndTarget(params: {
    communityId: string;
    reporterId: string;
    targetUserId: string;
  }) {
    return prisma.communityReport.findFirst({
      where: {
        communityId: params.communityId,
        reporterId: params.reporterId,
        targetUserId: params.targetUserId,
      },
    });
  },

  updateReport(
    reportId: string,
    data: {
      status?: CommunityReportStatus;
      reviewedBy?: string | null;
      reviewedAt?: Date | null;
      resolution?: string | null;
    }
  ) {
    return prisma.communityReport.update({
      where: { id: reportId },
      data,
    });
  },

  /** Hard-delete a report row (moderator action). */
  deleteReport(reportId: string) {
    return prisma.communityReport.delete({ where: { id: reportId } });
  },

  async listCommunityReports(params: {
    communityId: string;
    status?: CommunityReportStatus;
    page: number;
    limit: number;
  }) {
    const where: Prisma.CommunityReportWhereInput = {
      communityId: params.communityId,
    };
    if (params.status) where.status = params.status;

    const [rows, total] = await Promise.all([
      prisma.communityReport.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityReport.count({ where }),
    ]);
    return { rows, total };
  },

  async listMyReports(params: {
    reporterId: string;
    status?: CommunityReportStatus;
    page: number;
    limit: number;
  }) {
    const where: Prisma.CommunityReportWhereInput = {
      reporterId: params.reporterId,
    };
    if (params.status) where.status = params.status;

    const [rows, total] = await Promise.all([
      prisma.communityReport.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityReport.count({ where }),
    ]);
    return { rows, total };
  },

  // ---------------------------------------------------------------------------
  // Mute settings
  // ---------------------------------------------------------------------------
  findMuteByUserAndCommunity(userId: string, communityId: string) {
    return prisma.communityMuteSetting.findUnique({
      where: { userId_communityId: { userId, communityId } },
    });
  },

  /**
   * Built for the future notifications-service fan-out — list all mute rows
   * the user has for a given set of communities. Free to ship now.
   */
  findMutesByUserAndCommunityIds(userId: string, communityIds: string[]) {
    return prisma.communityMuteSetting.findMany({
      where: { userId, communityId: { in: communityIds } },
    });
  },

  bulkCreateMute(
    userId: string,
    communityIds: string[],
    mutedUntil: Date | null
  ) {
    return prisma.communityMuteSetting.createMany({
      data: communityIds.map((communityId) => ({
        userId,
        communityId,
        mutedUntil,
      })),
    });
  },

  bulkClearMute(userId: string, communityIds: string[]) {
    return prisma.communityMuteSetting.deleteMany({
      where: { userId, communityId: { in: communityIds } },
    });
  },

  upsertMute(userId: string, communityId: string, mutedUntil: Date | null) {
    return prisma.communityMuteSetting.upsert({
      where: { userId_communityId: { userId, communityId } },
      create: { userId, communityId, mutedUntil },
      update: { mutedUntil },
    });
  },

  clearMute(userId: string, communityId: string) {
    return prisma.communityMuteSetting.deleteMany({
      where: { userId, communityId },
    });
  },

  /**
   * Upsert only the notification-preference toggles (stream/chat/announcement)
   * on the mute-setting row, leaving `mutedUntil` untouched. A row created here
   * starts un-muted (mutedUntil omitted → null).
   */
  upsertNotificationPrefs(
    userId: string,
    communityId: string,
    prefs: {
      streamEnabled?: boolean;
      chatEnabled?: boolean;
      announcementEnabled?: boolean;
    }
  ) {
    return prisma.communityMuteSetting.upsert({
      where: { userId_communityId: { userId, communityId } },
      create: { userId, communityId, ...prefs },
      update: prefs,
    });
  },

  // ---------------------------------------------------------------------------
  // Member moderation mutes (moderator-applied — distinct from notification mute)
  // ---------------------------------------------------------------------------
  findMemberMute(communityId: string, userId: string) {
    return prisma.communityMemberMute.findUnique({
      where: { communityId_userId: { communityId, userId } },
    });
  },

  /**
   * Like `findMemberMute` but returns the row ONLY when the mute is still
   * effective (lazy expiration: `mutedUntil` null OR in the future) — matching
   * the expiry semantics of `listMutedMembers` (`mutedUntil IS NULL OR > now`).
   * Returns null for an expired mute (or no row). Indefinite mute is stored as
   * an explicit `null` (NOT an unset field), so a plain equality check is right.
   */
  async findActiveMemberMute(communityId: string, userId: string) {
    const row = await this.findMemberMute(communityId, userId);
    if (!row) return null;
    const now = new Date();
    if (row.mutedUntil === null || row.mutedUntil > now) return row;
    return null;
  },

  /**
   * Batch-fetch the caller's active MODERATION mutes across a set of communities
   * (e.g. the page returned by `listMine`). Returns a Map keyed by communityId;
   * only active rows (mutedUntil null OR in the future) are included. One indexed
   * query for the whole page — avoids N+1 in the mine list.
   */
  async findCallerMutesByCommunityIds(
    userId: string,
    communityIds: string[]
  ): Promise<Map<string, { mutedUntil: Date | null }>> {
    if (communityIds.length === 0)
      return new Map<string, { mutedUntil: Date | null }>();
    const now = new Date();
    const rows = await prisma.communityMemberMute.findMany({
      where: {
        userId,
        communityId: { in: communityIds },
        OR: [{ mutedUntil: null }, { mutedUntil: { gt: now } }],
      },
      select: { communityId: true, mutedUntil: true },
    });
    return new Map(
      rows.map((r) => [r.communityId, { mutedUntil: r.mutedUntil }])
    );
  },

  /** Batch-fetch active mutes for a set of userIds in one community page. */
  async findActiveMemberMutesByUserIds(communityId: string, userIds: string[]) {
    if (userIds.length === 0)
      return new Map<
        string,
        { mutedBy: string; mutedUntil: Date | null; createdAt: Date }
      >();
    const now = new Date();
    const rows = await prisma.communityMemberMute.findMany({
      where: {
        communityId,
        userId: { in: userIds },
        OR: [{ mutedUntil: null }, { mutedUntil: { gt: now } }],
      },
      select: {
        userId: true,
        mutedBy: true,
        mutedUntil: true,
        createdAt: true,
      },
    });
    return new Map(rows.map((r) => [r.userId, r]));
  },

  /** Idempotent re-mute: updates mutedBy/reason/mutedUntil on conflict. */
  upsertMemberMute(data: {
    communityId: string;
    userId: string;
    mutedBy: string;
    reason: string | null;
    mutedUntil: Date | null;
  }) {
    return prisma.communityMemberMute.upsert({
      where: {
        communityId_userId: {
          communityId: data.communityId,
          userId: data.userId,
        },
      },
      create: data,
      update: {
        mutedBy: data.mutedBy,
        reason: data.reason,
        mutedUntil: data.mutedUntil,
      },
    });
  },

  deleteMemberMute(communityId: string, userId: string) {
    return prisma.communityMemberMute.delete({
      where: { communityId_userId: { communityId, userId } },
    });
  },

  /**
   * Currently-muted members for a community (lazy expiration: mutedUntil null OR
   * in the future). Offset/page pagination, newest mute first.
   */
  async listMutedMembers(params: {
    communityId: string;
    now: Date;
    page: number;
    limit: number;
  }) {
    const where: Prisma.CommunityMemberMuteWhereInput = {
      communityId: params.communityId,
      OR: [{ mutedUntil: null }, { mutedUntil: { gt: params.now } }],
    };

    const [rows, total] = await Promise.all([
      prisma.communityMemberMute.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityMemberMute.count({ where }),
    ]);
    return { rows, total };
  },

  /**
   * A batch of TIMED mutes whose `mutedUntil` has already passed — the work-list
   * for the auto-unmute sweeper. Indefinite mutes (`mutedUntil === null`) are
   * never returned (they only lift on a manual unmute). Oldest-expiry first so a
   * backlog drains deterministically.
   */
  findExpiredMemberMutes(params: { now: Date; limit: number }) {
    return prisma.communityMemberMute.findMany({
      where: { mutedUntil: { not: null, lte: params.now } },
      orderBy: { mutedUntil: "asc" },
      take: params.limit,
    });
  },

  /**
   * Atomically claims a single expired mute for the sweeper: deletes the row
   * ONLY if it still exists AND is still expired. Returns the number of rows
   * deleted (1 = this caller won the claim and should fire the unmute
   * side-effects; 0 = another instance/redelivery already handled it, or the
   * member was re-muted in the meantime). This is the exactly-once guarantee
   * that makes the per-minute sweep safe under multiple service instances.
   */
  async claimExpiredMemberMute(id: string, now: Date): Promise<number> {
    const res = await prisma.communityMemberMute.deleteMany({
      where: { id, mutedUntil: { not: null, lte: now } },
    });
    return res.count;
  },

  /**
   * Keyset page through ALL currently-active mutes across every community —
   * used once at startup to re-mirror existing mutes into chat-service after the
   * RoomMember mute fields were introduced (migration backfill). Ordered by id
   * so `afterId` gives a stable cursor.
   */
  listActiveMutesPage(params: { now: Date; afterId?: string; limit: number }) {
    return prisma.communityMemberMute.findMany({
      where: {
        AND: [
          { OR: [{ mutedUntil: null }, { mutedUntil: { gt: params.now } }] },
          ...(params.afterId ? [{ id: { gt: params.afterId } }] : []),
        ],
      },
      orderBy: { id: "asc" },
      take: params.limit,
    });
  },

  // ---------------------------------------------------------------------------
  // Member warnings
  // ---------------------------------------------------------------------------
  createMemberWarning(data: {
    communityId: string;
    userId: string;
    warnedBy: string;
    note: string;
  }) {
    return prisma.communityMemberWarning.create({ data });
  },

  /** Warnings for a member, newest first. Offset/page pagination. */
  async listMemberWarnings(params: {
    communityId: string;
    userId: string;
    page: number;
    limit: number;
  }) {
    const where = {
      communityId: params.communityId,
      userId: params.userId,
    };

    const [rows, total] = await Promise.all([
      prisma.communityMemberWarning.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityMemberWarning.count({ where }),
    ]);
    return { rows, total };
  },

  // ---------------------------------------------------------------------------
  // Invite links (shareable join links — distinct from 1:1 invites)
  // ---------------------------------------------------------------------------
  createInviteLink(data: {
    code: string;
    communityId: string;
    createdBy: string;
    maxUses: number | null;
    autoApprove: boolean;
    expiresAt: Date | null;
  }) {
    return prisma.communityInviteLink.create({ data });
  },

  findInviteLinkById(linkId: string) {
    return prisma.communityInviteLink.findUnique({ where: { id: linkId } });
  },

  /**
   * Count a member's currently-ACTIVE invite links in a community: not revoked
   * and not past their expiry. Exhausted links (usedCount >= maxUses) are NOT
   * filtered out here — that requires a field-to-field comparison Mongo can't do
   * in a `count` predicate — so the cap is a slight over-count, which is the safe
   * direction for an abuse guard.
   */
  countActiveInviteLinksByCreator(communityId: string, createdBy: string) {
    const now = new Date();
    return prisma.communityInviteLink.count({
      where: {
        communityId,
        createdBy,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
  },

  findInviteLinkByCode(code: string) {
    return prisma.communityInviteLink.findUnique({ where: { code } });
  },

  /**
   * Look up a community by its permanent invitation code.
   * Uses `findFirst` (not `findUnique`) because `invitationCode` is not declared
   * `@unique` in the Prisma schema — uniqueness is enforced by the sparse index
   * created at startup. Returns null when no community owns this code.
   */
  findCommunityByInvitationCode(code: string) {
    return prisma.community.findFirst({ where: { invitationCode: code } });
  },

  /**
   * Atomically set the community's permanent invitation code IFF it has not been
   * set yet. Returns the number of documents updated: 1 means the code was written,
   * 0 means another concurrent request beat us (the field is already populated).
   * Callers should re-read the community after a 0 return to get the winning code.
   * No transaction needed: the `updateMany` filter is the atomic guard (standalone
   * Mongo, no $transaction available).
   *
   * IMPORTANT — the guard is `invitationCode: { isSet: false }`, NOT `: null`.
   * Prisma translates `{ invitationCode: null }` on MongoDB into
   * `$eq null AND $ne $$REMOVE`, which REQUIRES the field to exist — so it matches
   * ZERO documents that simply lack the field (every legacy community, and every
   * freshly-created one, since Prisma omits unset optional fields on insert).
   * `{ isSet: false }` is the correct "field absent" guard (the same idiom used
   * for `deletedAt` elsewhere in this repository). After the first write the field
   * is set, so concurrent callers match 0 and fall back to re-reading the winner.
   */
  setInvitationCodeOnce(communityId: string, code: string) {
    return prisma.community.updateMany({
      where: { id: communityId, invitationCode: { isSet: false } },
      data: { invitationCode: code, invitationCodeCreatedAt: new Date() },
    });
  },

  async listInviteLinks(params: {
    communityId: string;
    status?: "active" | "expired" | "revoked";
    page: number;
    limit: number;
  }) {
    const now = new Date();
    const where: Prisma.CommunityInviteLinkWhereInput = {
      communityId: params.communityId,
    };
    if (params.status === "revoked") {
      where.revokedAt = { not: null };
    } else if (params.status === "expired") {
      where.revokedAt = null;
      where.expiresAt = { lt: now };
    } else if (params.status === "active") {
      where.revokedAt = null;
      where.OR = [{ expiresAt: null }, { expiresAt: { gt: now } }];
    }
    const [rows, total] = await Promise.all([
      prisma.communityInviteLink.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityInviteLink.count({ where }),
    ]);
    return { rows, total };
  },

  updateInviteLink(
    linkId: string,
    data: Prisma.CommunityInviteLinkUpdateInput
  ) {
    return prisma.communityInviteLink.update({
      where: { id: linkId },
      data,
    });
  },

  /**
   * Capacity-guarded increment via optimistic concurrency: load → check →
   * conditional update on the observed `usedCount`. Prisma's field-to-field
   * comparison (`fields.maxUses`) in Mongo `updateMany` is unreliable, so we
   * snapshot the count, then `updateMany` filtered by that exact value — if
   * another redeemer beat us, `count` is 0 and we retry up to 3 times. This
   * avoids `$transaction` (unavailable on standalone Mongo).
   */
  async incrementInviteLinkUsageIfUnder(linkId: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const link = await prisma.communityInviteLink.findUnique({
        where: { id: linkId },
      });
      if (!link) return { count: 0 };
      if (link.maxUses !== null && link.usedCount >= link.maxUses) {
        return { count: 0 };
      }
      const result = await prisma.communityInviteLink.updateMany({
        where: { id: linkId, usedCount: link.usedCount },
        data: { usedCount: { increment: 1 } },
      });
      if (result.count === 1) return { count: 1 };
      // Concurrent redeemer beat us — loop and re-read.
    }
    return { count: 0 };
  },
};
